import type { ChildProcess } from 'node:child_process';
import { JsonLineRpc } from './common';
import { observeProtocol, compatibilityStep } from '../compatibility';
import { stopOwned } from '../process-supervisor';

/** Shared wire/lifecycle only. Permissions, filesystem checks and vendor events stay in adapters. */
export class AcpConnection extends JsonLineRpc {
  constructor(child:ChildProcess,private name:string,private stopped:()=>boolean,incoming:NonNullable<JsonLineRpc['onIncoming']>,response:NonNullable<JsonLineRpc['onResponse']>){
    super(child,true);
    this.onIncoming=incoming;this.onResponse=response;
    this.onMalformed=()=>{this.close(new Error(`${name} 标准输出出现非 ACP 协议内容，连接已关闭。`));child.stdin?.end();};
  }
  override request(method:string,params:unknown,timeout=30000):Promise<any>{
    if(this.stopped()&&method!=='session/close')return Promise.reject(new Error(`${this.name} 已停止，未发送后续请求。`));
    return super.request(method,params,timeout);
  }
  async initialize(timeout=60000){
    const result=await this.request('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false,session:{configOptions:{boolean:true}}},clientInfo:{name:'AIROOM',version:'0.1.0'}},timeout);
    if(result?.protocolVersion!==1)throw new Error(`${this.name} ACP 协议版本不匹配：${result?.protocolVersion??'未知'}，当前支持 1。`);
    observeProtocol(String(result.protocolVersion));return result;
  }
  cancel(sessionId:string){this.notify('session/cancel',{sessionId});}
}
export async function closeAcpProcess(child:ChildProcess|undefined){
  if(!child)return;
  await compatibilityStep('close',async()=>{
    child.stdin?.end();
    if(child.exitCode===null&&child.signalCode===null)await new Promise<void>(resolve=>{
      const closed=()=>{clearTimeout(timer);resolve();};
      const timer=setTimeout(()=>{child.removeListener('close',closed);resolve();},1500);
      child.once('close',closed);
    });
    if(child.exitCode===null&&child.signalCode===null)await stopOwned(child,1500);
  });
}
