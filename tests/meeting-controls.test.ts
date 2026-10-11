import './helpers/meeting-controls-harness';
import test from 'node:test';
import assert from 'node:assert/strict';
import type {Project,Session,Run,RoomState} from '../src/shared/types';
import type {ProjectFlowSnapshot} from '../src/shared/project-flow';
import {meetingHarness,until} from './helpers/meeting-controls-harness';

test('a failed host-selected response receives one repair, then only the remaining members may raise hands',async()=>{
  const h=await meetingHarness(c=>c.input.you==='codex'&&h.speech().length>3?{version:1,turn:c.input.turn,revision:c.input.revision,action:'pass',body:''}:undefined);
  try{await h.start();await until(()=>h.engine.store.roomState().discussion?.phase==='awaiting-host');const first=h.engine.store.roomState().discussion!;await h.engine.invoke('room.host',{discussionId:first.id,revision:first.revision,handRoundId:first.handRound!.id,choice:'member',memberId:'codex'});await until(()=>h.engine.store.roomState().discussion?.phase==='awaiting-host'&&h.engine.store.roomState().discussion!.handRound!.id!==first.handRound!.id);assert.deepEqual(h.speech().slice(3).map(c=>c.input.you),['codex','codex']);assert.deepEqual(Object.keys(h.engine.store.roomState().discussion!.handRound!.ballots).sort(),['claude','dsh']);assert.ok(h.engine.snapshot().room.messages.some(m=>m.author==='codex'&&m.status==='failed'&&m.text.includes('这次没能回答')));assert.ok(h.engine.store.roomState().discussion!.skippedMembers?.codex);}
  finally{await h.dispose();}
});

test('member stop preserves peer meeting turns and a streaming update does not change the confirmed run list',async()=>{
  const h=await meetingHarness(async c=>{if(c.input.you==='claude'&&c.prompt.includes('\nAIROOM_CONTEXT\n'))await new Promise<void>(r=>c.release=r);});
  try{await h.start();await until(()=>h.speech().length===1);const preview=await h.engine.invoke('member.stop.preview',{memberId:'claude'}) as any;
    const run=h.engine.store.get<Run>('runs',preview.runs[0].runId)!;h.engine.store.put('runs',run.id,{...run,updatedAt:new Date(Date.now()+1000).toISOString()});
    assert.equal((await h.engine.invoke('member.stop.preview',{memberId:'claude'}) as any).token,preview.token);await h.engine.invoke('member.stop',{memberId:'claude',token:preview.token,confirm:true});
    await until(()=>h.engine.store.roomState().discussion?.phase==='awaiting-host');assert.deepEqual(h.speech().map(c=>c.input.you),['claude','codex','dsh']);assert.ok(h.speech()[0].stopped);assert.ok(h.speech().slice(1).every(c=>!c.stopped));assert.ok(h.engine.snapshot().room.messages.some(m=>m.system&&m.text.includes('已中止，本轮暂不发言')));
  }finally{await h.dispose();}
});

test('orphaned room states cannot prevent member cancellation or stop peer members',async()=>{
  const h=await meetingHarness(async c=>{if(c.prompt.includes('\nAIROOM_CONTEXT\n')&&c.input.you==='claude')await new Promise<void>(r=>c.release=r);});
  try{
    await h.start();await until(()=>h.speech().length===1);
    const state=h.engine.store.roomState();
    const staleRooms=['project:deleted-one','project:deleted-two','project:deleted-three','roundtable:deleted','desk:deleted'] as const;
    for(const roomId of staleRooms)h.engine.store.put('room_states',roomId,{...state,roomId});
    const staleBefore=staleRooms.map(roomId=>structuredClone(h.engine.store.get<RoomState>('room_states',roomId)));
    const preview=await h.engine.invoke('member.stop.preview',{memberId:'claude'}) as any;
    assert.equal(preview.runs.length,1);
    const result=await h.engine.invoke('member.stop',{memberId:'claude',token:preview.token,confirm:true}) as any;
    assert.equal(result.requested,1);assert.equal(result.remaining.length,0);
    await until(()=>h.engine.store.roomState().discussion?.phase==='awaiting-host');
    assert.equal(h.engine.store.get<Run>('runs',preview.runs[0].runId)!.status,'stopped');
    assert.deepEqual(h.speech().map(c=>c.input.you),['claude','codex','dsh']);
    assert.ok(h.speech()[0].stopped);assert.ok(h.speech().slice(1).every(c=>!c.stopped));
    staleRooms.forEach((roomId,index)=>assert.deepEqual(h.engine.store.get<RoomState>('room_states',roomId),staleBefore[index],'stopping preserves historical orphan records'));
  }finally{await h.dispose();}
});

