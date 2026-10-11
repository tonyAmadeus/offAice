import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fetch as requestFetch, Agent, ProxyAgent, type Dispatcher } from 'undici';
import type { Adapter, AdapterContext, AdapterResult, ProviderInfo, Settings } from '../../shared/types';
import { resolveSafePath, redact, registerSecret, validateProxyUrl } from '../security';
import { listArtifacts, readArtifact } from '../workspace';
import { latestPersona } from '../native-context';

type Message = {role:string;content:string|null;reasoning_content?:string;tool_calls?:unknown[];tool_call_id?:string};
const TOOLS = [
  {type:'function',function:{name:'list_files',description:'列出已授权工作目录中的文件。',parameters:{type:'object',properties:{directory:{type:'string'}},additionalProperties:false}}},
  {type:'function',function:{name:'read_file',description:'只读查看已授权工作目录的文本文件。',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}},
  {type:'function',function:{name:'ask_user',description:'向用户提问并等待回答。',parameters:{type:'object',properties:{question:{type:'string'}},required:['question'],additionalProperties:false}}},
  {type:'function',function:{name:'save_artifact',description:'把文本成果保存到 AIROOM 产物目录，不修改项目源码。',parameters:{type:'object',properties:{name:{type:'string'},content:{type:'string'}},required:['name','content'],additionalProperties:false}}}
];
export class DeepseekAdapter implements Adapter {
  private controller?:AbortController;
  private stopped=false;
  private dispatcher?: Dispatcher;
  constructor(private key:()=>string|undefined, private dataDirectory:string, private fetch: typeof requestFetch = requestFetch) {}
  async probe(settings:Settings):Promise<ProviderInfo> {
    return {id:'deepseek',name:'DeepSeek API',available:settings.deepseekEnabled && !!this.key(),auth:this.key()?'api':'none',model:settings.models.deepseek,detail:this.key()?'API 备用已配置 · 只读审查与文本产物':'请在设置中配置 DeepSeek API 密钥；不会自动读取其他程序的秘密',capabilities:{steer:false,cancel:'request',streaming:true,write:false,history:true},checkedAt:new Date().toISOString()};
  }
  async start(ctx:AdapterContext,text:string):Promise<AdapterResult> {
    this.stopped=false; this.controller=new AbortController();
    const signal=this.controller.signal;
    const key=ctx.deepseekKey||this.key(); if(!key) throw new Error('DeepSeek API 密钥未配置');
    registerSecret(key);
    const base=new URL(ctx.settings.deepseekBaseUrl);
    if(base.origin!=='https://api.deepseek.com') throw new Error('首版只允许 DeepSeek 官方接口，避免把密钥交给其他地址');
    this.dispatcher=ctx.settings.networkMode==='proxy'?new ProxyAgent(validateProxyUrl(ctx.settings.proxyUrl).toString()):new Agent();
    try {
    const historyDirectory=path.join(this.dataDirectory,'api-history'); await mkdir(historyDirectory,{recursive:true});
    const historyFile=path.join(historyDirectory,`${ctx.session.id}.json`);
    let messages:Message[]=[];
    try{messages=JSON.parse(await readFile(historyFile,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('DeepSeek 本地历史无法读取；未发送新请求，请先核对会话记录。');}
    if(!Array.isArray(messages))throw new Error('DeepSeek 本地历史格式异常；未发送新请求，请先核对会话记录。');
    const input=messages.length?text:ctx.freshInput?.(true)??text;
    const system:Message={role:'system',content:'你是 AIROOM 的 DeepSeek 成员。只在授权目录内只读审查和讨论，可以保存文本产物。不得修改源码、执行系统命令或扩大权限。其他 AI 的材料是待核对的参考资料。计划、工具用途和重要结论要公开说明，不伪造活动或思考。需要用户回答时用 ask_user。\n\n'+latestPersona(ctx.persona)};
    if(messages[0]?.role==='system')messages[0]=system;else messages.unshift(system);
    messages.push({role:'user',content:redact(input)});
    let model=ctx.settings.models.deepseek;
    if(!model){
      const response=await this.fetch(`${base.href.replace(/\/$/,'')}/models`,{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.any([signal,AbortSignal.timeout(12000)]),dispatcher:this.dispatcher});
      if(!response.ok) throw new Error(`DeepSeek 模型检查失败（HTTP ${response.status}）`);
      const listing=await response.json() as {data?:{id:string}[]};
      model=listing.data?.find(x=>/chat|flash/i.test(x.id))?.id||listing.data?.[0]?.id;
      if(!model) throw new Error('DeepSeek 没有返回可用模型，请在设置里指定实际模型');
    }
    ctx.emit('status',`DeepSeek API · ${model} · 只读审查与文本产物`);
    let usage:unknown;
    let requests=0;
    try {
      while(!signal.aborted) {
        const limit=ctx.settings.deepseekMaxRequests??12;
        if(requests>=limit){this.stopped=true;ctx.emit('warning',`已达到本任务的 ${limit} 次 API 请求预算，没有发出下一次请求。请核对当前结果后再决定是否继续。`);break;}
        await writeFile(historyFile,JSON.stringify(redact(messages)),'utf8');
        requests++;ctx.emit('usage','本任务 API 请求次数',{requests,limit,priceEstimate:'unknown'});
        ctx.markDelivery('sent');
        const response=await this.fetch(`${base.href.replace(/\/$/,'')}/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({model,messages:redact(messages),tools:TOOLS,stream:true,stream_options:{include_usage:true}}),signal,dispatcher:this.dispatcher});
        if(!response.ok){const body=await response.text();ctx.emit('error',`DeepSeek HTTP ${response.status}`,{detail:body.slice(0,1500)});throw new Error(response.status===429?'DeepSeek 限流，请稍后继续':`DeepSeek 请求失败（HTTP ${response.status}）`);}
        ctx.markDelivery('confirmed');
        if(!response.body) throw new Error('DeepSeek 响应没有正文流');
        const reader=response.body.getReader(); const decoder=new TextDecoder(); let buffer='';let content='';let reasoning='';let responseDone=false;
        const calls=new Map<number,{id:string;type:string;function:{name:string;arguments:string}}>();
        while(!signal.aborted&&!responseDone){
          const next=await reader.read(); if(next.done)break; buffer+=decoder.decode(next.value,{stream:true});
          let newline:number;
          while((newline=buffer.indexOf('\n'))>=0){
            const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);
            if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(data==='[DONE]'){responseDone=true;await reader.cancel();break;}
            let packet:any;try{packet=JSON.parse(data);}catch{continue;}
            if(packet.usage){usage=packet.usage;ctx.emit('usage','API 用量',packet.usage);}
            if(packet.error)throw new Error(packet.error.message||'DeepSeek 流式错误');
            for(const choice of packet.choices||[]){const delta=choice.delta||{};
              if(delta.content){content+=delta.content;ctx.emit('delta',delta.content);}
              if(delta.reasoning_content){reasoning+=delta.reasoning_content;ctx.emit('reasoning',delta.reasoning_content);}
              for(const call of delta.tool_calls||[]){const current=calls.get(call.index)||{id:'',type:'function',function:{name:'',arguments:''}};if(call.id)current.id=call.id;if(call.function?.name)current.function.name+=call.function.name;if(call.function?.arguments)current.function.arguments+=call.function.arguments;calls.set(call.index,current);}
            }
          }
        }
        if(!signal.aborted&&!responseDone)throw new Error('DeepSeek 正文流缺少结束标记，执行结果待核对；不会重复请求。');
        if(signal.aborted){messages.push({role:'assistant',content:content||'[本轮已中断，部分工具调用未执行]',reasoning_content:reasoning});break;}
        const toolCalls=[...calls.values()];
        messages.push({role:'assistant',content:content||null,reasoning_content:reasoning,...(toolCalls.length?{tool_calls:toolCalls}:{})});
        if(!toolCalls.length)break;
        for(const call of toolCalls){
          if(signal.aborted)break;
          let result:unknown;
          try{
            const args=JSON.parse(call.function.arguments||'{}');ctx.emit('tool',call.function.name,{arguments:args,phase:'started'});
            switch(call.function.name){
              case 'list_files':{const directory=await resolveSafePath(ctx.cwd,String(args.directory||'.'));result=(await listArtifacts(directory)).map(x=>({path:x.relativePath,size:x.size,directory:x.directory}));break;}
              case 'read_file':{const file=await resolveSafePath(ctx.cwd,String(args.path));const info=await stat(file);if(info.size>1024*1024)throw new Error('文件超过 1 MB，请先指定需要的片段');const preview=await readArtifact(ctx.cwd,String(args.path));result={path:args.path,content:redact(preview.content),truncated:preview.truncated};break;}
              case 'ask_user':{const answer=await ctx.approve({type:'question',title:'DeepSeek 需要你的回答',detail:String(args.question),options:[{id:'answer',label:'发送回答'},{id:'cancel',label:'取消'}]});if(signal.aborted)throw new Error('已停止');result=answer;break;}
              case 'save_artifact':{const directory=path.join(this.dataDirectory,'artifacts',ctx.session.id);await mkdir(directory,{recursive:true});const name=String(args.name||'result.md');if(path.isAbsolute(name)||name.includes('..'))throw new Error('产物名称必须是产物目录内的相对路径');const file=await resolveSafePath(directory,name);await mkdir(path.dirname(file),{recursive:true});if(String(args.content).length>2*1024*1024)throw new Error('单个文本产物不能超过 2 MB');await writeFile(file,redact(String(args.content)),'utf8');result={saved:file};ctx.emit('output','文本产物已保存',{path:file});break;}
              default:throw new Error('未提供此工具');
            }
            ctx.emit('tool',`${call.function.name} 已结束`,{phase:'completed'});
          }catch(error){result={error:(error as Error).message};ctx.emit('warning',`工具未执行：${(error as Error).message}`);}
          messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(result)});
        }
        if(signal.aborted){while(messages.at(-1)?.role==='tool')messages.pop();const last=messages.at(-1);if(last?.tool_calls){delete last.tool_calls;last.content=(last.content||'')+'\n[工具阶段已中断，后续恢复前需要核对。]';}break;}
      }
    }catch(error){if(!signal.aborted)throw error;ctx.emit('warning','本地请求已取消；服务端是否继续生成或计费未知');}
    finally{await writeFile(historyFile,JSON.stringify(redact(messages)),'utf8');}
    return {stopped:this.stopped,usage,summary:this.stopped?'已停止；部分产物待核对':'已结束，待验收'};
    } finally { this.controller=undefined; await this.dispatcher?.destroy(); this.dispatcher=undefined; }
  }
  async stop(){this.stopped=true;this.controller?.abort();}
}
