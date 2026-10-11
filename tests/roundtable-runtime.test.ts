import './helpers/roundtable-harness';
import test from 'node:test';
import assert from 'node:assert/strict';
import type {FlowOperation} from '../src/shared/project-flow';
import type {Run} from '../src/shared/types';
import {roundtableHarness} from './helpers/roundtable-harness';
import {opinion,summary} from './helpers/joint-review-harness';
import {finishedFlowReply} from '../src/backend/project-flow-recovery';

const timeout='workspace routing discovery timed out\nfailed to refresh available models: request timed out';
const member=(call:any)=>call.ctx.session.memberId??call.ctx.session.provider;

test('deleted topics tolerate outstanding view reads without reopening rooms; mutations and unknown IDs still fail',async()=>{
  const h=await roundtableHarness();try{
    const first=(await h.open({title:'保留的议题'})).topic;await h.act(first.id,'end');const last=(await h.open({title:'删除的议题'})).topic;await h.act(last.id,'end');
    await h.wait(last.id,()=>!(h.engine as any).projectFlow.joint.busyFor(last.reviewId));await h.act(last.id,'delete');
    assert.equal(await h.engine.invoke('roundtable.get',{topicId:last.id,allowDeleted:true}),null);
    for(const method of ['room.get','room.history']){const page=await h.engine.invoke(method,{roomId:last.roomId,threadId:last.id}) as {messages:unknown[]};assert.deepEqual(page.messages,[]);}
    assert.deepEqual(await h.engine.invoke('room.read',{roomId:last.roomId}),{read:false});
    await assert.rejects(h.engine.invoke('roundtable.get',{topicId:last.id}),/不存在/);
    await assert.rejects(h.engine.invoke('roundtable.get',{topicId:'never-existed',allowDeleted:true}),/不存在/);
    await assert.rejects(h.engine.invoke('room.send',{roomId:last.roomId,text:'不能恢复已删除议题'}),/不存在/);
    assert.equal(h.engine.store.get('room_states',last.roomId),undefined);assert.equal(h.engine.store.get('room_threads',last.id),undefined);
    assert.equal(h.engine.snapshot().roundtable?.currentTopicId,first.id);await h.act(first.id,'delete');assert.equal(h.engine.snapshot().roundtable?.topics.length,0);
  }finally{await h.dispose();}
});

test('blank comments allow slot rewrite, skip and abandon while preserving stopped/unknown receipts',async()=>{
  for(const choice of ['retry','skip','abandon']){
    let fail=true;const h=await roundtableHarness({handler:async c=>{if(fail&&c.kind==='joint-independent'&&member(c)==='dsh')throw Error('fixture incomplete response');}});
    try{
      const t=(await h.open({kind:'proposals',memberIds:['codex','dsh'],peerReview:false})).topic;
      const d=await h.wait(t.id,d=>d.review?.review.status==='blocked'&&d.review.slots.some(s=>s.memberId==='codex'&&s.status==='completed'));
      const slot=d.review!.slots.find(s=>s.memberId==='dsh')!,oldRun=h.engine.store.get<Run>('runs',slot.runId??h.engine.store.get<FlowOperation>('flow_operations',slot.operationId!)!.runId!)!;
      const receipt=structuredClone(oldRun);fail=false;if(choice==='retry')await assert.rejects(h.act(t.id,'resolve',{slotId:slot.id,choice}),/明确确认/);await h.act(t.id,'resolve',{slotId:slot.id,choice,acknowledgeUnknown:choice==='retry'});
      const after=await h.get(t.id);assert.deepEqual(h.engine.store.get('runs',oldRun.id),receipt);
      if(choice==='abandon')assert.equal(after.topic.status,'ended');
      else if(choice==='skip'){const saved=h.engine.store.get<any>('flow_joint_slots',slot.id);assert.equal(saved.status,'skipped');assert.equal(saved.skippedByUser.evidence,'');}
      else await h.wait(t.id,d=>d.review!.slots.find(s=>s.id===slot.id)?.status==='completed');
    }finally{await h.dispose();}
  }
});

