import './helpers/meeting-controls-harness';
import test from 'node:test';
import assert from 'node:assert/strict';
import type {FlowOperation} from '../src/shared/project-flow';
import type {Run} from '../src/shared/types';
import {callUsage,callUsageLabel} from '../src/shared/call-usage';
import {meetingHarness,until} from './helpers/meeting-controls-harness';
import {roundtableHarness} from './helpers/roundtable-harness';
import {opinion} from './helpers/joint-review-harness';
import {NativeResponseError} from '../src/backend/adapter-failure';

test('default meeting uses exactly three calls, treats a closure proposal as prose and waits for the next human message',async()=>{
  const h=await meetingHarness(c=>c.ctx.session.purpose==='room-minutes'?undefined:{version:1,turn:c.input.turn,revision:c.input.revision,action:'propose',body:'可以收尾。'});
  try{await h.start('global',{handRaise:false});await until(()=>!h.engine.store.roomState().active&&h.engine.store.roomState().discussion?.phase==='waiting_user');
    assert.deepEqual(h.speech().map(c=>c.input.you),['claude','codex','dsh']);assert.equal(h.calls.length,3);assert.equal(h.engine.store.roomState().discussion!.proposal,undefined);
    assert.equal(h.engine.snapshot().room.state.discussion!.callUsage!.total,3);assert.equal(h.engine.snapshot().room.state.discussion!.callUsage!.completed,3);
    const count=h.calls.length;await new Promise(r=>setTimeout(r,40));assert.equal(h.calls.length,count);
    await h.start('global',{text:'下一条问题',handRaise:false});await until(()=>h.calls.length===6&&!h.engine.store.roomState().active);assert.deepEqual(h.speech().slice(3).map(c=>c.input.you),['claude','codex','dsh']);
  }finally{await h.dispose();}
});

test('host choice supplements only once, polls only the other two and zero votes wait without extra speech',async()=>{
  let polls=0;const h=await meetingHarness(c=>{if(c.ctx.session.purpose==='room-hand')return {want:++polls<=3?1:0,why:'本轮意见'};});
  try{await h.start();await until(()=>h.engine.store.roomState().discussion?.phase==='awaiting-host');const d=h.engine.store.roomState().discussion!;
    assert.equal(h.calls.length,6);await h.engine.invoke('room.host',{discussionId:d.id,revision:d.revision,handRoundId:d.handRound!.id,choice:'member',memberId:'codex'});
    await until(()=>h.engine.store.roomState().discussion?.phase==='waiting_user'&&!h.engine.store.roomState().active);
    assert.deepEqual(h.speech().map(c=>c.input.you),['claude','codex','dsh','codex']);assert.equal(h.calls.length,9);
    assert.deepEqual(h.calls.filter(c=>c.ctx.session.purpose==='room-hand').slice(3).map(c=>c.ctx.session.memberId??c.ctx.session.provider).sort(),['claude','dsh']);
    assert.equal(h.engine.snapshot().room.state.discussion!.callUsage!.total,9);
  }finally{await h.dispose();}
});

test('single-member meetings suppress hands and auto-selected supplements are finite',async()=>{
  const h=await meetingHarness();try{await h.start('global',{memberIds:['codex'],handRaise:true});await until(()=>h.engine.store.roomState().discussion?.phase==='waiting_user');assert.equal(h.calls.length,1);assert.equal(h.engine.store.roomState().discussion!.handRaise,false);
    await h.engine.invoke('room.archive',{});await h.start('global',{hostPick:false});await until(()=>h.engine.store.roomState().discussion?.phase==='waiting_user'&&!h.engine.store.roomState().active);
    const speech=h.speech().slice(1);assert.equal(speech.length,6);assert.equal(new Set(speech.slice(3).map(c=>c.input.you)).size,3);assert.equal(h.calls.filter(c=>c.ctx.session.purpose==='room-hand').length,6);
  }finally{await h.dispose();}
});

test('meeting format correction has a separate real run receipt and count',async()=>{
  let attempts=0;const h=await meetingHarness(c=>c.input.you==='claude'&&++attempts===1?{version:1,turn:c.input.turn,revision:c.input.revision,action:'pass',body:''}:undefined);
  try{await h.start('global',{handRaise:false});await until(()=>h.engine.store.roomState().discussion?.phase==='waiting_user'&&!h.engine.store.roomState().active);const usage=h.engine.snapshot().room.state.discussion!.callUsage!;
    assert.equal(usage.total,4);assert.equal(usage.corrections,1);assert.equal(usage.completed,4);assert.equal(h.engine.store.list<Run>('runs').filter(r=>r.origin?.callKind==='correction').length,1);
  }finally{await h.dispose();}
});

