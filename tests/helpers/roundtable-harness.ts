import '../../scripts/test-bootstrap.mjs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Engine} from '../../src/backend/engine';
import type {Adapter,AdapterContext,AdapterResult,ProviderId,PushEvent} from '../../src/shared/types';
import type {RoundtableDetail} from '../../src/shared/roundtable';
import {opinion,summary} from './joint-review-harness';
import {plan} from './project-flow-harness';

export interface RoundtableCall {ctx:AdapterContext;prompt:string;kind:string;material:any;stopped:boolean;release:()=>void}
export async function roundtableHarness(options:{handler?:(call:RoundtableCall)=>Promise<unknown>;push?:(snapshot:any)=>void;onEvent?:(event:PushEvent)=>void;manualDelivery?:boolean}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM-roundtable-')),data=path.join(root,'data'),original=path.join(root,'original');await mkdir(original);await writeFile(path.join(original,'brief.md'),'原材料：活动文案。');
  const calls:RoundtableCall[]=[];let closeMeeting=true;
  const factory=(id:ProviderId):Adapter=>{let current:RoundtableCall|undefined;return {probe:async()=>({id,name:id,available:true,auth:id==='dsh'?'account':'subscription',detail:'isolated roundtable fixture',capabilities:{steer:false,cancel:'native',streaming:true,write:true,history:true,images:id!=='dsh'}}),stop:async()=>{if(current){current.stopped=true;current.release();}},start:async(ctx,prompt)=>{
    if(!options.manualDelivery)ctx.markDelivery('confirmed');const kind=prompt.match(/"kind":"([^"]+)"/)?.[1]??'',material=kind?JSON.parse((prompt.split('\n任务材料：')[1]??'{}').split('\n')[0]):prompt.includes('\nAIROOM_CONTEXT\n')?JSON.parse(prompt.split('\nAIROOM_CONTEXT\n')[1].split('\n')[0]):{};const call={ctx,prompt,kind,material,stopped:false,release:()=>{}};current=call;calls.push(call);
    let result=await options.handler?.(call);
    if(result===undefined){
      if(kind==='joint-independent'){if(ctx.session.writeMode&&material.deliverablePath){await mkdir(path.dirname(path.join(ctx.cwd,material.deliverablePath)),{recursive:true});await writeFile(path.join(ctx.cwd,material.deliverablePath),'独立稿件-'+(ctx.session.memberId??ctx.session.provider));}result=opinion((ctx.session.memberId??ctx.session.provider),typeof material.subject==='string');}
      else if(kind==='joint-peer')result=opinion((ctx.session.memberId??ctx.session.provider),false);
      else if(kind==='joint-summary'){if(ctx.session.writeMode&&material.deliverablePath)await writeFile(path.join(ctx.cwd,material.deliverablePath),'综合稿');result=summary(material);}
      else if(kind==='author-response')result={responses:material.findings.map((f:any)=>({findingId:f.id,stance:'agree',reason:'保留问题',evidence:''}))};
      else if(kind==='verification')result={findingIds:material.findingIds,outcome:'inconclusive',summary:'仍待核实',evidence:[]};
      else if(kind==='plan')result=plan();
      else if(kind==='task-addition')result={completionCriteria:[{text:'文案满足已确认要求',kind:'judge'}],allowedPaths:['a.txt'],inScope:true,scopeReason:'现有文案任务'};
      else if(ctx.session.purpose==='room-hand')result={want:1,why:'需要解释独立意见'};
      else if(ctx.session.purpose==='room-minutes')result={version:1,turn:material.turn,revision:material.revision,action:'speak',body:'## 共识\n保存独立候选。\n## 分歧与各方理由\n各版措辞不同，按用户偏好选择。\n## 少数意见\n仍保留每人的原意见。\n## 未核实事项\n实际读者偏好尚未调查。\n## 建议\n选稿后确认后续方案。'};
      else result={version:1,turn:material.turn,revision:material.revision,...(material.phase==='closing'?{action:'accept',body:'',proposalId:material.proposal.id}:closeMeeting&&material.canPropose&&calls.filter(c=>!c.kind&&c.ctx.session.roomId===ctx.session.roomId&&c.ctx.session.purpose!=='room-hand'&&c.ctx.session.purpose!=='room-minutes').length>3?{action:'propose',body:'已核对候选与待决定事项，可以结束本轮审议。'}:{action:'speak',body:'回应实际独立意见，仍保留未核实事项。'})};
    }
    if(result&&typeof result==='object'&&'nativeResult' in result)return (result as {nativeResult:AdapterResult}).nativeResult;
    if(call.stopped)return {stopped:true};
    ctx.emit('delta',kind?JSON.stringify({protocol:'airoom.project-flow',version:1,kind,payload:result}):JSON.stringify(result));return {};
  }};};
  const engine=new Engine(data,e=>{options.onEvent?.(e);if(e.type==='snapshot')options.push?.(e.snapshot);},()=>{},factory);await engine.probe();
  const open=(p:Record<string,unknown>={})=>engine.invoke('roundtable.open',{requestId:crypto.randomUUID(),kind:'candidates',title:'文案圆桌',material:{text:'为同一份活动文案提供候选，保留原版'},memberIds:['codex','claude','dsh'],synthesizerId:'codex',peerReview:true,...p}) as Promise<RoundtableDetail>;
  const get=(id:string)=>engine.invoke('roundtable.get',{topicId:id}) as Promise<RoundtableDetail>;
  const wait=async(id:string,predicate:(d:RoundtableDetail)=>boolean)=>{const deadline=Date.now()+15000;let d=await get(id);while(!predicate(d)){if(Date.now()>deadline)throw Error('roundtable timeout '+JSON.stringify(d));await new Promise(r=>setTimeout(r,15));d=await get(id);}return d;};
  const act=async(id:string,method:string,p:Record<string,unknown>={})=>{const d=await get(id);return engine.invoke('roundtable.'+method,{requestId:crypto.randomUUID(),topicId:id,expectedRevision:d.topic.revision,...p});};
  const choose=async(id:string)=>{const d=await wait(id,d=>d.review?.review.status==='awaiting_decision'),decision=d.review!.decisions.find(d=>d.kind==='candidate'&&d.status==='open')!;return act(id,'decide',{decisionId:decision.id,choice:'select',slotId:decision.candidateSlotIds[1]??decision.candidateSlotIds[0],opinion:'用户选择不同于汇总推荐的候选'});};
  const minutes=async(id:string)=>{const detail=await wait(id,d=>['waiting_user','awaiting-host'].includes(engine.store.roomState(d.topic.roomId).discussion?.phase??'')&&!engine.store.roomState(d.topic.roomId).active);const discussion=engine.store.roomState(detail.topic.roomId).discussion!;await engine.invoke('room.minutes',{roomId:detail.topic.roomId,discussionId:discussion.id,revision:discussion.revision});return wait(id,d=>d.topic.status==='conclusion');};
  const confirm=async(id:string)=>{await choose(id);const d=await minutes(id);await act(id,'confirm',{conclusionId:d.topic.conclusion!.id});return get(id);};
  return {engine,root,data,original,calls,factory,open,get,wait,act,choose,minutes,confirm,setClose:(value:boolean)=>{closeMeeting=value;},dispose:async()=>{for(const call of calls)call.release();await engine.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}};
}
