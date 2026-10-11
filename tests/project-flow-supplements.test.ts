import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/backend/engine';
import type { ProjectFlowController } from '../src/backend/project-flow';
import type { Adapter, AdapterContext, Approval, Project, RoomId, Run } from '../src/shared/types';
import type { FlowOperation, PlanPayload, ProjectFlowSnapshot, TaskSupplementResult } from '../src/shared/project-flow';
import {withPreviousChecks} from './helpers/project-flow-harness';

const latch=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return {promise,release};};
const evidence=[{kind:'inspection',description:'读取任务副本',result:'检查文件内容',eventIds:[]}];
async function fixture(options:{author?:'codex'|'claude';steer?:'accept'|'reject'|'unknown';holdReview?:boolean;oldReviewCriteria?:boolean;paused?:boolean;lateSteer?:boolean;rearrange?:boolean;invalidFirstSubmission?:boolean}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM supplements-')),source=path.join(root,'project');await mkdir(source);await writeFile(path.join(source,'a.txt'),'old-a');await writeFile(path.join(source,'b.txt'),'old-b');
  const author=options.author??'claude',lead=author==='claude'?'codex':'claude',authorGate=latch(),reviewGate=latch(),steerGate=latch(),formatGate=latch();
  const calls:{kind:string;ctx:AdapterContext;input:any;prompt:string}[]=[],steered:string[]=[];
  const plan:PlanPayload={objective:'修改 A',scope:'a.txt',deliverables:['A'],acceptanceCriteria:['A 正确'],rounds:[{key:'r1',title:'第一轮',goal:'A 正确',requiresUserAcceptance:true}],tasks:[{key:'a',roundKey:'r1',title:'修改 A',memberId:author,goal:'修改 A',inputs:[],completionCriteria:['A 正确'],dependencies:[],allowedPaths:['a.txt']}]};
  const factory=(id:AdapterContext['run']['provider']):Adapter=>{
    let input:any,stopped=false;
    return {probe:async()=>({id,name:id,available:true,auth:'subscription',detail:'fixture',capabilities:{steer:id==='codex',cancel:'native',streaming:true,write:true,history:true}}),stop:async()=>{stopped=true;authorGate.release();reviewGate.release();steerGate.release();formatGate.release();},steer:async(prompt)=>{
      steered.push(prompt);if(options.lateSteer)await steerGate.promise;
      if(options.steer==='unknown')throw new Error('lost supplement receipt');
      if(options.steer==='reject')return false;
      input.task.completionCriteria=JSON.parse(prompt.match(/最新完成标准：([^\n]+)/)![1]);return true;
    },start:async(ctx,prompt)=>{
      ctx.markDelivery('confirmed');ctx.persistNativeSession('native-'+ctx.session.id);
      const kind=prompt.match(/"kind":"([^"]+)"/)?.[1]??'',material=prompt.includes('\n任务材料：')?JSON.parse(prompt.split('\n任务材料：')[1]):calls.findLast(call=>call.kind===kind)?.input;
      input=structuredClone(material);calls.push({kind,ctx,input,prompt});
      let payload:unknown;
      if(kind==='plan'){payload=plan;if(input.instruction.startsWith('用户希望按这项补充调整方案：')){const revised=structuredClone(plan);revised.scope='a.txt 和 b.txt';revised.tasks[0].allowedPaths=['a.txt','b.txt'];revised.tasks[0].goal=input.instruction;payload=revised;}}
      else if(kind==='submission'){
        if(calls.filter(call=>call.kind==='submission').length===1)await authorGate.promise;
        if(options.invalidFirstSubmission&&calls.filter(call=>call.kind==='submission').length===2)await formatGate.promise;
        if(stopped)return {stopped:true};
        await writeFile(path.join(ctx.cwd,'a.txt'),input.task.completionCriteria.length>1?'supplement-complete':'first-result');
        if(options.invalidFirstSubmission&&calls.filter(call=>call.kind==='submission').length===1){ctx.emit('delta','not JSON');return {};}
        payload={summary:'完成任务',evidence,completionResults:input.task.completionCriteria.map((criterion:string)=>({criterion,verified:true,evidence:'读取任务文件'}))};
      }else if(kind==='review'||kind==='integration-check'){
        if(kind==='review'&&options.holdReview&&calls.filter(call=>call.kind==='review').length===1)await reviewGate.promise;
        if(stopped)return {stopped:true};
        const criteria=options.oldReviewCriteria&&kind==='review'?['A 正确']:kind==='review'?input.task.completionCriteria:input.criteria;
        const reject=options.rearrange&&kind==='review'&&calls.filter(call=>call.kind==='review').length<=3;
        payload={verdict:reject?'changes_requested':'pass',verificationComplete:true,criteriaResults:criteria.map((criterion:string)=>({criterion,verified:true,evidence:'读取副本文件'})),findings:reject?[{location:'a.txt',kind:'verified',severity:'blocking',evidence:'检查实际文件',request:'继续修正'}]:[],evidence};
      }else if(kind==='task-rearrange')payload={memberId:author,goal:'重新修改 A',completionCriteria:['重新完成 A'],reason:'重新安排任务，故意省略补充，核对服务器保留要求'};
      else if(kind==='round-report')payload={summary:'完成本轮',completedTaskKeys:input.taskKeys,deliverables:['A'],validationSummary:'读取整合副本',remainingIssues:[],nextRoundSummary:'结束',userDecisionNeeded:'请验收',meetingResponses:input.meeting.pendingUserMessages.map((message:any)=>({messageId:message.id,disposition:'noted',summary:'已记录',paths:[]}))};
      if(['review','integration-check'].includes(kind))payload=withPreviousChecks(payload,input);
      ctx.emit('delta',JSON.stringify({protocol:'airoom.project-flow',version:1,kind,payload}));return {};
    }};
  };
  const dataDirectory=path.join(root,'data'),engine=new Engine(dataDirectory,()=>{},()=>{},factory);await engine.probe();const project=await engine.invoke('project.create',{directory:source}) as Project,roomId=`project:${project.id}` as RoomId;
  const state=()=>engine.invoke('projectFlow.get',{projectId:project.id}) as Promise<ProjectFlowSnapshot>;
  async function waitFor(check:(data:ProjectFlowSnapshot)=>boolean){const deadline=Date.now()+15000;for(;;){const data=await state();if(check(data))return data;if(Date.now()>deadline)assert.fail('supplement flow did not settle: '+JSON.stringify({tasks:data.tasks,rounds:data.rounds,flow:data.flow,calls:calls.map(call=>call.kind)}));await new Promise(resolve=>setTimeout(resolve,10));}}
  await engine.invoke('projectFlow.start',{requestId:'start',projectId:project.id,topic:'修改 A',reviewLevel:'high',leadMemberId:lead,memberIds:[author,lead]});let ready=await waitFor(data=>Boolean(data.plan));
  if(options.paused){await engine.invoke('projectFlow.pause',{requestId:'pause',flowId:ready.flow!.id,expectedRevision:ready.flow!.revision});ready=await state();}
  await engine.invoke('projectFlow.plan.confirm',{requestId:'confirm',planId:ready.plan!.id,expectedRevision:ready.plan!.revision});
  if(!options.paused)await waitFor(data=>data.tasks[0]?.status==='running');
  const supplement=async(text='增加错误提示',extra:Record<string,unknown>={})=>{const data=await state();return engine.invoke('projectFlow.task.supplement',{requestId:crypto.randomUUID(),taskId:data.tasks[0].id,expectedRevision:data.tasks[0].revision,text,...extra}) as Promise<TaskSupplementResult>;};
  const resume=async()=>{const data=await state();return engine.invoke('projectFlow.resume',{requestId:crypto.randomUUID(),flowId:data.flow!.id,expectedRevision:data.flow!.revision});};
  return {engine,project,root,source,roomId,dataDirectory,calls,steered,state,waitFor,supplement,resume,authorGate,reviewGate,steerGate,formatGate,dispose:async()=>{authorGate.release();reviewGate.release();steerGate.release();formatGate.release();await engine.close();await rm(root,{recursive:true,force:true});}};
}