test('stopping requested minutes keeps the record and a new human request chooses another summarizer',async()=>{
  const h=await meetingHarness(async c=>{if(c.ctx.session.purpose==='room-minutes'&&c.input.you==='dsh')await new Promise<void>(r=>c.release=r);});
  try{await h.start('global',{handRaise:false});await until(()=>h.engine.store.roomState().discussion?.phase==='waiting_user');let d=h.engine.store.roomState().discussion!;await h.engine.invoke('room.minutes',{discussionId:d.id,revision:d.revision,memberId:'dsh'});await until(()=>h.calls.some(c=>c.ctx.session.purpose==='room-minutes'));const preview=await h.engine.invoke('member.stop.preview',{memberId:'dsh'}) as any;assert.equal(preview.runs.length,1);await h.engine.invoke('member.stop',{memberId:'dsh',token:preview.token,confirm:true});await until(()=>!h.engine.store.roomState().active);d=h.engine.store.roomState().discussion!;await h.engine.invoke('room.minutes',{discussionId:d.id,revision:d.revision,memberId:'claude'});await until(()=>h.engine.store.roomState().discussion?.phase==='idle');
    const minutes=h.calls.filter(c=>c.ctx.session.purpose==='room-minutes');assert.deepEqual(minutes.map(c=>c.input.you),['dsh','claude']);assert.ok(minutes[0].stopped);assert.equal(h.engine.store.roomState().discussion!.proposal,undefined);assert.equal(h.engine.store.roomState().discussion!.endedBy,'user');assert.equal(h.engine.snapshot().room.messages.filter(m=>m.kind==='summary'&&m.status==='done').length,1);
  }finally{await h.dispose();}
});

test('work meetings follow visible seating order and complete the whole response round before hands',async()=>{
  const h=await meetingHarness(c=>{if(c.prompt.includes('\nAIROOM_CONTEXT\n')&&c.input.you==='claude')return {version:1,turn:c.input.turn,revision:c.input.revision,action:'speak',body:'请 DS 回答这个问题',next:'dsh',questions:[{to:'dsh',text:'怎么看？'}]};});
  try{await h.start();await until(()=>h.engine.store.roomState().discussion?.phase==='awaiting-host'&&!h.engine.store.roomState().active);assert.deepEqual(h.speech().map(c=>c.input.you),['claude','codex','dsh']);assert.equal(h.calls.filter(c=>c.ctx.session.purpose==='room-hand').length,3);assert.ok(h.calls.slice(0,3).every(c=>c.ctx.session.purpose!=='room-hand'));assert.ok(h.speech()[2].input.questions.some((q:any)=>q.to==='dsh'));}
  finally{await h.dispose();}
});

