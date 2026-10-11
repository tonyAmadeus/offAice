import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Engine } from '../src/backend/engine';
import type { Adapter, AdapterContext, Project, RoomId } from '../src/shared/types';
import type { MeetingResponse, PlanPayload, ProjectFlowSnapshot } from '../src/shared/project-flow';

async function fixture(options:{parallel?:number;twoRounds?:boolean;response?:MeetingResponse['disposition'];paths?:string[];unknownMention?:boolean;omitResponses?:boolean;beforeConfirm?:string}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM flow-chat-')),source=path.join(root,'project');await mkdir(source);await writeFile(path.join(source,'a.txt'),'old-a');await writeFile(path.join(source,'b.txt'),'old-b');
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),calls:{kind:string;ctx:AdapterContext;input:any;prompt:string}[]=[];let active=0,peak=0,firstTask=true;
  const plan:PlanPayload={objective:'修改 A',scope:'a.txt 和 b.txt',deliverables:['文件'],acceptanceCriteria:['文件正确'],rounds:[{key:'r1',title:'第一轮',goal:'A 正确',requiresUserAcceptance:true},...(options.twoRounds?[{key:'r2',title:'第二轮',goal:'B 正确',requiresUserAcceptance:true}]:[])],tasks:[{key:'a',roundKey:'r1',title:'A',memberId:'claude',goal:'修改 A',inputs:[],completionCriteria:['A 正确'],dependencies:[],allowedPaths:['a.txt']},...(options.twoRounds?[{key:'b',roundKey:'r2',title:'B',memberId:'claude',goal:'修改 B',inputs:[],completionCriteria:['B 正确'],dependencies:[],allowedPaths:['b.txt']}]:[])]};
  const factory=(id:AdapterContext['run']['provider']):Adapter=>{let stopped=false;return {supportsRuntimeReuse:true,canReuse:()=>true,dispose:async()=>{},probe:async()=>({id,name:id,available:true,auth:'subscription',detail:'fixture',capabilities:{steer:false,cancel:'native',streaming:true,write:true,history:true}}),stop:async()=>{stopped=true;release();},start:async(ctx,prompt)=>{
    ctx.markDelivery('confirmed');active++;peak=Math.max(peak,active);
    const kind=prompt.match(/"kind":"([^"]+)"/)?.[1]??'room',input=kind==='room'?JSON.parse(prompt.split('\nAIROOM_CONTEXT\n')[1]):prompt.includes('\n任务材料：')?JSON.parse(prompt.split('\n任务材料：')[1]):calls.findLast(call=>call.kind===kind)?.input;calls.push({kind,ctx,input,prompt});ctx.persistNativeSession('native-'+ctx.session.id);
    try{let payload:unknown;
      if(kind==='room'){if(options.unknownMention)return {unknown:true};ctx.emit('delta',JSON.stringify({version:1,turn:input.turn,revision:input.revision,action:'speak',body:input.phase==='working-mention'?`真实进度：${input.taskStatus.tasks[0]?.status}；改需求请走驳回或修改方案。`:'验收后补读并讨论。'}));return {};}
      if(kind==='plan')payload=plan;
      else if(kind==='submission'){if(firstTask){firstTask=false;await gate;}if(stopped)return {stopped:true};const task=input.task;await writeFile(path.join(ctx.cwd,task.allowedPaths[0]),task.kind==='integration-fix'?'fixed requirement':'new-'+task.key);payload={summary:'已修改',evidence:[{kind:'inspection',description:'实际读文件',result:'已读',eventIds:[]}],completionResults:task.completionCriteria.map((criterion:string)=>({criterion,verified:true,evidence:'实际读文件'}))};}
      else if(kind==='review'||kind==='integration-check'){const criteria=kind==='review'?input.task.completionCriteria:input.criteria;payload={verdict:'pass',verificationComplete:true,criteriaResults:criteria.map((criterion:string)=>({criterion,verified:true,evidence:'实际读文件'})),findings:[],evidence:[{kind:'inspection',description:'读取副本',result:'内容正确',eventIds:[]}]};}
      else if(kind==='next-round')payload={mode:'as-planned',summary:'按原计划',taskAdjustments:[]};
      else if(kind==='round-report')payload={summary:'本轮成品已检查',completedTaskKeys:input.taskKeys,deliverables:['文件'],validationSummary:'实际读取整合副本',remainingIssues:[],nextRoundSummary:'按方案继续',userDecisionNeeded:'',meetingResponses:options.omitResponses?[]:input.meeting.pendingUserMessages.map((message:any)=>({messageId:message.id,disposition:options.response??'noted',summary:message.text,paths:options.paths??[]}))};
      ctx.emit('delta',JSON.stringify({protocol:'airoom.project-flow',version:1,kind,payload}));return {};
    }finally{active--;}
  }};};
  const engine=new Engine(path.join(root,'data'),()=>{},()=>{},factory);await engine.probe();if(options.parallel)await engine.invoke('settings.save',{maxParallel:options.parallel});const project=await engine.invoke('project.create',{directory:source}) as Project,roomId=`project:${project.id}` as RoomId;
  const state=()=>engine.invoke('projectFlow.get',{projectId:project.id}) as Promise<ProjectFlowSnapshot>;
  async function waitFor(check:(data:ProjectFlowSnapshot)=>boolean){const deadline=Date.now()+15000;for(;;){const data=await state();if(check(data))return data;if(Date.now()>deadline)assert.fail('flow chat did not settle: '+JSON.stringify(data));await new Promise(resolve=>setTimeout(resolve,10));}}
  await engine.invoke('projectFlow.start',{requestId:'start',projectId:project.id,topic:'修改文件',reviewLevel:'high',leadMemberId:'codex',memberIds:['codex','claude']});const ready=await waitFor(data=>Boolean(data.plan));if(options.beforeConfirm){await engine.invoke('room.send',{roomId,mode:'discuss',text:options.beforeConfirm,memberIds:['codex','claude'],maxCalls:1});await waitFor(()=>!engine.store.roomView(roomId).state.active);}await engine.invoke('projectFlow.plan.confirm',{requestId:'confirm',planId:ready.plan!.id,expectedRevision:ready.plan!.revision});await waitFor(()=>calls.some(call=>call.kind==='submission'));
  const send=(text:string)=>engine.invoke('room.send',{roomId,mode:'discuss',text,memberIds:['codex','claude'],maxCalls:1});
  const accept=(data:ProjectFlowSnapshot,index=0)=>{const round=data.rounds.find(round=>round.index===index)!,integration=data.integrations.find(item=>item.id===round.integrationId)!;return engine.invoke('projectFlow.round.accept',{requestId:crypto.randomUUID(),roundId:round.id,expectedRevision:round.revision,integrationId:integration.id,fingerprint:integration.version!.fingerprint});};
  return {engine,project,roomId,calls,release,waitFor,state,send,accept,source,peak:()=>peak,root,dispose:async()=>{release();await engine.close();await rm(root,{recursive:true,force:true});}};
}