test('running Codex receives a confirmed supplement in the same turn and review uses the new criteria',async()=>{
  const h=await fixture({author:'codex'});try{
    const before=await h.state(),plan=h.engine.store.get('flow_plans',before.plan!.id),authorSession=before.tasks[0].sessionId!;
    const params={requestId:'one-supplement',taskId:before.tasks[0].id,expectedRevision:before.tasks[0].revision,text:'增加错误提示'};
    const result=await h.engine.invoke('projectFlow.task.supplement',params) as TaskSupplementResult;
    assert.equal(result.disposition,'current');assert.deepEqual(await h.engine.invoke('projectFlow.task.supplement',params),result);assert.equal(h.steered.length,1);
    h.authorGate.release();const done=await h.waitFor(data=>data.rounds[0]?.status==='awaiting_acceptance');
    assert.equal(h.calls.filter(call=>call.kind==='submission').length,1);assert.equal(done.tasks[0].sessionId,authorSession);assert.equal(done.tasks[0].returnCount,0);assert.match(done.tasks[0].goal,/增加错误提示/);
    assert.equal(done.submissions[0].requirementsRevision,2);assert.equal(done.reviews[0].requirementsRevision,2);assert.ok(done.reviews[0].criteriaResults!.some(result=>result.criterion==='补充要求：增加错误提示'));
    assert.equal(done.tasks[0].supplements![0].status,'applied');assert.equal(h.engine.store.get<any>('sessions',authorSession).nativeId,'native-'+authorSession);
    assert.deepEqual(h.engine.store.get('flow_plans',done.plan!.id),plan);assert.equal(await readFile(path.join(h.source,'a.txt'),'utf8'),'old-a');
  }finally{await h.dispose();}
});

