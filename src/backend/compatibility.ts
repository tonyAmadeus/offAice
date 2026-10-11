import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ADAPTER_CONTRACT_VERSION, type CompatibilityReport, type ExecutorIdentity } from '../shared/compatibility';
import type { Settings, ProviderId } from '../shared/types';
import { redact } from './security';
import { nodeRuntimeInfo } from './node-runtime';

const context = new AsyncLocalStorage<{report: CompatibilityReport; expected?: ExecutorIdentity}>();
export function observeNodeRuntime(env:NodeJS.ProcessEnv){
  const report=context.getStore()?.report,source=env.AIROOM_NODE_SOURCE;
  if(report&&['bundled','local','portable'].includes(source??''))report.nodeRuntime={source:source as 'bundled'|'local'|'portable',version:env.AIROOM_NODE_VERSION??process.versions.node,available:true,...(source==='portable'?{detail:'DSH 原生加载器使用经过官方 SHA-256 校验的标准 Node.js。'}:{})};
}
export function newCompatibility(provider: ProviderId, trigger: CompatibilityReport['trigger'], settings: Settings): CompatibilityReport {
  let proxyHost: string | undefined;
  if(settings.networkMode!=='tun')try{proxyHost=new URL(settings.proxyUrl).hostname;}catch{}
  return {id:randomUUID(),provider,trigger,startedAt:new Date().toISOString(),outcome:'running',
    identity:{adapterVersion:ADAPTER_CONTRACT_VERSION,protocol:provider==='codex'?'codex-app-server':provider==='claude'?'claude-native':provider==='deepseek'?'http':'acp'},
    stages:[],configuration:{model:settings.models[provider],effort:settings.efforts[provider]},network:{mode:settings.networkMode,proxyHost,tunVerified:false},nodeRuntime:nodeRuntimeInfo(settings)};
}
export function withCompatibility<T>(report: CompatibilityReport, action:()=>Promise<T>, expected?:ExecutorIdentity) {
  return context.run({report,expected},action);
}
export function currentIdentity(){const value=context.getStore()?.report.identity;return value?.path?{...value}:undefined;}
export function observeAccount(account:string){const scope=context.getStore();if(scope)scope.report.account=account;}
export function observeVersion(version:string){
  const scope=context.getStore();if(!scope)return;
  const value=String(redact(version)).trim().slice(0,200),expected=scope.expected;
  scope.report.identity.version=value;scope.report.identity.versionSource='native';
  const normalized=(text:string)=>text.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0]??text;
  if(expected?.versionSource==='native'&&expected.version&&normalized(expected.version)!==normalized(value))throw new Error('原会话绑定的原生执行端版本已改变，恢复已停止。');
}
export function observeArguments(args:string[]){
  const scope=context.getStore();if(!scope)return;
  const digest=createHash('sha256').update(JSON.stringify(args)).digest('hex');scope.report.identity.argumentsDigest=digest;
  if(scope.expected?.argumentsDigest&&scope.expected.argumentsDigest!==digest)throw new Error('原会话的启动参数已改变，恢复已停止；请恢复原配置或明确新建会话。');
}
export function compatibilitySync<T>(stage:string,action:()=>T):T{
  const scope=context.getStore(),start=Date.now();let error:unknown;
  try{return action();}catch(cause){error=cause;throw cause;}finally{if(scope){scope.report.stages.push({stage,startedAt:new Date(start).toISOString(),durationMs:Date.now()-start,outcome:error?'failed':'passed',...(error?{error:String(redact((error as Error).message)).slice(0,2500)}:{})});if(scope.report.stages.length>100)scope.report.stages.shift();}}
}
export function observeProtocol(version: string){const scope=context.getStore();if(!scope)return;scope.report.identity.protocolVersion=version;if(scope.expected?.protocolVersion&&scope.expected.protocolVersion!==version)throw new Error('原会话协议版本不匹配，未新建上下文继续执行。');}
/** Read the same file identity used by probes and runs without starting the program. */
export function readProgramIdentity(file: string): Pick<ExecutorIdentity,'path'|'digest'|'version'|'versionSource'> {
  const resolved=realpathSync(file),bytes=readFileSync(resolved);
  let directory=path.dirname(resolved),version:string|undefined,packageBytes=Buffer.alloc(0);
  for(let i=0;i<5;i++){
    const manifest=path.join(directory,'package.json');
    if(existsSync(manifest)){packageBytes=readFileSync(manifest);try{version=JSON.parse(packageBytes.toString()).version;}catch{}break;}
    const parent=path.dirname(directory);if(parent===directory)break;directory=parent;
  }
  const digest=createHash('sha256').update(bytes).update(packageBytes).digest('hex');
  return {path:resolved,digest,...(version?{version,versionSource:'manifest' as const}:{})};
}
/** Observe the resolved entry before it is started; never infer a historical version from today's settings. */
export function observeProgram(file: string) {
  const scope=context.getStore();if(!scope)return;
  const {path:resolved,digest,version}=readProgramIdentity(file);
  const same=scope.report.identity.path===resolved&&scope.report.identity.digest===digest&&scope.report.identity.versionSource==='native';
  Object.assign(scope.report.identity,{path:resolved,digest,...(!same&&version?{version,versionSource:'manifest' as const}:{})});
  const expected=scope.expected;
  if(expected&&(path.resolve(expected.path??'')!==path.resolve(resolved!)||expected.digest!==digest||expected.adapterVersion!==ADAPTER_CONTRACT_VERSION))throw new Error('原会话绑定的执行端文件或适配器版本已改变，恢复已停止；请恢复原版本，或明确新建会话。');
}
export function stageFor(method: string) {
  if(method==='initialize')return 'initialize';
  if(/resume|load/.test(method))return 'session-load';
  if(/account|authenticate/.test(method))return 'account';
  if(/config|model/.test(method))return 'configuration';
  if(/cancel|interrupt/.test(method))return 'cancel';
  if(/close/.test(method))return 'close';
  if(/prompt|turn\/start/.test(method))return 'dispatch';
  if(/session\/new|thread\/start/.test(method))return 'session-new';
  return method;
}
export async function compatibilityStep<T>(stage:string,action:()=>Promise<T>,method?:string,timeoutMs?:number):Promise<T>{
  const scope=context.getStore();if(!scope)return action();
  const start=Date.now(),startedAt=new Date(start).toISOString();let error:unknown;
  try{return await action();}catch(cause){error=cause;throw cause;}finally{
    const entry={stage,method,startedAt,durationMs:Date.now()-start,timeoutMs,outcome:error?'failed' as const:'passed' as const,
      ...(error?{error:String(redact(error instanceof Error?error.message:String(error))).slice(0,2500),code:(error as {code?:number|string}).code}:{})};
    scope.report.stages.push(entry);if(scope.report.stages.length>100)scope.report.stages.splice(0,scope.report.stages.length-100);
  }
}