test('independent artifact review receives material boundaries and finishes with an honest missing-context result',async()=>{
  const h=await roundtableHarness({handler:async c=>c.kind==='joint-independent'?{summary:'只有测试占位文件，无法确认其业务意义',findings:[],unverifiedItems:['未提供文件用途和验收要求'],evidence:[]}:undefined});
  try{
    const t=(await h.open({kind:'review',material:{text:'解释这个测试文件',directory:h.original},memberIds:['dsh'],peerReview:false})).topic;
    const d=await h.wait(t.id,d=>d.review!.slots.some(s=>s.stage==='independent'&&s.status==='completed'));
    const call=h.calls.find(c=>c.kind==='joint-independent')!;assert.match(call.material.materialBoundary,/指纹.*元数据/);assert.match(call.material.materialBoundary,/不得搜索.*日志/);assert.match(call.material.materialBoundary,/材料不足.*unverifiedItems.*完成/);assert.ok(call.material.availableFiles.includes('brief.md'));assert.ok(!call.material.availableFiles.some((file:string)=>file.startsWith('.airoom')));
    assert.deepEqual(d.review!.slots.find(s=>s.stage==='independent')?.opinion?.unverifiedItems,['未提供文件用途和验收要求']);assert.equal(h.calls.filter(c=>c.kind==='joint-independent').length,1);
  }finally{await h.dispose();}
});

test('manually requested minutes receive the current selected candidate rather than the earlier discussion snapshot',async()=>{
  const h=await roundtableHarness({handler:async call=>{
    if(!call.kind&&!['room-hand','room-minutes'].includes(call.ctx.session.purpose??''))return {version:1,turn:call.material.turn,revision:call.material.revision,action:'ask_user',body:'请按你的偏好选稿。',questions:[{to:'user',text:'你选择哪份稿件？'}]};
  }});
  try{
    const topic=(await h.open({kind:'proposals',memberIds:['codex','dsh'],peerReview:false})).topic;await h.choose(topic.id);
    const detail=await h.wait(topic.id,()=>h.engine.store.roomState(topic.roomId).discussion?.phase==='waiting_user'),discussion=h.engine.store.roomState(topic.roomId).discussion!,selectedId=detail.review!.review.selectedSlotId!,candidate=detail.review!.slots.find(slot=>slot.id===selectedId)!;
    await h.engine.invoke('room.minutes',{roomId:topic.roomId,discussionId:discussion.id,revision:discussion.revision,memberId:'dsh'});await h.wait(topic.id,d=>d.topic.status==='conclusion');
    const minutes=h.calls.filter(call=>call.ctx.session.purpose==='room-minutes');assert.equal(minutes.length,1);assert.ok(minutes[0].prompt.includes('"selectedSlotId":"'+selectedId+'"'));assert.ok(minutes[0].prompt.includes('"memberId":"'+candidate.memberId+'"'));assert.ok(minutes[0].prompt.includes(candidate.opinion!.proposal!));assert.match(minutes[0].prompt,/该选择不表示全员共识或成品验收通过/);
  }finally{await h.dispose();}
});

for(const kind of ['review','proposals','candidates'] as const)test('roundtable '+kind+' accepts completed opinions and synthesis with the advertised userSummary',async()=>{
  const h=await roundtableHarness({handler:async call=>{
    if(['joint-independent','joint-peer'].includes(call.kind))return {...opinion(member(call),call.kind==='joint-independent'&&kind!=='review'),userSummary:'给用户看的简要说明，保留未验证的读者偏好。'};
    if(call.kind==='joint-summary')return {...summary(call.material),userSummary:'已比较各版，待用户决定。'};
  }});
  try{
    const topic=(await h.open({kind})).topic;
    if(kind==='review')await h.minutes(topic.id);else await h.confirm(topic.id);
    const d=await h.get(topic.id),slots=d.review!.slots.filter(s=>['independent','peer'].includes(s.stage));
    assert.equal(slots.length,6);assert.ok(slots.every(s=>s.status==='completed'&&s.opinion?.userSummary?.includes('简要说明')));
    assert.equal(d.review!.review.conclusion?.userSummary,'已比较各版，待用户决定。');
    assert.equal(h.calls.filter(c=>c.prompt.includes('仅补正上轮 JSON 格式')).length,0);
    assert.equal(d.review!.review.cost.additionalCalls,0);
  }finally{await h.dispose();}
});