test('a member without steering continues in its original session before any submission or review',async()=>{
  const h=await fixture();try{
    const before=await h.state(),authorSession=before.tasks[0].sessionId!,result=await h.supplement();assert.equal(result.disposition,'next-turn');assert.equal(h.steered.length,0);
    h.authorGate.release();const done=await h.waitFor(data=>data.rounds[0]?.status==='awaiting_acceptance'),authorCalls=h.calls.filter(call=>call.kind==='submission');
    assert.equal(authorCalls.length,2);assert.ok(authorCalls.every(call=>call.ctx.session.id===authorSession));assert.equal(done.submissions.length,1);assert.equal(done.reviews.length,1);assert.equal(done.tasks[0].returnCount,0);
    assert.equal(done.submissions[0].requirementsRevision,2);assert.equal(done.submissions[0].runId,authorCalls[1].ctx.run.id);assert.match(authorCalls[1].input.task.goal,/增加错误提示/);
    const artifact=h.engine.store.get<any>('flow_artifacts',done.submissions[0].version.artifactId);assert.equal(await readFile(path.join(artifact.root,'a.txt'),'utf8'),'supplement-complete');
  }finally{await h.dispose();}
});

test('a rejected steer schedules a same-session follow-up, while a paused pending task receives its supplement on its first run',async()=>{
  const h=await fixture({author:'codex',steer:'reject'});try{assert.equal((await h.supplement()).disposition,'next-turn');h.authorGate.release();const done=await h.waitFor(data=>data.rounds[0]?.status==='awaiting_acceptance');assert.equal(h.steered.length,1);assert.equal(h.calls.filter(call=>call.kind==='submission').length,2);assert.equal(done.tasks[0].returnCount,0);}finally{await h.dispose();}
  const paused=await fixture({paused:true});try{const before=await paused.state();assert.equal(before.tasks[0].status,'pending');assert.equal((await paused.supplement()).disposition,'recorded');assert.equal(paused.calls.filter(call=>call.kind==='submission').length,0);paused.authorGate.release();await paused.resume();const done=await paused.waitFor(data=>data.rounds[0]?.status==='awaiting_acceptance');assert.equal(paused.calls.filter(call=>call.kind==='submission').length,1);assert.equal(done.submissions[0].requirementsRevision,2);}finally{await paused.dispose();}
});

