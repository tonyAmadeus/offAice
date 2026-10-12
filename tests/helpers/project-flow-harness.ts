import '../../scripts/test-bootstrap.mjs';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Engine} from './seeded-engine';
import type {Adapter,AdapterContext,Project} from '../../src/shared/types';
import type {PlanPayload,ReviewPayload,ReviewLevel,ProjectFlowSnapshot,Decision} from '../../src/shared/project-flow';

export const plan=():PlanPayload=>({objective:'修改文件',scope:'a.txt 和 b.txt',deliverables:['两份文件'],acceptanceCriteria:['文件内容正确'],rounds:[{key:'r1',title:'第一轮',goal:'文件内容正确',requiresUserAcceptance:true}],tasks:[{key:'a',roundKey:'r1',title:'A',memberId:'claude',goal:'写 A',inputs:[],completionCriteria:['A 正确'],dependencies:[],allowedPaths:['a.txt']},{key:'b',roundKey:'r1',title:'B',memberId:'dsh',goal:'写 B',inputs:[],completionCriteria:['B 正确'],dependencies:[],allowedPaths:['b.txt']}]});
export const proof:ReviewPayload['evidence']=[{kind:'inspection',description:'读取文件',result:'已核对文件内容',eventIds:[],source:'reported'}];
export const passing=(criteria:string[]):ReviewPayload=>({verdict:'pass',verificationComplete:true,criteriaResults:criteria.map(criterion=>({criterion,verified:true,evidence:'读取对应文件并核对内容'})),findings:[],evidence:proof});
export const inconclusive=(criteria:string[]):ReviewPayload=>({...passing(criteria),verdict:'inconclusive',verificationComplete:false,criteriaResults:criteria.map(criterion=>({criterion,verified:false,evidence:'缺少验证依据'}))});
export const failed=(criteria:string[]):ReviewPayload=>({...passing(criteria),verdict:'changes_requested',findings:[{location:'a.txt',kind:'verified',severity:'blocking',evidence:'实际内容不符合目标',request:'修正 a.txt'}]});
export interface Call {ctx:AdapterContext;kind:string;material:any;correction:boolean}
export function withPreviousChecks(payload:unknown,material:any){
  if(!payload||typeof payload!=='object'||!(material.previousFindings?.length)||'previousFindingChecks' in payload)return payload;
  const result=payload as ReviewPayload;return {...result,previousFindingChecks:material.previousFindings.map((f:any)=>({findingId:f.id,resolved:!result.findings?.some(x=>x.previousFindingId===f.id||x.location===f.location&&x.request===f.request),evidence:'模拟成员在当前副本核对上次问题'}))};
}
export async function harness(options:{plan?:PlanPayload;level?:ReviewLevel;peer?:boolean;autoPreviousChecks?:boolean;handler?:(call:Call)=>Promise<unknown>}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM review-policy-')),source=path.join(root,'source');await mkdir(source);await writeFile(path.join(source,'a.txt'),'old-a');await writeFile(path.join(source,'b.txt'),'old-b');const calls:Call[]=[];
  const factory=(id:AdapterContext['run']['provider']):Adapter=>({probe:async()=>({id,name:id,available:true,auth:'subscription',detail:'fake adapter',capabilities:{steer:false,cancel:'native',streaming:true,write:true,history:true}}),stop:async()=>{},start:async(ctx,prompt)=>{
    ctx.markDelivery('confirmed');const kind=prompt.match(/"protocol":"airoom.project-flow","version":1,"kind":"([^"]+)"/)?.[1]??'',material=prompt.includes('\n任务材料：')?JSON.parse(prompt.split('\n任务材料：')[1]):{},call={ctx,kind,material,correction:prompt.includes('仅补正上轮 JSON 格式')};calls.push(call);let payload=await options.handler?.(call);
    if(payload===undefined){if(kind==='plan')payload=options.plan??plan();else if(kind==='submission'){const task=material.task;for(const file of task.allowedPaths.filter((file:string)=>file.endsWith('.txt')))await writeFile(path.join(ctx.cwd,file),'new-'+task.key);payload={summary:'完成 '+task.key,completionResults:passing(task.completionCriteria).criteriaResults,evidence:proof};}
      else if(['review','integration-check','peer-review','requested-check'].includes(kind))payload=passing(material.criteria??material.task.completionCriteria);
      else if(kind==='task-rearrange'){const task=material.task;payload={memberId:task.memberId==='claude'?'dsh':'claude',goal:task.goal,completionCriteria:task.completionCriteria,reason:'负责人换人处理当前任务'};}
      else if(kind==='round-report')payload={summary:'本轮汇总',completedTaskKeys:material.taskKeys,deliverables:['文件'],validationSummary:'依据实际检查记录',remainingIssues:[],nextRoundSummary:'下一轮',userDecisionNeeded:'请验收',meetingResponses:[]};
      else if(kind==='next-round')payload={mode:'as-planned',summary:'按原计划',taskAdjustments:[]};
      else if(kind==='adjudication')payload={rulings:material.disputes.map((d:any)=>({findingId:d.findingId,verdict:'uphold-author',reason:'模拟负责人核查异议成立'}))};}
    if(['review','integration-check','peer-review'].includes(kind)&&!call.correction&&options.autoPreviousChecks!==false)payload=withPreviousChecks(payload,material);
    ctx.emit('delta',JSON.stringify({protocol:'airoom.project-flow',version:1,kind,payload}));return {};
  }});
  const engine=new Engine(path.join(root,'data'),()=>{},()=>{},factory);await engine.probe();const project=await engine.invoke('project.create',{directory:source}) as Project;
  const quotaBlocked=new Set<string>(),controller=(engine as any).projectFlow;controller.host.quotaAllows=(member:string)=>!quotaBlocked.has(member);const quota=(member:string,available:boolean)=>{if(available)quotaBlocked.delete(member);else quotaBlocked.add(member);controller.kick();};
  const ageQuota=()=>{for(const wait of engine.store.list<any>('flow_quota_waits').filter(w=>w.status==='waiting'))engine.store.put('flow_quota_waits',wait.id,{...wait,startedAt:new Date(Date.now()-600_001).toISOString()});controller.kick();};
  const state=()=>engine.invoke('projectFlow.get',{projectId:project.id}) as Promise<ProjectFlowSnapshot>;
  const wait=async(predicate:(s:ProjectFlowSnapshot)=>boolean)=>{const until=Date.now()+20000;let s=await state();while(!predicate(s)){if(Date.now()>until)throw new Error('timeout '+JSON.stringify(s));await new Promise(r=>setTimeout(r,25));s=await state();}return s;};
  await engine.invoke('projectFlow.start',{requestId:'start',projectId:project.id,leadMemberId:'codex',memberIds:['codex','claude','dsh'],topic:'修改文件',reviewLevel:options.level??'high'});const draft=await wait(s=>s.plan?.status==='awaiting_confirmation');
  const confirm=(extra:Record<string,unknown>={})=>engine.invoke('projectFlow.plan.confirm',{requestId:'confirm',planId:draft.plan!.id,expectedRevision:draft.plan!.revision,requiresPeerReviewByRound:options.peer?Object.fromEntries(draft.plan!.rounds.map(r=>[r.key,true])):undefined,...extra});
  const answer=async(decision:Decision,choice:string,extra:Record<string,unknown>={})=>{await wait(s=>Boolean(s.decisions.find(d=>d.id===decision.id)?.allowedActions?.[0]?.enabled));const latest=(await state()).decisions.find(d=>d.id===decision.id)!;return engine.invoke('projectFlow.decision.answer',{requestId:crypto.randomUUID(),decisionId:latest.id,expectedRevision:latest.revision,choice,...extra});};
  const accept=async()=>{const s=await wait(s=>s.rounds.some(r=>r.allowedActions?.find(a=>a.name==='projectFlow.round.accept')?.enabled)),r=s.rounds.find(r=>r.allowedActions?.find(a=>a.name==='projectFlow.round.accept')?.enabled)!,i=s.integrations.find(i=>i.id===r.integrationId)!;return engine.invoke('projectFlow.round.accept',{requestId:crypto.randomUUID(),roundId:r.id,expectedRevision:r.revision,integrationId:i.id,fingerprint:i.version!.fingerprint,opinion:'验收通过'});};
  return {engine,project,source,root,calls,state,wait,confirm,answer,accept,quota,ageQuota,kick:()=>controller.kick(),adapterFactory:factory,original:()=>readFile(path.join(source,'a.txt'),'utf8'),dispose:async()=>{await engine.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}};
}
