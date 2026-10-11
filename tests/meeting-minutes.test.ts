import './helpers/meeting-controls-harness';
import test from 'node:test';
import assert from 'node:assert/strict';
import type {Project,RoomId,RoomMessage} from '../src/shared/types';
import type {ProjectFlowSnapshot} from '../src/shared/project-flow';
import {meetingHarness,until} from './helpers/meeting-controls-harness';

const request=async(h:Awaited<ReturnType<typeof meetingHarness>>,roomId:RoomId='global',extra:Record<string,unknown>={})=>{const d=h.engine.store.roomState(roomId).discussion!;return h.engine.invoke('room.minutes',{roomId,discussionId:d.id,revision:d.revision,...extra});};

test('explicit minutes stops the current speech, uses one new call and ends by the user without invented consensus',async()=>{
  let held:Parameters<NonNullable<Parameters<typeof meetingHarness>[0]>>[0]|undefined;
  const h=await meetingHarness(async c=>{if(c.prompt.includes('AIROOM_CONTEXT')&&!['room-hand','room-minutes'].includes(c.ctx.session.purpose??'')&&h.speech().length>3){held=c;await new Promise<void>(r=>c.release=r);}});
  try{
    await assert.rejects(h.engine.invoke('room.minutes',{discussionId:'absent',revision:0}),/更新/);await h.start();await until(()=>h.engine.store.roomState().discussion?.phase==='awaiting-host');
    const d=h.engine.store.roomState().discussion!;const before=h.calls.length;
    await assert.rejects(h.engine.invoke('room.minutes',{discussionId:d.id,revision:d.revision-1}),/更新/);
    await assert.rejects(request(h,'global',{memberId:'absent'}),/在场/);assert.equal(h.calls.length,before);
    await h.engine.invoke('room.host',{discussionId:d.id,revision:d.revision,handRoundId:d.handRound!.id,choice:'member',memberId:'claude'});await until(()=>Boolean(held));
    const calls=h.calls.length;await request(h);await until(()=>h.engine.store.roomState().discussion?.phase==='idle');
    assert.equal(held!.stopped,true);assert.equal(h.calls.length,calls+1);
    const summary=h.calls.find(c=>c.ctx.session.purpose==='room-minutes')!;assert.equal(summary.ctx.session.memberId??summary.ctx.session.provider,'claude');assert.equal(summary.ctx.session.writeMode,false);
    assert.equal(summary.input.endedBy,'user');assert.equal(summary.input.interruptedSpeech,true);assert.equal(summary.input.proposal,undefined);assert.match(summary.prompt,/不代表成员一致同意/);assert.match(summary.prompt,/正在进行的发言已先中止/);
    const completed=h.engine.store.roomState().discussion!;assert.equal(completed.endedBy,'user');assert.equal(completed.meetingMinutes!.status,'done');
    assert.equal(h.engine.store.get<RoomMessage>('room_messages',completed.meetingMinutes!.messageId!)!.kind,'summary');
  }finally{await h.dispose();}
});

test('new human input invalidates explicit minutes and does not accept a late native summary',async()=>{
  const h=await meetingHarness(async c=>{if(c.ctx.session.purpose==='room-minutes')await new Promise<void>(r=>c.release=r);});
  try{
    await h.start();await until(()=>h.engine.store.roomState().discussion?.phase==='awaiting-host');await request(h);
    await until(()=>h.calls.some(c=>c.ctx.session.purpose==='room-minutes'));const summary=h.calls.find(c=>c.ctx.session.purpose==='room-minutes')!,messageId=h.engine.store.roomState().discussion!.meetingMinutes!.messageId!;
    await h.start('global',{text:'新增要求：请重新讨论读者偏好'});summary.release();await until(()=>h.engine.store.roomState().discussion?.phase==='awaiting-host');
    const state=h.engine.store.roomState().discussion!;assert.equal(state.meetingMinutes!.status,'stale');assert.notEqual(state.endedBy,'user');
    const record=h.engine.store.get<RoomMessage>('room_messages',messageId)!;assert.equal(record.discussionStale,true);assert.notEqual(record.status,'done');assert.equal(record.text,'');
    assert.equal(h.calls.filter(c=>c.ctx.session.purpose==='room-minutes').length,1);
  }finally{await h.dispose();}
});