test('supplementing a submitted task withdraws its submission and an in-flight old review cannot pass or increment return count',async()=>{
  const h=await fixture({holdReview:true});try{
    h.authorGate.release();const before=await h.waitFor(data=>data.reviews[0]?.status==='running'&&h.calls.some(call=>call.kind==='review')),submissionId=before.submissions[0].id,authorSession=before.tasks[0].sessionId!;
    await h.supplement();const changed=await h.state();assert.equal(changed.submissions[0].status,'stale');assert.equal(changed.reviews[0].status,'stale');assert.equal(changed.tasks[0].status,'correcting');assert.equal(changed.tasks[0].returnCount,0);assert.equal(changed.tasks[0].supplements![0].withdrawnSubmissionId,submissionId);
    await new Promise(resolve=>setTimeout(resolve,50));assert.equal(h.calls.filter(call=>call.kind==='submission').length,1);
    h.reviewGate.release();const done=await h.waitFor(data=>data.rounds[0]?.status==='awaiting_acceptance');assert.equal(done.tasks[0].returnCount,0);assert.equal(done.tasks[0].sessionId,authorSession);assert.equal(done.submissions[0].status,'stale');assert.equal(done.reviews[0].status,'stale');assert.equal(done.reviews[1].status,'passed');assert.equal(done.reviews[1].requirementsRevision,2);assert.equal(done.tasks[0].latestSubmissionId,done.submissions[1].id);
  }finally{await h.dispose();}
});

test('a review claiming pass using only the old criteria becomes inconclusive without inventing checks in format correction',async()=>{
  const h=await fixture({oldReviewCriteria:true});try{
    await h.supplement();h.authorGate.release();const blocked=await h.waitFor(data=>data.tasks[0]?.status==='blocked');
    assert.equal(h.calls.filter(call=>call.kind==='review').length,1);assert.equal(blocked.reviews[0].verdict,'pass');assert.equal(blocked.reviews[0].outcome,'inconclusive');assert.equal(blocked.tasks[0].supplements![0].status,'submitted');assert.equal(blocked.tasks[0].returnCount,0);assert.equal(blocked.integrations.length,0);assert.match(blocked.tasks[0].blockedReason!,/未能核实/);assert.ok(blocked.decisions.some(d=>d.kind==='unresolved-review'&&d.taskId===blocked.tasks[0].id));
  }finally{await h.dispose();}
});

test('an out-of-scope supplement creates a durable decision without changing requirements, steering, or advancing integration',async()=>{
  const h=await fixture({author:'codex'});try{
    const before=await h.state(),result=await h.supplement('同时修改 b.txt');assert.equal(result.disposition,'scope-change');assert.equal(h.steered.length,0);assert.ok(h.engine.store.roomView(h.roomId).messages.some(message=>message.flowDecision?.decisionId===result.decisionId));
    const changed=await h.state();assert.equal(changed.tasks[0].goal,before.tasks[0].goal);assert.deepEqual(changed.tasks[0].completionCriteria,before.tasks[0].completionCriteria);assert.deepEqual(changed.tasks[0].allowedPaths,['a.txt']);assert.equal(changed.tasks[0].supplements![0].status,'awaiting_scope');
    h.authorGate.release();await h.waitFor(data=>data.tasks[0].status==='review_passed');await new Promise(resolve=>setTimeout(resolve,50));const waiting=await h.state();assert.equal(waiting.integrations.length,0);
    const decision=waiting.decisions.find(decision=>decision.id===result.decisionId)!;await h.engine.invoke('projectFlow.decision.answer',{requestId:'keep-scope',decisionId:decision.id,expectedRevision:decision.revision,choice:'保持原范围'});
    const done=await h.waitFor(data=>data.rounds[0]?.status==='awaiting_acceptance');assert.equal(done.tasks[0].supplements![0].status,'dismissed');assert.equal(await readFile(path.join(h.source,'b.txt'),'utf8'),'old-b');assert.equal(h.calls.filter(call=>call.kind==='submission').length,1);
  }finally{await h.dispose();}
});