test('undelivered failures are separate from completed calls and unknown is never called successful',()=>{
  const runs=[{id:'a',status:'failed',delivery:'prepared'},{id:'b',status:'ended',delivery:'confirmed',origin:{callKind:'retry'}},{id:'c',status:'unknown',delivery:'confirmed'},{id:'d',status:'ended',delivery:'confirmed',origin:{callKind:'correction'}}] as Run[];
  const usage=callUsage([...runs,runs[0]]);assert.deepEqual(usage,{total:4,delivered:3,completed:2,notSent:1,withdrawn:0,unknown:1,corrections:1,retries:1});assert.match(callUsageLabel(usage,3),/累计尝试 4 次 · 已发出 3 次 · 已完成 2 次 · 基础预计 3 次.*未发出失败 1 次.*结果未知 1 次/);
});

test('a confirmed connection failure is skipped in a meeting without retrying it or blocking the remaining seats',async()=>{
  const h=await meetingHarness(c=>{if(c.input.you==='claude')throw new NativeResponseError('Connection refused ECONNREFUSED');});
  try{await h.start('global',{handRaise:false});await until(()=>h.engine.store.roomState().discussion?.phase==='waiting_user'&&!h.engine.store.roomState().active);
    assert.deepEqual(h.speech().map(c=>c.input.you),['claude','codex','dsh']);const runs=h.engine.store.list<Run>('runs');assert.equal(runs.length,3);assert.equal(runs.filter(r=>r.status==='failed'&&r.delivery==='confirmed').length,1);assert.equal(runs.filter(r=>r.origin?.callKind==='retry').length,0);
    assert.match(h.engine.store.allRoomMessages(h.engine.store.currentRoomThread().id).find(m=>m.author==='claude')!.text,/本轮先继续其他成员，没有自动重发/);
  }finally{await h.dispose();}
});

test('an unconfirmed connection loss isolates that member and never retries the missing reply while peers continue',async()=>{
  const h=await meetingHarness(c=>{if(c.input.you==='claude')throw new Error('socket disconnected');});
  try{await h.start('global',{handRaise:false});await until(()=>h.engine.store.roomState().discussion?.phase==='waiting_user'&&!h.engine.store.roomState().active);
    assert.equal(h.calls.length,3);assert.equal(h.calls.filter(c=>c.input.you==='claude').length,1);const run=h.engine.store.list<Run>('runs')[0];assert.equal(run.status,'unknown');assert.equal(h.engine.store.roomState().discussion!.unknownRunId,run.id);
  }finally{await h.dispose();}
});

test('roundtable rewrites only the failed slot, preserves its old operations and keeps peer candidates',async()=>{
  let failed=true;const h=await roundtableHarness({handler:async c=>{if(c.kind==='joint-independent'&&(c.ctx.session.memberId??c.ctx.session.provider)==='codex'&&failed)return {wrong:'invalid'};}});
  try{const t=(await h.open({kind:'proposals',memberIds:['claude','codex'],peerReview:false})).topic;let d=await h.wait(t.id,d=>d.topic.status==='blocked'&&Boolean(d.review?.slots.some(s=>s.memberId==='claude'&&s.status==='completed')));const bad=d.review!.slots.find(s=>s.memberId==='codex')!,good=d.review!.slots.find(s=>s.memberId==='claude')!,opId=bad.operationId!;
    await h.wait(t.id,d=>d.review!.slots.find(s=>s.id===bad.id)?.recovery?.canRetry===true);const before=h.calls.length;failed=false;
    await h.act(t.id,'resolve',{slotId:bad.id,choice:'retry',evidence:'格式错误，重新准备这一份。'});d=await h.wait(t.id,d=>d.review?.review.status==='awaiting_decision');
    const retried=d.review!.slots.find(s=>s.id===bad.id)!;assert.equal(retried.previousAttempts?.[0].operationId,opId);assert.notEqual(retried.operationId,opId);assert.ok(h.engine.store.get<FlowOperation>('flow_operations',opId));
    assert.equal(d.review!.slots.find(s=>s.id===good.id)?.operationId,good.operationId);assert.equal(h.calls.slice(before).filter(c=>c.kind==='joint-independent').length,1);assert.equal(d.callUsage!.total,h.engine.store.list<Run>('runs').filter(r=>r.projectId===t.projectId).length);
  }finally{await h.dispose();}
});

