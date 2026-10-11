import type {ChildProcess} from 'node:child_process';
import {JsonLineRpc} from '../backend/adapters/common';
import {officialLoginUrl} from './login-output';

/** Official account login only. Never creates a thread or sends a prompt. */
export async function codexBrowserLogin(child:ChildProcess,open:(url:string)=>void,timeoutMs=10*60_000){
  const rpc=new JsonLineRpc(child);let loginId:string|undefined,notification:any;
  let finish:(value:any)=>void=()=>{},fail:(error:Error)=>void=()=>{};
  const completed=new Promise<any>((resolve,reject)=>{finish=resolve;fail=reject;});
  const accept=(value:any)=>{notification=value;if(loginId&&value?.loginId===loginId)finish(value);};
  rpc.onNotification=(method,value)=>{if(method==='account/login/completed')accept(value);};
  rpc.onClose=fail;
  const timer=setTimeout(()=>fail(new Error('官方登录等待超时，请重新发起。')),timeoutMs);
  const observed=completed.catch(error=>{throw error;});observed.catch(()=>{});
  try{
    await rpc.request('initialize',{clientInfo:{name:'airoom',title:'AIROOM',version:'0.1.0'},capabilities:{experimentalApi:true}});rpc.notify('initialized');
    const login=await rpc.request('account/login/start',{type:'chatgpt'});
    const url=officialLoginUrl('codex',login?.authUrl);if(login?.type!=='chatgpt'||typeof login.loginId!=='string'||!url)throw new Error('Codex 没有提供有效的官方授权页面。');
    loginId=login.loginId;if(notification)accept(notification);open(url);
    const result=await observed;if(result?.success!==true)throw new Error('Codex 官方授权没有完成，请重新登录。');
  }finally{clearTimeout(timer);rpc.close();child.stdin?.end();}
}