test('unknown steering is retained idempotently, pauses dispatch, and is not replayed after restart',async()=>{
  const h=await fixture({author:'codex',steer:'unknown'});let restarted:Engine|undefined;try{
    const before=await h.state(),params={requestId:'unknown-supplement',taskId:before.tasks[0].id,expectedRevision:before.tasks[0].revision,text:'增加错误提示'},result=await h.engine.invoke('projectFlow.task.supplement',params) as TaskSupplementResult;
    assert.equal(result.disposition,'unknown');assert.equal(h.steered.length,1);assert.deepEqual(await h.engine.invoke('projectFlow.task.supplement',params),result);
    const blocked=await h.state();assert.equal(blocked.flow!.dispatchMode,'paused');assert.equal(blocked.tasks[0].supplements![0].status,'unknown');await assert.rejects(h.resume(),(error:any)=>error.code==='UNKNOWN_RESULT');await assert.rejects(h.supplement('再加一个要求'),(error:any)=>error.code==='UNKNOWN_RESULT');
    h.authorGate.release();await h.waitFor(()=>h.engine.store.list<any>('runs').filter(run=>run.flowOperationId).every(run=>run.completedAt));assert.equal(h.calls.filter(call=>call.kind==='submission').length,1);assert.equal((await h.state()).submissions.length,0);await h.engine.close();
    let nativeCalls=0;restarted=new Engine(h.dataDirectory,()=>{},()=>{},id=>({probe:async()=>({id,name:id,available:true,auth:'subscription',detail:'fixture',capabilities:{steer:true,cancel:'native',streaming:true,write:true,history:true}}),start:async()=>{nativeCalls++;return {};},stop:async()=>{},steer:async()=>{nativeCalls++;return true;}}));
    await restarted.probe();assert.deepEqual(await restarted.invoke('projectFlow.task.supplement',params),result);await new Promise(resolve=>setTimeout(resolve,50));assert.equal(nativeCalls,0);const recovered=await restarted.invoke('projectFlow.get',{projectId:h.project.id}) as ProjectFlowSnapshot;assert.equal(recovered.tasks[0].supplements![0].status,'unknown');assert.equal(recovered.flow!.dispatchMode,'paused');
  }finally{await restarted?.close();await h.dispose();}
});