test('an undelivered roundtable initialization timeout reconnects once and retains distinct receipts',async()=>{
  let attempts=0;const h=await roundtableHarness({manualDelivery:true,handler:async call=>{
    if(call.kind==='joint-independent'&&member(call)==='codex'&&++attempts===1)throw Error(timeout);
    call.ctx.markDelivery('confirmed');
  }});
  try{
    const t=(await h.open({kind:'proposals',memberIds:['codex','claude'],peerReview:false})).topic;
    const d=await h.wait(t.id,d=>d.review?.review.status==='awaiting_decision'),slot=d.review!.slots.find(s=>s.stage==='independent'&&s.memberId==='codex')!,op=h.engine.store.get<FlowOperation>('flow_operations',slot.operationId!)!;
    const runs=h.engine.store.list<Run>('runs').filter(r=>r.sessionId===slot.sessionId);
    assert.equal(attempts,2);assert.equal(runs.length,2);assert.equal(runs[0].status,'failed');assert.equal(runs[0].delivery,'prepared');assert.equal(runs[1].status,'ended');
    assert.deepEqual(op.connectionRetryRunIds,[runs[0].id]);assert.equal(op.runId,runs[1].id);assert.equal(op.correctionRunId,undefined);
    assert.ok(h.engine.store.listEvents(slot.sessionId).some(e=>e.runId===runs[0].id&&e.kind==='warning'&&e.text.includes('尚未发出')));
    assert.equal(d.review!.review.cost.completedCalls,3);assert.equal(d.review!.review.cost.additionalCalls,1);
    assert.equal(finishedFlowReply(h.engine.store,op)?.runId,runs[1].id);
    await h.confirm(t.id);
  }finally{await h.dispose();}
});

test('persistent undelivered connection failure stops after the sole retry with an actionable reason',async()=>{
  const h=await roundtableHarness({manualDelivery:true,handler:async()=>{throw Error(timeout);}});
  try{
    const t=(await h.open({kind:'proposals',memberIds:['codex'],peerReview:false})).topic,d=await h.wait(t.id,d=>d.topic.status==='blocked');
    assert.equal(h.calls.length,2);assert.match(d.review!.review.error!,/未发出.*重试一次连接.*检测连接/);
    assert.equal(d.review!.review.cost.additionalCalls,1);assert.ok(h.engine.store.list<Run>('runs').every(r=>r.status==='failed'&&r.delivery==='prepared'));
    await h.act(t.id,'end',{acknowledgeUnknown:true});assert.equal(h.calls.length,2);
  }finally{await h.dispose();}
});

test('explicit recovery of a stored completed opinion clears the blocked topic without resending it',async()=>{
  const h=await roundtableHarness({handler:async call=>call.kind==='joint-independent'?{...opinion(member(call)),userSummary:'已完成的独立意见，保留未核实事项。'}:undefined});
  const joint=(h.engine as any).projectFlow.joint,validate=joint.validate;
  // Simulate the previous parser rejecting both confirmed replies before an upgrade.
  joint.validate=function(...args:any[]){if(args[1].stage==='independent')throw Error('旧解析器：不接受 userSummary');return validate.apply(this,args);};
  try{
    const t=(await h.open({kind:'review',memberIds:['codex'],peerReview:false})).topic,blocked=await h.wait(t.id,d=>d.topic.status==='blocked'),slot=blocked.review!.slots.find(s=>s.stage==='independent')!,op=h.engine.store.get<FlowOperation>('flow_operations',slot.operationId!)!;
    assert.equal(h.calls.filter(c=>c.kind==='joint-independent').length,2);assert.ok(finishedFlowReply(h.engine.store,op));
    const copyId=h.engine.store.get<any>('flow_joint_slots',slot.id).disposableArtifactId;
    assert.equal(h.engine.store.get<any>('flow_artifacts',copyId)?.status,'ready','the checked copy remains available while the completed result needs recovery');
    joint.validate=validate;
    await h.act(t.id,'resolve',{slotId:slot.id,choice:'recover',evidence:'已核对保存的真实完成回复，恢复其内容。'});
    const restored=await h.get(t.id);assert.equal(restored.topic.status,'reviewing');assert.equal(restored.topic.error,undefined);assert.equal(restored.review!.review.dispatchMode,'paused');
    await h.act(t.id,'resume');const done=await h.minutes(t.id);
    assert.equal(h.calls.filter(c=>c.kind==='joint-independent').length,2);assert.equal(done.review!.slots.find(s=>s.id===slot.id)?.opinion?.userSummary,'已完成的独立意见，保留未核实事项。');
    assert.equal(h.engine.store.get<FlowOperation>('flow_operations',op.id)?.correctionRunId,op.correctionRunId);
    assert.equal(h.engine.store.get<any>('flow_artifacts',copyId)?.status,'removed','the recovered completed opinion releases its temporary copy');
    joint.validate=function(...args:any[]){if(args[1].stage==='independent')throw Error('旧解析器：不接受 userSummary');return validate.apply(this,args);};
    const other=(await h.open({kind:'review',memberIds:['codex'],peerReview:false})).topic,next=await h.wait(other.id,d=>d.topic.status==='blocked'),otherCopy=h.engine.store.get<any>('flow_joint_slots',next.review!.slots[0].id).disposableArtifactId;
    assert.equal(h.engine.store.get<any>('flow_artifacts',otherCopy)?.status,'ready');
    await h.act(other.id,'end',{acknowledgeUnknown:true});assert.equal(h.engine.store.get<any>('flow_artifacts',otherCopy)?.status,'removed','ending a checked blocked topic releases its temporary copy');
  }finally{joint.validate=validate;await h.dispose();}
});

