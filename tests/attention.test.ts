import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Engine } from './helpers/seeded-engine';
import { collectAttention } from '../src/backend/attention';
import type { AttentionSummary } from '../src/shared/attention';
import type { Adapter, AdapterContext, ProviderId, ProviderInfo, PushEvent, Run, Session } from '../src/shared/types';

async function wait(check:()=>unknown){for(let i=0;i<500;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('fixture did not settle');}
const info=(id:ProviderId):ProviderInfo=>({id,name:id,available:true,auth:'subscription',detail:'fixture only',runtimeReady:true,capabilities:{steer:false,cancel:'native',streaming:true,write:true,history:true}});
async function fixture(start?:(ctx:AdapterContext)=>ReturnType<Adapter['start']>,probe?:(id:ProviderId)=>ProviderInfo){
  const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM attention-')),projectDirectory=path.join(directory,'project');await mkdir(projectDirectory);await writeFile(path.join(projectDirectory,'file.txt'),'baseline');
  const pushes:PushEvent[]=[];let starts=0,probes=0;
  const engine=new Engine(path.join(directory,'data'),event=>pushes.push(event),()=>{},id=>({probe:async()=>{probes++;return probe?probe(id):info(id);},start:async ctx=>{starts++;if(start)return start(ctx);ctx.markDelivery('confirmed');ctx.emit('message','fixture result');return {};},stop:async()=>{}}),{roomRuntimeReuse:false});
  await engine.probe('codex');const project=await engine.invoke('project.create',{directory:projectDirectory,name:'测试项目'}) as {id:string};
  const session=engine.createSession(project.id,'codex','测试会话',false);engine.store.put('sessions',session.id,{...session,autoApprove:false});
  return {directory,projectDirectory,engine,session,pushes,starts:()=>starts,probes:()=>probes,attention:()=>engine.invoke('attention.list') as Promise<AttentionSummary>,async cleanup(){await engine.close();assert.ok(path.basename(directory).startsWith('AIROOM attention-'));await rm(directory,{recursive:true,force:true});}};
}

for(const type of ['question','approval'] as const)test(`pending ${type} appears on the first waiting snapshot and disappears after answering`,async()=>{
  const f=await fixture(async ctx=>{ctx.markDelivery('confirmed');await ctx.approve({type,title:'fixture request',detail:'请选择下一步',options:[{id:'answer',label:'继续'}]});ctx.emit('message','已回答');return {};});
  try{
    const sent=await f.engine.send(f.session.id,'fixture question') as {runId:string};await wait(()=>f.pushes.some(event=>event.type==='snapshot'&&event.snapshot.runs.some(run=>run.id===sent.runId&&run.status==='waiting_user')));
    const waiting=f.pushes.find(event=>event.type==='snapshot'&&event.snapshot.runs.some(run=>run.id===sent.runId&&run.status==='waiting_user'));
    assert.ok(waiting?.type==='snapshot');assert.equal(waiting.snapshot.attention?.counts[type],1);
    const queue=await f.attention(),item=queue.items.find(item=>item.kind===type)!;assert.ok(item.approvalId);assert.equal(item.sessionId,f.session.id);assert.equal(item.action.view,'session');
    const calls=f.starts(),checks=f.probes(),pushCount=f.pushes.length;
    for(let i=0;i<3;i++)await f.attention();assert.equal(f.starts(),calls);assert.equal(f.probes(),checks);assert.equal(f.pushes.length,pushCount,'listing must not mutate or broadcast');
    await f.engine.invoke('approval.answer',{id:item.approvalId,choice:'answer'});await wait(()=>f.engine.store.get<Run>('runs',sent.runId)?.status==='ended');assert.equal((await f.attention()).counts[type],0);
  }finally{await f.cleanup();}
});

test('pending plans remain actionable while dispatch is paused and disappear after confirmation or cancellation',async()=>{
  const f=await fixture();try{
    const at=new Date().toISOString(),store=f.engine.store;
    for(const id of ['a','b','cancelled']){
      store.put('project_flows',id,{id,projectId:f.session.projectId,status:id==='cancelled'?'cancelled':'awaiting_plan',dispatchMode:'paused',leadMemberId:'codex',createdAt:at,updatedAt:at});
      store.put('flow_plans',id,{id,projectId:f.session.projectId,flowId:id,version:1,status:'awaiting_confirmation',objective:'确认 '+id,updatedAt:at});
    }
    const first=await f.attention();assert.deepEqual(first.items.map(i=>i.id).sort(),['plan-confirmation:a','plan-confirmation:b']);
    assert.ok(first.items.every(i=>i.action.view==='project-room'&&i.projectId===f.session.projectId));assert.equal(f.starts(),0);
    store.put('flow_plans','a',{...store.get<any>('flow_plans','a'),status:'confirmed'});
    store.put('project_flows','a',{...store.get<any>('project_flows','a'),status:'active'});
    assert.deepEqual((await f.attention()).items.map(i=>i.id),['plan-confirmation:b']);
    store.put('project_flows','b',{...store.get<any>('project_flows','b'),status:'cancelled'});
    assert.equal((await f.attention()).total,0);assert.equal(f.starts(),0);
  }finally{await f.cleanup();}
});

test('unknown results stay visible without retries and disappear after an explicit new direction',async()=>{
  let turn=0;const f=await fixture(async ctx=>{turn++;ctx.markDelivery(turn===1?'sent':'confirmed');if(turn===1)return {unknown:true};ctx.emit('message','新方向已结束');return {};});
  try{
    const first=await f.engine.send(f.session.id,'uncertain') as {runId:string};await wait(()=>f.engine.store.get<Run>('runs',first.runId)?.status==='unknown');
    const queue=await f.attention();assert.equal(queue.counts.unknown,1);assert.equal(queue.items.find(item=>item.kind==='unknown')?.runId,first.runId);
    for(let i=0;i<3;i++)await f.attention();assert.equal(turn,1);
    const next=await f.engine.send(f.session.id,'明确的新方向','redirect') as {runId:string};await wait(()=>f.engine.store.get<Run>('runs',next.runId)?.status==='ended');
    assert.equal(f.engine.store.get<Run>('runs',first.runId)?.status,'unknown','historic receipts remain factual');assert.equal((await f.attention()).counts.unknown,0);assert.equal(turn,2);
  }finally{await f.cleanup();}
});

test('ignored reminders hide only the current notice, survive restart, and updated notices return',async()=>{
  const f=await fixture(async ctx=>{ctx.markDelivery('confirmed');return {unknown:true};});let reopened:Engine|undefined;
  try{
    const sent=await f.engine.send(f.session.id,'uncertain result') as {runId:string};await wait(()=>f.engine.store.get<Run>('runs',sent.runId)?.status==='unknown');
    const before=structuredClone(f.engine.store.get<Run>('runs',sent.runId)),block=structuredClone(f.engine.store.get('blocked_sessions',f.session.id));
    const item=(await f.attention()).items.find(i=>i.runId===sent.runId)!;
    await f.engine.invoke('attention.dismiss',{id:item.id,fingerprint:item.fingerprint});
    assert.equal((await f.attention()).counts.unknown,0);assert.deepEqual(f.engine.store.get('runs',sent.runId),before);assert.deepEqual(f.engine.store.get('blocked_sessions',f.session.id),block);assert.equal(f.starts(),1);
    await f.engine.close();reopened=new Engine(path.join(f.directory,'data'),()=>{},()=>{},()=>{throw Error('ignore must never contact a provider');});
    assert.equal((await reopened.invoke('attention.list') as AttentionSummary).counts.unknown,0);assert.deepEqual(reopened.store.get('runs',sent.runId),before);
    reopened.store.put('runs',sent.runId,{...before,updatedAt:new Date(Date.now()+1000).toISOString()});
    const changed=(await reopened.invoke('attention.list') as AttentionSummary).items.find(i=>i.runId===sent.runId)!;assert.ok(changed);
    await assert.rejects(reopened.invoke('attention.dismiss',{id:item.id,fingerprint:item.fingerprint}),/已变化|重新/);
    assert.equal((await reopened.invoke('attention.list') as AttentionSummary).counts.unknown,1);
  }finally{await reopened?.close();await f.cleanup();}
});

test('ignoring an approval keeps the request pending and the executor waiting for its real answer',async()=>{
  const f=await fixture(async ctx=>{ctx.markDelivery('confirmed');await ctx.approve({type:'approval',title:'fixture permission',detail:'等待决定',options:[{id:'allow',label:'允许'}]});return {};});
  try{
    const sent=await f.engine.send(f.session.id,'permission') as {runId:string};await wait(()=>f.pushes.some(event=>event.type==='snapshot'&&event.snapshot.runs.some(run=>run.id===sent.runId&&run.status==='waiting_user')));
    const item=(await f.attention()).items.find(i=>i.kind==='approval')!;
    await f.engine.invoke('attention.dismiss',{id:item.id,fingerprint:item.fingerprint});
    assert.equal((await f.attention()).counts.approval,0);assert.equal(f.engine.store.get<any>('approvals',item.approvalId!)?.state,'pending');assert.equal(f.engine.store.get<Run>('runs',sent.runId)?.status,'waiting_user');assert.equal(f.starts(),1);
    await f.engine.invoke('approval.answer',{id:item.approvalId,choice:'allow'});await wait(()=>f.engine.store.get<Run>('runs',sent.runId)?.status==='ended');
  }finally{await f.cleanup();}
});

test('ended roundtable and removed project owners leave no stale reminders and keep unknown history intact',async()=>{
  const f=await fixture();try{
    const store=f.engine.store,at='2026-10-07T15:39:24.253Z',projectId='roundtable-topic',topicId='topic',reviewId='review',sessionId='joint-session';
    store.put('projects',projectId,{id:projectId,kind:'roundtable',roomId:'roundtable:topic',name:'历史圆桌',directory:f.projectDirectory,createdAt:at,collaborationPaused:false});
    store.put('roundtable_topics',topicId,{id:topicId,projectId,roomId:'roundtable:topic',reviewId,status:'blocked'});
    store.put('flow_joint_reviews',reviewId,{id:reviewId,projectId,roundtableTopicId:topicId,status:'blocked',updatedAt:at});
    store.put('sessions',sessionId,{...f.session,id:sessionId,projectId,purpose:'flow-joint-review'});
    const run={id:'historic-unknown',sessionId,projectId,provider:'codex',revision:1,status:'unknown',delivery:'confirmed',flowOperationId:'historic-op',createdAt:at,updatedAt:at,completedAt:at};
    store.put('runs',run.id,run);store.put('blocked_sessions',sessionId,{runId:run.id});store.put('flow_operations','historic-op',{id:'historic-op',projectId,jointReviewId:reviewId,state:'blocked'});
    assert.ok((await f.attention()).items.some(i=>i.runId===run.id));
    store.put('roundtable_topics',topicId,{...store.get<any>('roundtable_topics',topicId),status:'ended'});store.put('flow_joint_reviews',reviewId,{...store.get<any>('flow_joint_reviews',reviewId),status:'cancelled'});
    assert.ok(!(await f.attention()).items.some(i=>i.projectId===projectId));assert.deepEqual(store.get('runs',run.id),run);
    store.put('flow_decisions','orphan',{id:'orphan',projectId:'removed-project',flowId:'removed-flow',status:'open',title:'已删项目的决策',reason:'历史',updatedAt:at});
    store.put('project_flows','removed-flow',{id:'removed-flow',projectId:'removed-project',status:'active'});
    assert.ok(!(await f.attention()).items.some(i=>i.projectId==='removed-project'));assert.equal(f.starts(),0);
  }finally{await f.cleanup();}
});

test('project and topic deletion remove their dismissal records without deleting other reminders',async()=>{
  const f=await fixture();try{
    const store=f.engine.store,threadId=store.currentRoomThread().id,at=new Date().toISOString();
    const sourceRun={sessionId:f.session.id,projectId:f.session.projectId,provider:'codex',revision:1,delivery:'confirmed',createdAt:at,updatedAt:at,completedAt:at,origin:{threadId}};
    store.put('runs','deleted-topic-unknown',{...sourceRun,id:'deleted-topic-unknown',status:'unknown'});store.put('blocked_sessions',f.session.id,{runId:'deleted-topic-unknown'});
    store.put('runs','deleted-topic-result',{...sourceRun,id:'deleted-topic-result',status:'ended',workspaceUndo:{status:'available',changes:1}});
    store.put('room_messages','dismiss-question',{id:'dismiss-question',threadId,author:'codex',text:'这个历史问题已不需要回答',at});
    store.put('room','state',{...store.roomState(),discussion:{id:'dismiss-discussion',phase:'waiting_user',questions:[{id:'dismiss-q',from:'codex',to:'user',text:'这个历史问题已不需要回答',messageId:'dismiss-question'}]}});
    const item=(await f.attention()).items.find(i=>i.kind==='question')!;await f.engine.invoke('attention.dismiss',{id:item.id,fingerprint:item.fingerprint});
    assert.equal(store.list('attention_dismissals').length,1);
    await f.engine.invoke('room.archive',{title:'新话题',inherit:false});await f.engine.invoke('room.delete',{threadId});assert.equal(store.list('attention_dismissals').length,0);
    assert.ok(!(await f.attention()).items.some(i=>i.runId?.startsWith('deleted-topic-')),'removing the source topic removes its reminders even when ordinary project run history is retained');assert.equal(store.get<Run>('runs','deleted-topic-unknown')?.status,'unknown');
    store.put('attention_dismissals','project-notice',{id:'project-notice',projectId:f.session.projectId,fingerprint:'saved',dismissedAt:at});
    store.put('attention_dismissals','other-notice',{id:'other-notice',projectId:'other-project',fingerprint:'saved',dismissedAt:at});
    await f.engine.invoke('project.remove',{projectId:f.session.projectId,discardWorkspaces:false});
    assert.deepEqual(store.list<any>('attention_dismissals').map(i=>i.id),['other-notice']);assert.ok(!(await f.attention()).items.some(i=>i.projectId===f.session.projectId));assert.equal(f.starts(),0);
  }finally{await f.cleanup();}
});

test('confirmed signed-out accounts are grouped by executor; unavailable or stale checks do not invent a login request',async()=>{
  const f=await fixture(undefined,id=>({...info(id),available:false,auth:id==='codex'?'none':'unknown'}));try{
    await f.engine.probe('codex');await f.engine.probe('claude');
    f.engine.store.put('members','m-second',{...f.engine.store.members().find(member=>member.id==='codex')!,id:'m-second',name:'另一个 Codex 成员',builtIn:false});
    const queue=await f.attention();assert.equal(queue.counts.login,1);const login=queue.items.find(item=>item.kind==='login')!;assert.equal(login.provider,'codex');assert.equal(login.action.view,'member-settings');
    const stale=collectAttention(f.engine.store,f.engine.snapshot().providers.map(provider=>({...provider,stale:true})),new Set());
    assert.equal(stale.counts.login,0,'a stale signed-out record waits for confirmation');
  }finally{await f.cleanup();}
});

test('room questions exclude answered or expired items and old partial discussion records remain readable',async()=>{
  const f=await fixture();try{
    const state=f.engine.store.roomState(),threadId=f.engine.store.currentRoomThread().id;
    const question={from:'codex',to:'user',text:'请确认范围',messageId:'question-message'};
    f.engine.store.put('room','state',{...state,discussion:{id:'room-discussion',phase:'waiting_user',questions:[{...question,id:'waiting'},{...question,id:'answered',answeredBy:'answer'},{...question,id:'expired',expiredBy:'later'}],reviewRequired:['codex']} as any});
    const queue=await f.attention();assert.equal(queue.counts.question,1);assert.equal(queue.counts.acceptance,1);
    const item=queue.items.find(item=>item.kind==='question')!;assert.equal(item.threadId,threadId);assert.equal(item.messageId,'question-message');assert.equal(item.action.view,'room');
    f.engine.store.put('room','state',{...state,discussion:{id:'legacy',phase:'paused'} as any});assert.equal((await f.attention()).total,0);assert.equal(f.engine.snapshot().attention?.total,0);assert.equal(f.starts(),0);
  }finally{await f.cleanup();}
});

test('personal desk results do not invent project acceptance and original validation/history remain intact',async()=>{
  const f=await fixture();try{
    const at=new Date().toISOString();
    const seed=(id:string,changes:Partial<Run>={})=>{const run:Run={id,sessionId:f.session.id,projectId:f.session.projectId,provider:'codex',revision:1,status:'ended',delivery:'confirmed',input:id,bootId:f.engine.bootId,createdAt:at,updatedAt:at,completedAt:at,...changes};f.engine.store.put('runs',id,run);};
    const changed={workspaceUndo:{status:'available' as const,changes:2}};
    seed('waiting',changed);seed('answer-only');seed('no-change',{workspaceUndo:{status:'none'}});seed('validated',{status:'completed',validation:'核对完毕',...changed});seed('undone',{workspaceUndo:{status:'undone'}});seed('returned',changed);
    const threadId=f.engine.store.currentRoomThread().id;
    f.engine.store.put('room_messages','returned-note',{id:'returned-note',threadId,author:'system',system:true,text:'已打回',at,link:{projectId:f.session.projectId,sessionId:f.session.id,runId:'returned',outcome:'ended',verdict:'returned'}});
    assert.deepEqual((await f.attention()).items.filter(item=>item.kind==='acceptance').map(item=>item.runId),[]);
    assert.equal(f.engine.store.get<Run>('runs','waiting')?.status,'ended','the presentation change does not rewrite historical results');
    await f.engine.invoke('run.validate',{runId:'waiting',validation:'已打开产物核对'});assert.equal((await f.attention()).counts.acceptance,0);
    seed('restored',changed);f.engine.store.put('sessions',f.session.id,{...f.session,restoredHistoryOnly:true});assert.equal((await f.attention()).total,0);
    f.engine.store.put('sessions',f.session.id,{...f.session,archived:true});assert.equal((await f.attention()).total,0);
    assert.equal(f.starts(),0);
  }finally{await f.cleanup();}
});

test('an expired review navigates to its warning instead of presenting the old report as valid acceptance',async()=>{
  const f=await fixture();try{
    const at=new Date().toISOString(),threadId=f.engine.store.currentRoomThread().id;
    f.engine.store.put('runs','review',{id:'review',sessionId:f.session.id,projectId:f.session.projectId,provider:'codex',revision:1,status:'ended',delivery:'confirmed',input:'复核',bootId:f.engine.bootId,createdAt:at,updatedAt:at,completedAt:at,workspaceUndo:{status:'available',changes:1}});
    f.engine.store.put('room_messages','review-note',{id:'review-note',threadId,author:'system',system:true,text:'复核报告',at,link:{projectId:f.session.projectId,sessionId:f.session.id,runId:'review',outcome:'ended',reviewStale:at}});
    const item=(await f.attention()).items.find(item=>item.kind==='acceptance')!;assert.equal(item.action.view,'room');assert.equal(item.messageId,'review-note');assert.match(item.detail,/旧结论已过期/);
  }finally{await f.cleanup();}
});

test('observed merge conflicts persist across backend restarts and clear after a successful retry',async()=>{
  const f=await fixture(async ctx=>{ctx.markDelivery('confirmed');await writeFile(path.join(ctx.cwd,'file.txt'),'member edit');ctx.emit('message','已改文件');return {};});let reopened:Engine|undefined;
  try{
    f.engine.store.put('sessions',f.session.id,{...f.session,writeMode:true,autoApprove:false});
    const sent=await f.engine.send(f.session.id,'change file') as {runId:string};await wait(()=>f.engine.store.get<Run>('runs',sent.runId)?.status==='ended');
    await writeFile(path.join(f.projectDirectory,'file.txt'),'human edit');
    const result=await f.engine.invoke('workspace.apply',{sessionId:f.session.id}) as {conflicts:unknown[]};assert.equal(result.conflicts.length,1);assert.equal(await readFile(path.join(f.projectDirectory,'file.txt'),'utf8'),'human edit');
    assert.equal((await f.attention()).counts['merge-conflict'],1);
    await f.engine.close();reopened=new Engine(path.join(f.directory,'data'),()=>{},()=>{},()=>{throw new Error('no provider use is allowed');});
    assert.equal((await reopened.invoke('attention.list') as AttentionSummary).counts['merge-conflict'],1);
    await writeFile(path.join(f.projectDirectory,'file.txt'),'baseline');await reopened.invoke('workspace.apply',{sessionId:f.session.id});
    assert.equal(await readFile(path.join(f.projectDirectory,'file.txt'),'utf8'),'member edit');assert.equal((await reopened.invoke('attention.list') as AttentionSummary).counts['merge-conflict'],0);
  }finally{await reopened?.close();await f.cleanup();}
});