test('working members ignore ordinary discussion; a mention reads only its own message and real board status in a fresh read-only session',async()=>{
  const h=await fixture();try{
    const task=await h.waitFor(data=>Boolean(data.tasks[0]?.sessionId)),sessionId=task.tasks[0].sessionId!,nativeId=h.engine.store.get<any>('sessions',sessionId).nativeId;
    await h.engine.invoke('room.send',{roomId:h.roomId,mode:'discuss',text:'没有点名的会议要求，不能进入任务会话。',memberIds:['codex'],maxCalls:1});await new Promise(resolve=>setTimeout(resolve,80));assert.equal(h.calls.filter(call=>call.kind==='room').length,0);
    await h.send('@Claudia 现在进度怎么样？顺便改需求。');await h.waitFor(()=>h.engine.store.roomView(h.roomId).messages.some(message=>message.author==='claude'&&message.status==='done'));
    const mention=h.calls.find(call=>call.kind==='room')!;assert.equal(mention.input.phase,'working-mention');assert.match(mention.input.message.text,/现在进度/);assert.equal('messages' in mention.input,false);assert.equal('recent' in mention.input,false);assert.equal(mention.input.taskStatus.tasks[0].status,(await h.state()).tasks[0].status);assert.equal(mention.ctx.session.purpose,'room-mention');assert.equal(mention.ctx.session.writeMode,false);assert.equal(mention.ctx.roomRuntime,undefined);assert.equal(mention.ctx.settings.permissions.claude.commands,'deny');assert.notEqual(mention.ctx.session.id,sessionId);
    assert.equal(h.engine.store.get<any>('sessions',sessionId).nativeId,nativeId);assert.equal(h.calls.filter(call=>call.kind==='submission').length,1);assert.equal(h.calls.filter(call=>call.kind==='room').length,1);assert.deepEqual(h.engine.store.roomView(h.roomId).state.discussion!.members,['codex']);assert.equal(h.calls.find(call=>call.kind==='submission')!.prompt.includes('没有点名'),false);assert.equal(await readFile(path.join(h.source,'a.txt'),'utf8'),'old-a');
  }finally{await h.dispose();}
});