test('meeting-source validation rejects foreign messages and approved work is referred to a new task without rewriting it',async()=>{
  const h=await fixture({paused:true});try{
    const foreign=path.join(h.root,'foreign');await mkdir(foreign);const other=await h.engine.invoke('project.create',{directory:foreign}) as Project,foreignRoom=`project:${other.id}` as RoomId,foreignThread=h.engine.store.currentRoomThread(foreignRoom);
    h.engine.store.roomScope(foreignRoom).put('room_messages','foreign',{id:'foreign',threadId:foreignThread.id,author:'user',text:'另一个项目的要求',at:new Date().toISOString(),status:'done'});
    await assert.rejects(h.supplement('增加错误提示',{sourceMessageId:'foreign'}),(error:any)=>error.code==='INVALID_REQUEST');assert.equal((await h.state()).tasks[0].supplements?.length??0,0);
    const thread=h.engine.store.currentRoomThread(h.roomId);h.engine.store.roomScope(h.roomId).put('room_messages','decision-source',{id:'decision-source',threadId:thread.id,author:'user',text:'决策处理结果',at:new Date().toISOString(),status:'done',system:true});await assert.rejects(h.supplement('增加错误提示',{sourceMessageId:'decision-source'}),(error:any)=>error.code==='INVALID_REQUEST');h.engine.store.roomScope(h.roomId).put('room_messages','own-source',{id:'own-source',threadId:thread.id,author:'user',text:'增加错误提示',at:new Date().toISOString(),status:'done'});
    await h.supplement('增加错误提示',{sourceMessageId:'own-source'});h.authorGate.release();await h.resume();const done=await h.waitFor(data=>data.rounds[0]?.status==='awaiting_acceptance'),task=structuredClone(done.tasks[0]);assert.equal(task.supplements![0].source,'meeting');assert.equal(task.supplements![0].sourceMessageId,'own-source');
    const response=await h.supplement('再增加一个要求');assert.equal(response.disposition,'new-task-required');assert.equal(response.nextAction,'projectFlow.task.add');assert.equal(response.draft!.memberId,task.memberId);assert.deepEqual((await h.state()).tasks[0],task);assert.equal(h.calls.filter(call=>call.kind==='submission').length,1);
    await assert.rejects(h.engine.invoke('projectFlow.task.supplement',{requestId:'stale',taskId:task.id,expectedRevision:task.revision-1,text:'旧卡片的要求'}),(error:any)=>error.code==='STALE_REVISION');
    const round=done.rounds[0],integration=done.integrations.find(integration=>integration.id===round.integrationId)!;await h.engine.invoke('projectFlow.round.accept',{requestId:'accept',roundId:round.id,integrationId:integration.id,fingerprint:integration.version!.fingerprint,expectedRevision:round.revision});const accepted=await h.waitFor(data=>data.flow?.status==='completed'),acceptedTask=structuredClone(accepted.tasks[0]),next=await h.supplement('开始下一段工作');assert.equal(next.disposition,'new-task-required');assert.equal(next.requiresNewFlow,true);assert.deepEqual((await h.state()).tasks[0],acceptedTask);
  }finally{await h.dispose();}
});

test('a completion racing the steer acknowledgement waits for the receipt and cannot submit using the old requirements',async()=>{
  const h=await fixture({author:'codex',lateSteer:true});try{
    const before=await h.state(),params={requestId:'concurrent-supplement',taskId:before.tasks[0].id,expectedRevision:before.tasks[0].revision,text:'增加错误提示'},promise=h.engine.invoke('projectFlow.task.supplement',params) as Promise<TaskSupplementResult>;await h.waitFor(data=>data.tasks[0].supplements?.[0]?.status==='delivering');const duplicate=h.engine.invoke('projectFlow.task.supplement',params);h.authorGate.release();await h.waitFor(()=>h.calls.filter(call=>call.kind==='submission').every(call=>h.engine.store.get<any>('runs',call.ctx.run.id)?.completedAt));assert.equal((await h.state()).submissions.length,0);
    h.steerGate.release();const result=await promise;assert.deepEqual(await duplicate,result);assert.equal(result.disposition,'unknown');assert.equal(h.steered.length,1);assert.equal((await h.state()).tasks[0].status,'blocked');assert.equal((await h.state()).submissions.length,0);assert.equal(h.calls.filter(call=>call.kind==='submission').length,1);
  }finally{await h.dispose();}
});