test('multiple mentions reply in seating order once, then wait without hands, and a new user message resets the full round',async()=>{
  const h=await meetingHarness();try{await h.start();await until(()=>h.engine.store.roomState().discussion?.phase==='awaiting-host');const old=h.engine.store.roomState().discussion!,before=h.speech().length,hands=h.calls.filter(c=>c.ctx.session.purpose==='room-hand').length;await h.start('global',{text:'@DS @Claudia 请回答'});await until(()=>h.engine.store.roomState().discussion?.phase==='waiting_user'&&!h.engine.store.roomState().active);assert.deepEqual(h.speech().slice(before).map(c=>c.input.you),['claude','dsh']);assert.equal(h.calls.filter(c=>c.ctx.session.purpose==='room-hand').length,hands);await assert.rejects(h.engine.invoke('room.host',{discussionId:old.id,revision:old.revision,handRoundId:old.handRound!.id,choice:'member',memberId:'codex'}),/已改变/);const count=h.calls.length;await new Promise(r=>setTimeout(r,40));assert.equal(h.calls.length,count);await h.start('global',{text:'接下来所有人回答'});await until(()=>h.engine.store.roomState().discussion?.phase==='awaiting-host');assert.deepEqual(h.speech().slice(before+2).map(c=>c.input.you),['claude','codex','dsh']);}finally{await h.dispose();}
});

test('a pass gets one repair, then a visible missed-answer record while the other members keep answering',async()=>{
  const h=await meetingHarness(c=>c.prompt.includes('\nAIROOM_CONTEXT\n')&&c.input.you==='claude'?{version:1,turn:c.input.turn,revision:c.input.revision,action:'pass',body:''}:undefined);try{await h.start();await until(()=>h.engine.store.roomState().discussion?.phase==='awaiting-host');assert.deepEqual(h.speech().map(c=>c.input.you),['claude','claude','codex','dsh']);assert.equal(h.speech()[0].input.turn,h.speech()[1].input.turn);const missed=h.engine.snapshot().room.messages.filter(m=>m.author==='claude'&&m.status==='failed');assert.equal(missed.length,1);assert.match(missed[0].text,/这次没能回答/);assert.equal(h.engine.snapshot().room.messages.some(m=>m.text.includes('"action"')),false);}finally{await h.dispose();}
});

test('early closure remains prose and host-selected speech does not start a new seated round',async()=>{
  const h=await meetingHarness(c=>c.prompt.includes('AIROOM_CONTEXT')&&c.input.you==='claude'?{version:1,turn:c.input.turn,revision:c.input.revision,action:'propose',body:'可以收尾'}:undefined);try{await h.start();await until(()=>h.engine.store.roomState().discussion?.phase==='awaiting-host');assert.equal(h.engine.store.roomState().discussion!.proposal,undefined);assert.equal(h.speech().length,3);const before=h.speech().length,d=h.engine.store.roomState().discussion!;await h.engine.invoke('room.host',{discussionId:d.id,revision:d.revision,handRoundId:d.handRound!.id,choice:'member',memberId:'codex'});await until(()=>h.engine.store.roomState().discussion?.phase==='awaiting-host'&&h.engine.store.roomState().discussion!.handRound!.id!==d.handRound!.id);assert.deepEqual(h.speech().slice(before).map(c=>c.input.you),['codex']);assert.deepEqual(Object.keys(h.engine.store.roomState().discussion!.handRound!.ballots).sort(),['claude','dsh']);}finally{await h.dispose();}
});