test('a working-member question remains readable context without becoming a pending project requirement',async()=>{
  const h=await fixture({response:'needs-user'});try{
    await h.send('@Claudia 只问现在的进度，不修改要求。');await h.waitFor(()=>h.engine.store.roomView(h.roomId).messages.some(message=>message.author==='claude'&&message.status==='done'));
    const asked=h.engine.store.roomView(h.roomId).messages.find(message=>message.author==='user'&&message.text.includes('只问现在'))!;assert.equal(asked.intent,'readonly-question');
    h.release();const ready=await h.waitFor(data=>Boolean(data.rounds[0]?.allowedActions?.find(action=>action.name==='projectFlow.round.accept')?.enabled));
    const check=h.calls.find(call=>call.kind==='integration-check')!,report=h.calls.find(call=>call.kind==='round-report')!;assert.ok(check.input.meeting.messages.some((message:any)=>message.id===asked.id&&message.intent==='readonly-question'));
    assert.equal(report.input.meeting.pendingUserMessages.some((message:any)=>message.id===asked.id),false);assert.equal(ready.decisions.some(decision=>decision.kind==='meeting-request'),false);
    await h.accept(ready);await h.waitFor(data=>data.flow?.status==='completed');assert.equal(await readFile(path.join(h.source,'a.txt'),'utf8'),'new-a');
  }finally{await h.dispose();}
});

test('one-off mention uses the shared parallel limit and waits without interrupting a running task',async()=>{
  const h=await fixture({parallel:1});try{
    await h.send('@Claudia 只问进度。');await h.waitFor(()=>h.engine.store.list<any>('runs').some(run=>run.status==='queued'&&h.engine.store.get<any>('sessions',run.sessionId)?.purpose==='room-mention'));
    assert.equal(h.calls.filter(call=>call.kind==='room').length,0);assert.equal((await h.state()).tasks[0].status,'running');h.release();await h.waitFor(()=>h.calls.some(call=>call.kind==='room'));assert.equal(h.peak(),1);
  }finally{await h.dispose();}
});

test('the lead reports meeting requests and asks for a decision; acceptance supplies unread chat to the next task',async()=>{
  const h=await fixture({twoRounds:true,response:'needs-user'});try{
    await h.send('本轮仍有一个样式要求，需要你决定。');h.release();const data=await h.waitFor(data=>data.rounds[0]?.status==='awaiting_acceptance'&&data.decisions.some(decision=>decision.kind==='meeting-request'));
    assert.match(data.rounds[0].report!.remainingIssues.join('\n'),/样式要求/);assert.match(data.rounds[0].report!.userDecisionNeeded,/样式要求/);assert.ok(h.calls.find(call=>call.kind==='integration-check')!.input.meeting.messages.some((message:any)=>message.text.includes('样式要求')));
    await assert.rejects(h.accept(data),/先处理会议/);const decision=data.decisions.find(decision=>decision.kind==='meeting-request')!;await h.engine.invoke('projectFlow.decision.answer',{requestId:'keep',decisionId:decision.id,expectedRevision:decision.revision,choice:'保留当前方案'});
    const ready=await h.waitFor(data=>Boolean(data.rounds[0].allowedActions?.find(action=>action.name==='projectFlow.round.accept')?.enabled));await h.accept(ready);const next=await h.waitFor(data=>data.decisions.some(d=>d.kind==='next-round'&&d.status==='open')),confirmation=next.decisions.find(d=>d.kind==='next-round'&&d.status==='open')!;assert.equal(h.calls.filter(call=>call.kind==='submission').length,1);await h.engine.invoke('projectFlow.decision.answer',{requestId:'next-original',decisionId:confirmation.id,expectedRevision:confirmation.revision,choice:'按原计划开始'});await h.waitFor(()=>h.calls.filter(call=>call.kind==='submission').length>=2);
    const work=h.calls.filter(call=>call.kind==='submission');assert.equal(work[0].input.acceptedMeetingBackground.messages.length,0);assert.ok(work[1].input.acceptedMeetingBackground.messages.some((message:any)=>message.text.includes('样式要求')));assert.match(work[1].input.meetingPolicy,/不改变本任务/);
  }finally{await h.dispose();}
});

test('an in-scope meeting fix is checked by the leader as a whole round; the project stays untouched until acceptance',async()=>{
  const h=await fixture({response:'in-scope-fix',paths:['a.txt']});try{
    await h.send('A 需要补上新要求。');h.release();const data=await h.waitFor(data=>data.rounds[0]?.status==='awaiting_acceptance'&&data.tasks.some(task=>task.kind==='integration-fix'));
    const fix=data.tasks.find(task=>task.kind==='integration-fix')!;assert.deepEqual(fix.completionCriteria,['A 需要补上新要求。']);assert.equal(fix.memberId,fix.reviewerMemberId);assert.equal(fix.reviewSkipped,'round-fix');assert.equal(data.reviews.some(review=>review.taskId===fix.id),false);assert.equal(h.calls.filter(call=>call.kind==='integration-check').length,2);assert.ok(data.rounds[0].report!.meetingResponses!.some(response=>response.fixTaskId===fix.id&&response.resolvedAt));assert.equal(await readFile(path.join(h.source,'a.txt'),'utf8'),'old-a');
    const ready=await h.waitFor(data=>Boolean(data.rounds[0].allowedActions?.find(action=>action.name==='projectFlow.round.accept')?.enabled));await h.accept(ready);await h.waitFor(data=>data.flow?.status==='completed');assert.equal(await readFile(path.join(h.source,'a.txt'),'utf8'),'fixed requirement');
  }finally{await h.dispose();}
});

