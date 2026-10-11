import '../../scripts/test-bootstrap.mjs';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Engine} from '../../src/backend/engine';
import type {Adapter,AdapterContext,ProviderId} from '../../src/shared/types';
import {plan} from './project-flow-harness';

export async function until(check:()=>boolean){const end=Date.now()+8000;while(!check()){if(Date.now()>end)throw Error('meeting controls did not settle');await new Promise(r=>setTimeout(r,10));}}
interface Call{ctx:AdapterContext;input:any;kind:string;prompt:string;stopped:boolean;release:()=>void}
export async function meetingHarness(handler?:(call:Call,index:number)=>unknown|Promise<unknown>,push?:(s:any)=>void){
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM-meeting-controls-')),data=path.join(root,'data'),directory=path.join(root,'project');await mkdir(directory);const calls:Call[]=[];
  const factory=(id:ProviderId):Adapter=>{let current:Call|undefined;return {probe:async()=>({id,name:id,available:true,auth:id==='dsh'?'account':'subscription',detail:'meeting fixture',capabilities:{steer:false,cancel:'native',streaming:true,write:true,history:true}}),stop:async()=>{if(current){current.stopped=true;current.release();}},start:async(ctx,prompt)=>{
    ctx.markDelivery('confirmed');const kind=prompt.match(/"kind":"([^"]+)"/)?.[1]??'',input=prompt.includes('\nAIROOM_CONTEXT\n')?JSON.parse(prompt.split('\nAIROOM_CONTEXT\n')[1]):kind?JSON.parse(prompt.split('\n任务材料：')[1]):{},call:Call={ctx,input,kind,prompt,stopped:false,release:()=>{}};current=call;calls.push(call);let reply=await handler?.(call,calls.length-1);if(call.stopped)return {stopped:true};
    if(reply===undefined){if(kind==='plan'){const p=plan();p.tasks=p.tasks.slice(0,1);reply=p;}else if(ctx.session.purpose==='room-hand')reply={want:1,why:'有具体补充'};else if(ctx.session.purpose==='room-minutes')reply={version:1,turn:input.turn,revision:input.revision,action:'speak',body:'结论和分歧依实际记录保留。'};else if(prompt.includes('AIROOM_CONTEXT'))reply={version:1,turn:input.turn,revision:input.revision,action:input.phase==='closing'?'accept':'speak',body:input.phase==='closing'?'':'按顺序回答 '+(ctx.session.memberId??ctx.session.provider),...(input.phase==='closing'?{proposalId:input.proposal.id}:{answers:input.questions?.filter((q:any)=>q.to===(ctx.session.memberId??ctx.session.provider)).map((q:any)=>q.id)??[]})};else reply='实际回答';}
    ctx.emit('delta',kind?JSON.stringify({protocol:'airoom.project-flow',version:1,kind,payload:reply}):typeof reply==='string'?reply:JSON.stringify(reply));return {};
  }};};
  const engine=new Engine(data,e=>{if(e.type==='snapshot')push?.(e.snapshot);},()=>{},factory);await engine.probe();await engine.invoke('settings.save',{...engine.snapshot().settings,maxParallel:6});
  const start=(roomId='global',extra:Record<string,unknown>={})=>engine.invoke('room.send',{roomId,mode:'discuss',style:'work',text:'逐位回答',memberIds:['dsh','codex','claude'],maxCalls:0,maxMinutes:0,handRaise:true,hostPick:true,...extra});
  const speech=()=>calls.filter(c=>c.prompt.includes('\nAIROOM_CONTEXT\n')&&!['room-hand','room-minutes'].includes(c.ctx.session.purpose??''));
  return {engine,root,data,directory,calls,start,speech,dispose:async()=>{for(const c of calls)c.release();await engine.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}};
}