test('stopping explicit minutes pauses the meeting and an explicit new request can rewrite once',async()=>{
  let summaries=0;const h=await meetingHarness(async c=>{if(c.ctx.session.purpose==='room-minutes'&&++summaries===1)await new Promise<void>(r=>c.release=r);});
  try{
    await h.start();await until(()=>h.engine.store.roomState().discussion?.phase==='awaiting-host');await request(h);await until(()=>summaries===1);
    await h.engine.invoke('room.stop');await until(()=>!h.engine.store.roomState().active&&h.engine.store.roomState().discussion?.meetingMinutes?.status==='stopped');
    assert.equal(h.engine.store.roomState().discussion!.phase,'paused');const count=h.calls.length;await new Promise(r=>setTimeout(r,50));assert.equal(h.calls.length,count);
    await request(h,'global',{memberId:'codex'});await until(()=>h.engine.store.roomState().discussion?.phase==='idle');
    assert.equal(h.calls.length,count+1);assert.equal(summaries,2);assert.equal(h.engine.store.roomState().discussion!.endedBy,'user');
    assert.equal(h.engine.store.roomState().discussion!.meetingMinutes!.memberId,'codex');
  }finally{await h.dispose();}
});

test('a second stop while a minutes request is stopping speech withdraws its pending dispatch',async()=>{
  const h=await meetingHarness(),runtimes=(h.engine as any).roomRuntimes,original=runtimes.closeSession;let held=false,release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
  runtimes.closeSession=async function(...args:any[]){if(!held){held=true;entered();await gate;}return original.apply(this,args);};
  try{
    await h.start();await until(()=>h.engine.store.roomState().discussion?.phase==='awaiting-host');const count=h.calls.length;
    const pending=request(h);const rejected=assert.rejects(pending,/更新|旧请求/);await ready;await h.engine.invoke('room.stop');release();await rejected;
    assert.equal(h.calls.length,count);assert.equal(h.engine.store.roomState().discussion!.phase,'paused');
    assert.equal(h.calls.filter(c=>c.ctx.session.purpose==='room-minutes').length,0);
  }finally{release();runtimes.closeSession=original;await h.dispose();}
});

test('project minutes default to the current lead and become background for the next plan draft',async()=>{
  const h=await meetingHarness();try{
    const project=await h.engine.invoke('project.create',{directory:h.directory,name:'策划项目'}) as Project;await h.engine.invoke('project.update',{projectId:project.id,memberIds:['claude','codex','dsh']});
    await h.engine.invoke('projectFlow.start',{requestId:'minutes-project-plan',projectId:project.id,leadMemberId:'dsh',memberIds:['claude','codex','dsh'],topic:'活动策划'});
    let flow:ProjectFlowSnapshot|undefined;await until(()=>{const plan=h.engine.store.list<any>('flow_plans').at(-1);return Boolean(plan?.status==='awaiting_confirmation');});flow=await h.engine.invoke('projectFlow.get',{projectId:project.id}) as ProjectFlowSnapshot;
    const roomId=`project:${project.id}` as const;await h.start(roomId);await until(()=>h.engine.store.roomState(roomId).discussion?.phase==='awaiting-host');await request(h,roomId);await until(()=>h.engine.store.roomState(roomId).discussion?.phase==='idle');
    const summary=h.calls.find(c=>c.ctx.session.purpose==='room-minutes')!;assert.equal(summary.ctx.session.memberId??summary.ctx.session.provider,'dsh');assert.equal(summary.ctx.session.writeMode,false);
    assert.equal((await h.engine.invoke('projectFlow.get',{projectId:project.id}) as ProjectFlowSnapshot).plan!.revision,flow.plan!.revision);
    await h.engine.invoke('projectFlow.plan.revise',{requestId:'minutes-project-revision',planId:flow.plan!.id,expectedRevision:flow.plan!.revision,instruction:'根据最新会议纪要改写方案'});
    await until(()=>h.calls.filter(c=>c.kind==='plan').length===2);assert.match(h.calls.filter(c=>c.kind==='plan').at(-1)!.prompt,/结论和分歧依实际记录保留/);
  }finally{await h.dispose();}
});