test('a working member is skipped while peers answer, but an explicit mention gets the separate read-only task reply',async()=>{
  const h=await meetingHarness(async c=>{if(c.kind==='submission')await new Promise<void>(r=>c.release=r);});try{const project=await h.engine.invoke('project.create',{directory:h.directory}) as Project;await h.engine.invoke('projectFlow.start',{requestId:'work',projectId:project.id,topic:'改文件',leadMemberId:'codex',memberIds:['codex','claude','dsh']});let flow!:ProjectFlowSnapshot;await until(()=>{flow=(h.engine as any).projectFlow.snapshot(project.id);return Boolean(flow.plan);});await h.engine.invoke('projectFlow.plan.confirm',{requestId:'work-confirm',planId:flow.plan!.id,expectedRevision:flow.plan!.revision});await until(()=>h.calls.some(c=>c.kind==='submission'));const roomId='project:'+project.id;await h.start(roomId);await until(()=>h.engine.store.roomState(roomId as any).discussion?.phase==='awaiting-host');assert.deepEqual(h.speech().map(c=>c.input.you),['dsh']);assert.ok(h.engine.store.allRoomMessages(h.engine.store.currentRoomThread(roomId as any).id,roomId as any).some(m=>m.system&&m.text.includes('正在做项目任务')));const before=h.speech().length;await h.start(roomId,{text:'@Claudia 现在进展如何'});await until(()=>h.engine.store.roomState(roomId as any).discussion?.phase==='waiting_user');const mention=h.speech().slice(before)[0];assert.equal(mention.input.phase,'working-mention');assert.equal(mention.ctx.session.writeMode,false);assert.notEqual(mention.ctx.session.id,h.calls.find(c=>c.kind==='submission')!.ctx.session.id);await h.engine.invoke('room.stop',{roomId});assert.equal(h.calls.find(c=>c.kind==='submission')!.stopped,false);}finally{await h.dispose();}
});

test('member stop confirms the precise desk and task runs, rejects changed previews and preserves other members',async()=>{
  const h=await meetingHarness(async c=>{if(c.kind==='submission'||!c.kind&&!c.prompt.includes('AIROOM_CONTEXT')&&c.ctx.session.purpose!=='room-hand')await new Promise<void>(r=>c.release=r);});try{const project=await h.engine.invoke('project.create',{directory:h.directory}) as Project;await h.engine.invoke('room.archive',{roomId:'desk:claude',title:'工位'});await h.engine.invoke('room.archive',{roomId:'desk:dsh',title:'另一个工位'});await h.engine.invoke('room.send',{roomId:'desk:claude',text:'工位任务'});await h.engine.invoke('room.send',{roomId:'desk:dsh',text:'其他成员任务'});await h.engine.invoke('projectFlow.start',{requestId:'stop-flow',projectId:project.id,topic:'改文件',leadMemberId:'codex',memberIds:['codex','claude','dsh']});let flow!:ProjectFlowSnapshot;await until(()=>{flow=(h.engine as any).projectFlow.snapshot(project.id);return Boolean(flow.plan);});await h.engine.invoke('projectFlow.plan.confirm',{requestId:'stop-flow-confirm',planId:flow.plan!.id,expectedRevision:flow.plan!.revision});await until(()=>h.calls.some(c=>c.kind==='submission'));const preview=await h.engine.invoke('member.stop.preview',{memberId:'claude'}) as any;assert.equal(preview.runs.length,2);assert.ok(preview.runs.some((r:any)=>r.location==='个人工位'));assert.ok(preview.runs.some((r:any)=>r.location==='项目工作'));const extra=await h.engine.invoke('session.create',{projectId:project.id,provider:'claude',writeMode:false,title:'新对话'}) as Session;await h.engine.send(extra.id,'另一个当前动作');await until(()=>h.calls.some(c=>c.ctx.session.id===extra.id));await assert.rejects(h.engine.invoke('member.stop',{memberId:'claude',token:preview.token,confirm:true}),/运行已变化/);assert.ok(h.calls.filter(c=>(c.ctx.session.memberId??c.ctx.session.provider)==='claude').every(c=>!c.stopped));const current=await h.engine.invoke('member.stop.preview',{memberId:'claude'}) as any;await h.engine.invoke('member.stop',{memberId:'claude',token:current.token,confirm:true});assert.equal((await h.engine.invoke('member.stop.preview',{memberId:'claude'}) as any).runs.length,0);assert.ok(h.calls.filter(c=>(c.ctx.session.memberId??c.ctx.session.provider)==='claude').every(c=>c.kind==='plan'||c.stopped));const other=h.calls.find(c=>(c.ctx.session.memberId??c.ctx.session.provider)==='dsh')!;assert.equal(other.stopped,false);assert.equal(h.engine.store.get<Run>('runs',other.ctx.run.id)!.completedAt,undefined);}finally{await h.dispose();}
});