test('a request outside the approved paths becomes a decision instead of silently expanding the task',async()=>{
  const h=await fixture({response:'in-scope-fix',paths:['outside.txt'],beforeConfirm:'方案确认前要求再加一个 outside.txt。'});try{
    h.release();const data=await h.waitFor(data=>data.decisions.some(decision=>decision.kind==='meeting-request'));
    assert.equal(data.tasks.some(task=>task.kind==='integration-fix'),false);assert.equal(data.rounds[0].report!.meetingResponses![0].disposition,'scope-change');assert.match(data.rounds[0].report!.remainingIssues.join('\n'),/outside/);await assert.rejects(access(path.join(h.source,'outside.txt')));await assert.rejects(h.accept(data),/先处理会议/);
  }finally{await h.dispose();}
});

test('chat arriving after a report prevents stale acceptance and is incorporated into a new report first',async()=>{
  const h=await fixture({response:'needs-user'});try{
    h.release();const old=await h.waitFor(data=>Boolean(data.rounds[0]?.allowedActions?.find(action=>action.name==='projectFlow.round.accept')?.enabled));await h.send('汇报之后新增的要求。');await assert.rejects(h.accept(old),/先补充汇报/);assert.equal(await readFile(path.join(h.source,'a.txt'),'utf8'),'old-a');
    const next=await h.waitFor(data=>data.rounds[0]?.status==='awaiting_acceptance'&&data.decisions.some(decision=>decision.kind==='meeting-request'));assert.match(next.rounds[0].report!.remainingIssues.join('\n'),/新增的要求/);assert.equal(h.calls.filter(call=>call.kind==='integration-check').length,1);assert.equal(h.calls.filter(call=>call.kind==='round-report').length,2);assert.equal(h.engine.store.roomView(h.roomId).messages.filter(message=>message.flowReport).length,2);
  }finally{await h.dispose();}
});

test('an unknown one-off mention is never replayed by resume or restart',async()=>{
  const h=await fixture({unknownMention:true});try{
    await h.send('@Claudia 进度？');await h.waitFor(()=>Boolean(h.engine.store.roomView(h.roomId).state.discussion?.unknownRunId));await h.engine.invoke('room.resume',{roomId:h.roomId,acknowledgeUnknown:true});await new Promise(resolve=>setTimeout(resolve,100));assert.equal(h.calls.filter(call=>call.kind==='room').length,1);
    h.release();await h.engine.close();let replayed=0;const restarted=new Engine(path.join(h.root,'data'),()=>{},()=>{},()=>({probe:async()=>{throw new Error('no probe');},start:async()=>{replayed++;return {};},stop:async()=>{}}));try{assert.equal(restarted.store.roomView(h.roomId).state.discussion!.mentionQueue?.length,0);assert.equal(replayed,0);}finally{await restarted.close();}
  }finally{await h.dispose();}
});

test('after acceptance a normal room turn catches up with unread messages without needing to resume a work-only wait',async()=>{
  const h=await fixture();try{
    await h.send('工作期间没有点名的历史发言。');h.release();const ready=await h.waitFor(data=>Boolean(data.rounds[0]?.allowedActions?.find(action=>action.name==='projectFlow.round.accept')?.enabled));await h.accept(ready);await h.waitFor(data=>data.flow?.status==='completed');
    await h.send('验收结束，继续讨论。');await h.waitFor(()=>h.engine.store.roomView(h.roomId).messages.some(message=>message.author!=='user'&&message.discussionId&&message.text==='验收后补读并讨论。'));
    const room=h.calls.find(call=>call.kind==='room')!;assert.notEqual(room.input.phase,'working-mention');assert.ok(room.input.messages.some((message:any)=>message.text.includes('历史发言')));
  }finally{await h.dispose();}
});

test('a report that omits a meeting requirement is corrected only once and then blocked, never accepted',async()=>{
  const h=await fixture({omitResponses:true});try{
    await h.send('这条会议要求不允许被汇报漏掉。');h.release();const data=await h.waitFor(data=>data.rounds[0]?.status==='blocked');assert.match(data.flow!.blockedReasons.join('\n'),/逐条处理/);assert.equal(h.calls.filter(call=>call.kind==='round-report').length,2);assert.equal(h.calls.filter(call=>call.kind==='submission').length,1);assert.equal(data.acceptances.length,0);assert.equal(await readFile(path.join(h.source,'a.txt'),'utf8'),'old-a');
  }finally{await h.dispose();}
});