test('a supplement arriving during artifact capture invalidates that snapshot and continues in the same author session',async()=>{
  const h=await fixture({author:'codex'}),captureGate=latch(),entered=latch(),controller=(h.engine as unknown as {projectFlow:ProjectFlowController}).projectFlow,capture=controller.artifacts.capture.bind(controller.artifacts);let first=true;
  controller.artifacts.capture=async(...args:Parameters<typeof capture>)=>{if(args[2]==='submission'&&first){first=false;entered.release();await captureGate.promise;}return capture(...args);};
  try{
    h.authorGate.release();await entered.promise;assert.equal((await h.supplement()).disposition,'next-turn');captureGate.release();const done=await h.waitFor(data=>data.rounds[0]?.status==='awaiting_acceptance');
    assert.equal(done.submissions.length,1);assert.equal(done.submissions[0].requirementsRevision,2);assert.equal(h.calls.filter(call=>call.kind==='submission').length,2);assert.equal(new Set(h.calls.filter(call=>call.kind==='submission').map(call=>call.ctx.session.id)).size,1);assert.equal(h.steered.length,0);assert.ok(h.engine.store.list<any>('flow_artifacts').some(artifact=>artifact.purpose==='submission'&&artifact.status==='removed'));
  }finally{captureGate.release();controller.artifacts.capture=capture;await h.dispose();}
});

test('two genuine review returns remain two after a user supplement and automatic rearrangement cannot drop that supplement',async()=>{
  const h=await fixture({rearrange:true});try{
    await h.supplement();h.authorGate.release();const done=await h.waitFor(data=>data.rounds[0]?.status==='awaiting_acceptance');assert.equal(done.tasks[0].returnCount,2);assert.equal(done.tasks[0].rearrangeCount,1);assert.equal(h.calls.filter(call=>call.kind==='task-rearrange').length,1);assert.match(done.tasks[0].goal,/增加错误提示/);assert.ok(done.tasks[0].completionCriteria.includes('补充要求：增加错误提示'));assert.ok(h.calls.findLast(call=>call.kind==='review')!.input.task.completionCriteria.includes('补充要求：增加错误提示'));
  }finally{await h.dispose();}
});

test('changing supplement scope proposes a new plan and waits for explicit confirmation without widening the old task',async()=>{
  const h=await fixture();try{
    const result=await h.supplement('同时修改 b.txt');h.authorGate.release();await h.waitFor(data=>data.tasks[0].status==='review_passed'&&h.engine.store.list<any>('flow_artifacts').filter(artifact=>artifact.purpose==='review').every(artifact=>artifact.status==='removed'));
    const data=await h.state(),decision=data.decisions.find(decision=>decision.id===result.decisionId)!;await h.engine.invoke('projectFlow.decision.answer',{requestId:'replan-scope',decisionId:decision.id,expectedRevision:decision.revision,choice:'调整方案'});
    const proposed=await h.waitFor(data=>data.plan?.version===2);assert.equal(proposed.plan!.status,'awaiting_confirmation');assert.deepEqual(proposed.tasks[0].allowedPaths,['a.txt']);assert.equal(proposed.tasks[0].supplements![0].status,'replanned');assert.equal(h.calls.filter(call=>call.kind==='submission').length,1);assert.match(h.calls.findLast(call=>call.kind==='plan')!.input.instruction,/b.txt/);assert.equal(h.calls.findLast(call=>call.kind==='plan')!.input.currentTaskRequirements[0].supplements[0].text,'同时修改 b.txt');assert.equal(await readFile(path.join(h.source,'b.txt'),'utf8'),'old-b');
  }finally{await h.dispose();}
});