test('roundtable topic usage includes isolated deliberation and minutes sessions, excluding a different thread',async()=>{
  const h=await roundtableHarness();try{
    const t=(await h.open({memberIds:['claude'],peerReview:false})).topic;
    const before=(await h.wait(t.id,d=>d.review?.review.status==='awaiting_decision')).callUsage!.total;
    const session=h.engine.store.list<any>('sessions')[0];
    h.engine.store.put('sessions','deliberation-session',{...session,id:'deliberation-session',roomId:t.roomId,roomThreadId:t.id});
    h.engine.store.put('sessions','other-thread',{...session,id:'other-thread',roomId:t.roomId,roomThreadId:'another-topic'});
    for(const [id,sessionId] of [['deliberation','deliberation-session'],['minutes','deliberation-session'],['foreign','other-thread']])h.engine.store.put('runs',id,{id,sessionId,projectId:'room-lounge-isolated',status:'ended',delivery:'confirmed'});
    const after=(await h.get(t.id)).callUsage!;assert.equal(after.total,before+2);assert.equal(after.completed>=2,true);
  }finally{await h.dispose();}
});

test('skipping a failed independent slot retains one good candidate and marks the missing contribution in summary and outcome',async()=>{
  const h=await roundtableHarness({handler:async c=>c.kind==='joint-independent'&&(c.ctx.session.memberId??c.ctx.session.provider)==='codex'?{wrong:'invalid'}:undefined});
  try{const t=(await h.open({kind:'proposals',memberIds:['claude','codex'],peerReview:true})).topic;let d=await h.wait(t.id,d=>d.topic.status==='blocked'&&d.review!.slots.some(s=>s.memberId==='claude'&&s.status==='completed'));const bad=d.review!.slots.find(s=>s.memberId==='codex')!;
    await h.wait(t.id,d=>d.review!.slots.find(s=>s.id===bad.id)?.recovery?.canSkip===true);await h.act(t.id,'resolve',{slotId:bad.id,choice:'skip',evidence:'保留 Claudia 已完成稿件。'});d=await h.wait(t.id,d=>d.review?.review.status==='awaiting_decision');
    assert.equal(d.review!.decisions.find(x=>x.kind==='candidate')!.candidateSlotIds.length,1);assert.equal(h.calls.filter(c=>c.kind==='joint-peer').length,0);assert.match(d.review!.review.conclusion!.summary,/Gptia.*未完成.*已跳过/);
    const summary=h.calls.find(c=>c.kind==='joint-summary')!;assert.equal(summary.material.candidates.length,1);assert.equal(summary.material.skipped.length,1);await h.choose(t.id);assert.equal((await h.get(t.id)).review!.review.outcome,'inconclusive');
  }finally{await h.dispose();}
});

test('unknown complete reply requires explicit adoption, keeps the run unknown and does not dispatch it again',async()=>{
  let sent=false;const h=await roundtableHarness({handler:async c=>{if(c.kind==='joint-independent'&&(c.ctx.session.memberId??c.ctx.session.provider)==='codex'&&!sent){sent=true;c.ctx.emit('delta',JSON.stringify({protocol:'airoom.project-flow',version:1,kind:c.kind,payload:opinion('codex',true)}));return {nativeResult:{unknown:true}};}}});
  try{const t=(await h.open({kind:'proposals',memberIds:['claude','codex'],peerReview:false})).topic;let d=await h.wait(t.id,d=>d.topic.status==='blocked'&&d.review!.slots.some(s=>s.memberId==='claude'&&s.status==='completed'));const bad=d.review!.slots.find(s=>s.memberId==='codex')!,op=h.engine.store.get<FlowOperation>('flow_operations',bad.operationId!)!,runId=op.runId!;
    await h.wait(t.id,d=>d.review!.slots.find(s=>s.id===bad.id)?.recovery?.canAdopt===true);assert.equal(h.engine.store.get<Run>('runs',runId)!.status,'unknown');
    await assert.rejects(h.act(t.id,'resolve',{slotId:bad.id,choice:'adopt',evidence:'核对完整回复'}),/明确确认/);await assert.rejects(h.act(t.id,'resolve',{slotId:bad.id,choice:'retry',evidence:'重写'}),/重复执行/);
    const before=h.calls.length;await h.act(t.id,'resolve',{slotId:bad.id,choice:'adopt',evidence:'核对完整原文并采用',acknowledgeUnknown:true});d=await h.wait(t.id,d=>d.review?.review.status==='awaiting_decision');
    assert.equal(h.engine.store.get<Run>('runs',runId)!.status,'unknown');assert.equal(d.review!.slots.find(s=>s.id===bad.id)?.acceptedByUser?.runId,runId);assert.equal(h.calls.slice(before).filter(c=>c.kind==='joint-independent').length,0);
  }finally{await h.dispose();}
});
