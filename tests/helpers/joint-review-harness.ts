import '../../scripts/test-bootstrap.mjs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Engine} from './seeded-engine';
import type {Adapter,AdapterContext,AdapterResult,Project,Run} from '../../src/shared/types';
import type {JointReviewDetail} from '../../src/shared/joint-review';
import {plan} from './project-flow-harness';

export interface JointCall {ctx:AdapterContext;kind:string;material:any;correction:boolean;prompt:string}
export const opinion=(member='成员',proposal=true)=>({summary:member+' 的意见',...(proposal?{proposal:member+' 的候选正文'}:{}),findings:[],unverifiedItems:[],evidence:[]});
export const summary=(material:any)=>({summary:'综合结论',dispositions:(material.findings??[]).map((f:any)=>({findingId:f.id,action:'accept',reason:'依据实际意见'})),disagreements:[],verificationRequests:[],...(material.candidates?.length?{recommendedSlotId:material.candidates[0].slotId,synthesis:'综合候选'}:{})});
export async function jointHarness(options:{maxParallel?:number;handler?:(call:JointCall)=>Promise<unknown>;start?:false}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM joint-')),source=path.join(root,'source');await mkdir(source);await writeFile(path.join(source,'brief.md'),'需求原文');
  const calls:JointCall[]=[];let active=0,peak=0;
  const factory=(id:AdapterContext['run']['provider']):Adapter=>({probe:async()=>({id,name:id,available:true,auth:id==='dsh'?'account':'subscription',detail:'fake adapter',capabilities:{steer:false,cancel:'native',streaming:true,write:true,history:true}}),stop:async()=>{},start:async(ctx,prompt)=>{
    ctx.markDelivery('confirmed');active++;peak=Math.max(peak,active);const kind=prompt.match(/"kind":"([^"]+)"/)?.[1]??'',material=prompt.includes('\n任务材料：')?JSON.parse(prompt.split('\n任务材料：')[1]):{},call={ctx,kind,material,correction:prompt.includes('仅补正上轮 JSON 格式'),prompt};calls.push(call);
    try{let result=await options.handler?.(call);if(result===undefined){
      if(kind==='joint-independent'||kind==='joint-peer')result=opinion(ctx.session.memberId??ctx.session.provider,kind==='joint-independent'&&typeof material.subject==='string');
      else if(kind==='author-response')result={responses:material.findings.map((f:any)=>({findingId:f.id,stance:'agree',reason:'接受意见',evidence:''}))};
      else if(kind==='joint-summary')result=summary(material);
      else if(kind==='verification')result={findingIds:material.findingIds,outcome:'inconclusive',evidence:[],summary:'仍无法确认'};
      else if(kind==='plan')result=plan();
      else result='这是已完成的文字回答';
    }
    if(result&&typeof result==='object'&&'nativeResult' in result)return (result as {nativeResult:AdapterResult}).nativeResult;
    ctx.emit('delta',result&&typeof result==='object'&&'raw' in result?String((result as {raw:string}).raw):kind?JSON.stringify({protocol:'airoom.project-flow',version:1,kind,payload:result}):String(result));return {};
    }finally{active--;}
  }});
  const engine=new Engine(path.join(root,'data'),()=>{},()=>{},factory);await engine.probe();engine.settings.maxParallel=options.maxParallel??2;
  // Exercise the retained G5 service directly. The desktop API makes old project reviews readonly.
  const desktopInvoke=engine.invoke.bind(engine);engine.invoke=(method,params)=>method.startsWith('projectFlow.jointReview.')&&!['get','list','subjects','files','read','diff'].includes(method.split('.').at(-1)! )?(engine as any).projectFlow.invoke(method,params):desktopInvoke(method,params);
  const project=await engine.invoke('project.create',{directory:source}) as Project;await engine.invoke('project.update',{projectId:project.id,memberIds:['codex','claude','dsh']});
  const start=(extra:Record<string,unknown>={})=>engine.invoke('projectFlow.jointReview.start',{requestId:crypto.randomUUID(),projectId:project.id,kind:'proposal',subject:'为同一份文案提出方案',reviewerMemberIds:['codex','claude','dsh'],leadMemberId:'codex',...extra}) as Promise<{jointReviewId:string}>;
  const detail=(id:string)=>engine.invoke('projectFlow.jointReview.get',{projectId:project.id,jointReviewId:id}) as Promise<JointReviewDetail>;
  const wait=async(id:string,predicate:(s:JointReviewDetail)=>boolean)=>{const until=Date.now()+15000;let s=await detail(id);while(!predicate(s)){if(Date.now()>until)throw new Error('timeout '+JSON.stringify(s));await new Promise(r=>setTimeout(r,20));s=await detail(id);}return s;};
  const act=async(id:string,method:string,extra:Record<string,unknown>={})=>{const d=await detail(id);return engine.invoke('projectFlow.jointReview.'+method,{requestId:crypto.randomUUID(),projectId:project.id,jointReviewId:id,expectedRevision:d.review.revision,...extra});};
  const controller=(engine as any).projectFlow,blocked=new Set<string>(),quota100=new Set<string>();
  const nativeQuota={allows:controller.host.quotaAllows,at100:controller.host.quota100};
  controller.host.quotaAllows=(member:string)=>!blocked.has(member);controller.host.quota100=(member:string)=>quota100.has(member);
  const send=async(sessionId:string,text:string)=>{const r=await engine.send(sessionId,text),until=Date.now()+5000;if(!r.runId)throw new Error('run was not created');const id=r.runId;for(;;){const run=engine.store.get<Run>('runs',id)!;if(['ended','completed','unknown','failed','stopped'].includes(run.status)&&!(engine as any).active.has(run.id))return run;if(Date.now()>until)throw new Error('ordinary run timeout');await new Promise(r=>setTimeout(r,20));}};
  return {root,source,project,engine,factory,calls,nativeQuota,start,detail,wait,act,send,peak:()=>peak,kick:()=>controller.kick(),quota:(member:string,allows:boolean,at100=false)=>{allows?blocked.delete(member):blocked.add(member);at100?quota100.add(member):quota100.delete(member);controller.kick();},dispose:async()=>{await engine.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}};
}