for(const delivery of ['sent','confirmed'] as const)test('roundtable '+delivery+' transport loss stays unknown and is never repeated',async()=>{
  const h=await roundtableHarness({manualDelivery:true,handler:async call=>{call.ctx.markDelivery(delivery);throw Error(timeout);}});
  try{
    const t=(await h.open({kind:'proposals',memberIds:['codex'],peerReview:false})).topic,d=await h.wait(t.id,d=>d.topic.status==='blocked');
    assert.equal(h.calls.length,1);const op=h.engine.store.get<FlowOperation>('flow_operations',d.review!.slots[0].operationId!)!;
    assert.equal(op.connectionRetryRunIds,undefined);assert.equal(h.engine.store.get<Run>('runs',op.runId!)?.status,'unknown');
  }finally{await h.dispose();}
});

test('authentication and local configuration failures do not reconnect',async()=>{
  for(const error of ['401 unauthorized network authentication','invalid local configuration']){
    const h=await roundtableHarness({manualDelivery:true,handler:async()=>{throw Error(error);}});
    try{const t=(await h.open({kind:'proposals',memberIds:['codex'],peerReview:false})).topic;await h.wait(t.id,d=>d.topic.status==='blocked');assert.equal(h.calls.length,1);}finally{await h.dispose();}
  }
});

test('pausing after the undelivered receipt prevents reconnect dispatch',async()=>{
  const h=await roundtableHarness({manualDelivery:true,handler:async()=>{throw Error(timeout);}});
  try{
    const host=(h.engine as any).projectFlow.host,run=host.run;host.run=async(...args:any[])=>{const result=await run(...args);if(result.status==='failed'){const t=h.engine.snapshot().roundtable!.topics[0];await h.act(t.id,'pause');}return result;};
    const t=(await h.open({kind:'proposals',memberIds:['codex'],peerReview:false})).topic;
    await h.wait(t.id,d=>d.review?.review.dispatchMode==='paused'&&d.review.slots[0].status==='queued');
    assert.equal(h.calls.length,1);assert.equal(h.engine.store.list<FlowOperation>('flow_operations')[0].connectionRetryRunIds,undefined);
  }finally{await h.dispose();}
});

for(const retryCorrection of [false,true])test(retryCorrection?'a correction reconnect preserves its completed original answer':'a reconnect does not consume the sole format correction',async()=>{
  let attempts=0;const h=await roundtableHarness({manualDelivery:true,handler:async call=>{
    if(call.kind==='joint-independent'){
      attempts++;if(attempts===(retryCorrection?2:1))throw Error(timeout);
      call.ctx.markDelivery('confirmed');return {...opinion('codex'),...(attempts===(retryCorrection?1:2)?{unexpected:'only this shape needs correction'}:{})};
    }
    call.ctx.markDelivery('confirmed');
  }});
  try{
    const t=(await h.open({kind:'proposals',memberIds:['codex'],peerReview:false})).topic,d=await h.wait(t.id,d=>d.review?.review.status==='awaiting_decision'),slot=d.review!.slots.find(s=>s.stage==='independent')!,op=h.engine.store.get<FlowOperation>('flow_operations',slot.operationId!)!;
    const runs=h.engine.store.list<Run>('runs').filter(r=>r.sessionId===slot.sessionId);
    assert.equal(attempts,3);assert.equal(op.runId,runs[retryCorrection?0:1].id);assert.equal(op.correctionRunId,runs[2].id);assert.deepEqual(op.connectionRetryRunIds,[runs[retryCorrection?1:0].id]);
    assert.equal(finishedFlowReply(h.engine.store,op)?.runId,runs[2].id);assert.equal(slot.opinion?.proposal,'codex 的候选正文');assert.equal(d.review!.review.cost.additionalCalls,2);
  }finally{await h.dispose();}
});