test('only explicit abandonment followed by resume can continue after an unknown supplement, and it does not retry the steer',async()=>{
  const h=await fixture({author:'codex',steer:'unknown'});try{
    const result=await h.supplement();assert.equal(result.disposition,'unknown');const attention=await h.engine.invoke('attention.list') as any;assert.equal(attention.items.find((item:any)=>item.kind==='unknown')?.action.view,'project-room');
    const author=h.calls.find(call=>call.kind==='submission')!,question=author.ctx.approve({type:'question',title:'确认修改方向',detail:'请确认修改方向。',options:[{id:'answer',label:'继续原方向'}],allowChoice:'answer'});void question.catch(()=>{});
    await h.waitFor(()=>h.engine.store.get<Run>('runs',author.ctx.run.id)?.status==='waiting_user');
    const waitingOperation=h.engine.store.get<FlowOperation>('flow_operations',result.operationId!)!;
    await assert.rejects(h.engine.invoke('projectFlow.unknown.resolve',{requestId:'cannot-abandon-waiting-author',operationId:waitingOperation.id,expectedRevision:waitingOperation.revision,choice:'abandon',evidence:'用户问题尚未回答，原工作仍未结束。'}),/旧运行尚未确认停止/);
    assert.equal((await h.state()).tasks[0].supplements![0].status,'unknown');assert.equal(h.engine.store.get<FlowOperation>('flow_operations',waitingOperation.id)!.state,'blocked');assert.equal(h.calls.filter(call=>call.kind==='submission').length,1);
    const pendingQuestion=h.engine.store.list<Approval>('approvals').find(item=>item.runId===author.ctx.run.id&&item.state==='pending')!;await h.engine.invoke('approval.answer',{id:pendingQuestion.id,choice:'answer'});await question;
    h.authorGate.release();await h.waitFor(()=>h.calls.filter(call=>call.kind==='submission').every(call=>h.engine.store.get<any>('runs',call.ctx.run.id)?.completedAt));
    const operation=h.engine.store.get<FlowOperation>('flow_operations',result.operationId!)!;await h.engine.invoke('projectFlow.unknown.resolve',{requestId:'abandon-uncertain-attempt',operationId:operation.id,expectedRevision:operation.revision,choice:'abandon',evidence:'已查看原运行，明确放弃旧尝试，保留补充要求重新执行。'});
    const paused=await h.state();assert.equal(paused.flow!.dispatchMode,'paused');assert.equal(paused.tasks[0].supplements![0].status,'pending');assert.equal(h.calls.filter(call=>call.kind==='submission').length,1);assert.equal((await h.engine.invoke('attention.list') as any).counts.unknown,0);const receipt=h.engine.store.get<any>('outbox',result.operationId!)!;assert.equal(receipt.delivery,'unknown');assert.ok(receipt.acknowledgedAt);await h.resume();const done=await h.waitFor(data=>data.rounds[0]?.status==='awaiting_acceptance');assert.equal(h.steered.length,1);assert.equal(h.calls.filter(call=>call.kind==='submission').length,2);assert.equal(done.tasks[0].supplements![0].status,'applied');assert.equal(done.tasks[0].returnCount,0);
  }finally{await h.dispose();}
});

test('closing while a supplement receipt is pending waits for the request to settle and sends no second task',async()=>{
  const h=await fixture({author:'codex',lateSteer:true});try{
    const request=h.supplement();await h.waitFor(data=>data.tasks[0].supplements?.[0]?.status==='delivering');await h.engine.close();const result=await request;assert.equal(result.disposition,'unknown');assert.equal(h.steered.length,1);assert.equal(h.calls.filter(call=>call.kind==='submission').length,1);
  }finally{await h.dispose();}
});

test('a supplement during JSON correction never steers that format-only turn and is completed in the next work turn',async()=>{
  const h=await fixture({author:'codex',invalidFirstSubmission:true});try{
    h.authorGate.release();await h.waitFor(()=>h.calls.filter(call=>call.kind==='submission').length===2);assert.equal((await h.supplement()).disposition,'recorded');assert.equal(h.steered.length,0);h.formatGate.release();const done=await h.waitFor(data=>data.rounds[0]?.status==='awaiting_acceptance');
    assert.equal(h.calls.filter(call=>call.kind==='submission').length,3);assert.equal(done.submissions.length,1);assert.equal(done.submissions[0].requirementsRevision,2);assert.equal(done.tasks[0].returnCount,0);assert.equal(done.tasks[0].supplements![0].status,'applied');assert.equal(new Set(h.calls.filter(call=>call.kind==='submission').map(call=>call.ctx.session.id)).size,1);
  }finally{await h.dispose();}
});
