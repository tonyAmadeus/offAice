import path from 'node:path';
import {readFile,mkdtemp,writeFile,rm,rmdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {ChildProcess} from 'node:child_process';
import type {ModelOption} from '../../shared/types';
import {JsonLineRpc,spawnCli,type CliCommand} from './common';
import {stopOwned} from '../process-supervisor';

type Selection={providerId:string;modelId:string;options?:{reasoningLevel?:string}};
type NativeOption={ref:Selection;label?:string;description?:string;disabledReason?:string;reasoning?:{levels?:{value:string}[];defaultLevel?:string}};
export type ZcodeModelState={sessionId:string;current?:Selection;options:NativeOption[]};

/** Model control only. Tasks still use the standalone CLI's own account authentication and tool policy. */
export class ZcodeModelSession {
  readonly child:ChildProcess;
  private rpc:JsonLineRpc;
  private sessionId?:string;
  private constructor(command:CliCommand,env:NodeJS.ProcessEnv,private cwd:string,private provider:string,onProcess?:(child:ChildProcess)=>void){
    this.child=spawnCli(command,['app-server'],{env,cwd});
    this.child.stderr?.resume();
    this.rpc=new JsonLineRpc(this.child);
    this.rpc.onMalformed=()=>this.rpc.close(new Error('ZCode 原生模型接口返回了无效协议数据；没有发送任务。'));
    this.rpc.onRequest=async message=>{
      if(message.method==='session/requestRuntimePreferences')return {nativeSearchEnhancementsEnabled:false,memoryEnabled:false,askUserQuestionAutoResolutionEnabled:true};
      throw new Error('模型检查不会执行工具或请求授权。');
    };
    onProcess?.(this.child);
  }
  static async open(command:CliCommand,env:NodeJS.ProcessEnv,cwd:string,provider:string,onProcess?:(child:ChildProcess)=>void){
    const file=env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE!;
    const builtin=JSON.parse(await readFile(file,'utf8'));
    if(!Number.isSafeInteger(builtin.revision))throw new Error('ZCode 官方模型清单缺少版本信息，请检查执行端更新。');
    const session=new ZcodeModelSession(command,env,cwd,provider,onProcess);
    try{
      // The desktop protocol needs an entitlement overlay; no token, API key or model request crosses this bridge.
      await session.rpc.request('provider/updateAccountConfig',{
        revision:`airoom-models:${provider}:${builtin.revision}`,
        basedOnZCodeBuiltinRevision:`zcode-builtin:${builtin.revision}:${createHash('sha256').update(path.resolve(file)).digest('hex')}`,
        providers:{[provider]:{access:{type:'zhipu-account',entitled:true}}},
        states:{[provider]:{availability:'available',entitled:true,current:true}},
      },15000);
      return session;
    }catch(error){await session.close();throw error;}
  }
  private state(value:any):ZcodeModelState{
    const id=value?.session?.sessionId,current=value?.settings?.model?.current;
    if(value?.protocol?.name!=='ZCode Protocol'||value.protocol.version!==1||typeof id!=='string'||!id||this.sessionId&&id!==this.sessionId)throw new Error('ZCode 未返回可核对的原生会话，未发送任务。');
    const options=Array.isArray(value.settings?.model?.available)?value.settings.model.available.filter((item:any)=>item?.ref?.providerId===this.provider&&typeof item.ref.modelId==='string'&&item.ref.modelId&&!item.disabledReason):[];
    return {sessionId:id,current,options};
  }
  async load(nativeId?:string,deferred=false):Promise<ZcodeModelState>{
    const value=nativeId
      ?await this.rpc.request('session/resume',{sessionId:nativeId,workspace:{workspacePath:this.cwd,workspaceKey:this.cwd}},15000)
      :await this.rpc.request('session/create',{workspace:{workspacePath:this.cwd,workspaceKey:this.cwd},persistence:deferred?'deferred':'immediate',titleGenerationEnabled:false},15000);
    const state=this.state(value);this.sessionId=state.sessionId;
    if(nativeId&&nativeId!==state.sessionId)throw new Error('ZCode 恢复了不同的会话，未发送任务。');
    return state;
  }
  async select(state:ZcodeModelState,model:string,effort?:string,verifyPersistence=true):Promise<Selection>{
    const option=state.options.find(item=>item.ref.modelId===model||`${item.ref.providerId}/${item.ref.modelId}`===model);
    if(!option)throw new Error('ZCode 所选模型不在当前账号套餐的原生清单中，请刷新模型选项。');
    const levels=option.reasoning?.levels?.map(item=>item.value).filter(value=>typeof value==='string'&&value)??[];
    if(effort&&!levels.includes(effort))throw new Error('ZCode 所选思考程度不受当前模型支持，请刷新选项。');
    const level=effort??option.reasoning?.defaultLevel;
    const selection:Selection={providerId:this.provider,modelId:option.ref.modelId,...(level?{options:{reasoningLevel:level}}:{})};
    // resume reads the persisted selection. An unchanged model/effort needs no setter
    // or second resume; every real request is still checked separately below the adapter.
    if(state.current?.providerId===selection.providerId&&state.current.modelId===selection.modelId&&state.current.options?.reasoningLevel===selection.options?.reasoningLevel)return selection;
    const updated=this.state(await this.rpc.request('session/setModel',{sessionId:state.sessionId,model:selection,persistAsWorkspaceLastUsed:false},15000));
    this.assertSelection(updated.current,selection);
    // The setter can acknowledge an in-memory change even when its persistence fails. Cold-read the same session.
    if(verifyPersistence){
      await this.rpc.request('session/close',{sessionId:state.sessionId},5000);
      const restored=await this.load(state.sessionId);
      this.assertSelection(restored.current,selection);
    }
    return selection;
  }
  private assertSelection(actual:Selection|undefined,expected:Selection){
    if(actual?.providerId!==expected.providerId||actual?.modelId!==expected.modelId||expected.options?.reasoningLevel&&actual.options?.reasoningLevel!==expected.options.reasoningLevel)throw new Error('ZCode 原生模型切换未通过读回核对，未发送任务。');
  }
  async close(){
    if(this.sessionId&&this.rpc.isOpen)await this.rpc.request('session/close',{sessionId:this.sessionId},1500).catch(()=>{});
    this.rpc.close();
    if(this.child.exitCode===null&&this.child.signalCode===null){
      const ended=new Promise<void>(resolve=>this.child.once('close',()=>resolve()));
      this.child.stdin?.end();
      let timer:NodeJS.Timeout|undefined;
      await Promise.race([ended,new Promise<void>(resolve=>{timer=setTimeout(resolve,1000);})]);
      clearTimeout(timer);
      if(this.child.exitCode===null&&this.child.signalCode===null)await stopOwned(this.child,1500);
    }
  }
}

/** New native sessions persist at their first prompt. Give that prompt a private native default, never a shared edit. */
export async function zcodeRunModelEnvironment(env:NodeJS.ProcessEnv,selection:Selection){
  const original=env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE!;
  const content=JSON.parse(await readFile(original,'utf8'));
  const directory=await mkdtemp(path.join(path.dirname(original),'.airoom-model-')),file=path.join(directory,'provider_config.json');
  const cleanup=async()=>{await rm(file,{force:true});await rmdir(directory);};
  try{
    await writeFile(file,JSON.stringify({...content,config:{...content.config,defaultModelSelection:selection}}),{mode:0o600,flag:'wx'});
    return {env:{...env,ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:file},cleanup};
  }catch(error){await cleanup().catch(()=>{});throw error;}
}

export function zcodeModelOptions(state:ZcodeModelState,defaultModel:string):ModelOption[]{
  return state.options.map(option=>{
    const efforts=option.reasoning?.levels?.map(item=>item.value).filter(value=>typeof value==='string'&&value)??[];
    return {id:option.ref.modelId,label:option.label||option.ref.modelId,description:option.description,aliases:[`${option.ref.providerId}/${option.ref.modelId}`],isDefault:option.ref.modelId===defaultModel,efforts,defaultEffort:option.reasoning?.defaultLevel,effortSource:efforts.length?'reported':'unsupported'};
  });
}

/** Keep only request provenance and one final result; streaming text never becomes a second visible reply. */
export class ZcodeTaskOutput {
  private buffer='';
  private bytes=0;
  invalid=false;
  result:any;
  readonly models:{sessionId:string;turnId:string;providerId:string;modelId:string;toolCount?:number}[]=[];
  readonly compactions:{sessionId:string;turnId:string}[]=[];
  constructor(private progress?:(event:{sessionId:string;turnId:string;kind:string})=>void){}
  feed(chunk:string){
    this.bytes+=Buffer.byteLength(chunk);if(this.bytes>64*1024*1024){this.invalid=true;return;}
    this.buffer+=chunk;
    if(this.buffer.length>16*1024*1024){this.invalid=true;return;}
    for(let end=this.buffer.indexOf('\n');end>=0;end=this.buffer.indexOf('\n')){
      const line=this.buffer.slice(0,end).trim();this.buffer=this.buffer.slice(end+1);if(line)this.line(line);
    }
  }
  finish(){if(this.buffer.trim())this.line(this.buffer.trim());this.buffer='';}
  private line(line:string){
    if(this.invalid)return;
    let value:any;try{value=JSON.parse(line);}catch{this.invalid=true;return;}
    if(this.result){this.invalid=true;return;}
    if(value?.type==='result'){this.result=value;return;}
    const payload=value?.payload;
    if(['compact_completed','compact_boundary','microcompact_boundary'].includes(value?.type)&&typeof value.sessionId==='string'&&typeof value.turnId==='string'){
      if(this.compactions.length>=10000){this.invalid=true;return;}
      this.compactions.push({sessionId:value.sessionId,turnId:value.turnId});
    }
    if(value?.type==='model.streaming'&&['text_delta','reasoning_delta'].includes(payload?.kind)&&typeof payload.delta==='string'&&payload.delta&&typeof value.sessionId==='string'&&typeof value.turnId==='string')this.progress?.({sessionId:value.sessionId,turnId:value.turnId,kind:payload.kind});
    if(value?.type==='session.updated'&&Number.isSafeInteger(payload?.messageCount)&&payload.messageCount>=0&&typeof payload.providerId==='string'&&payload.providerId.length<=200&&typeof payload.modelId==='string'&&payload.modelId.length<=200&&typeof value.sessionId==='string'&&typeof value.turnId==='string'){
      if(this.models.length>=10000){this.invalid=true;return;}
      this.models.push({sessionId:value.sessionId,turnId:value.turnId,providerId:payload.providerId,modelId:payload.modelId,...(Number.isSafeInteger(payload.toolCount)&&payload.toolCount>=0?{toolCount:payload.toolCount}:{})});
    }
  }
}
