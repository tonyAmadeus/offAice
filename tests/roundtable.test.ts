import './helpers/roundtable-harness';
import test from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Engine} from '../src/backend/engine';
import type {Project,RoomThread,Run,Session} from '../src/shared/types';
import type {RoundtableDetail} from '../src/shared/roundtable';
import type {ProjectFlowSnapshot} from '../src/shared/project-flow';
import {workspaceFingerprint} from '../src/backend/workspace';
import {roundtableHarness} from './helpers/roundtable-harness';
import {BackupRestorer} from '../src/backend/backup-restore';
import {opinion} from './helpers/joint-review-harness';

test('roundtable summary example references only a completed candidate after the first member is skipped',async()=>{
  const h=await roundtableHarness({handler:async c=>{
    if(c.kind==='joint-independent'&&c.ctx.run.provider==='claude')return {nativeResult:{failure:{kind:'rate_limited',message:'quota exhausted'}}};
    if(c.kind==='joint-summary')return JSON.parse(c.prompt.split('只返回 JSON：')[1].split('\n')[0]).payload;
  }});
  try{
    const opened=await h.open({memberIds:['claude','dsh'],peerReview:false});
    const blocked=await h.wait(opened.topic.id,d=>d.review?.review.status==='blocked');
    const failed=blocked.review!.slots.find(s=>s.memberId==='claude'&&s.stage==='independent')!;
    const completed=blocked.review!.slots.find(s=>s.memberId==='dsh'&&s.stage==='independent')!;
    assert.equal(completed.status,'completed');await h.act(opened.topic.id,'resolve',{slotId:failed.id,choice:'skip',evidence:''});
    const done=await h.wait(opened.topic.id,d=>d.review?.review.status==='awaiting_decision');
    assert.equal(done.review!.review.conclusion?.recommendedSlotId,completed.id);
    assert.equal(h.calls.filter(c=>c.kind==='joint-summary').length,1);
  }finally{await h.dispose();}
});

for(const stage of ['independent','peer'] as const)test(`parallel roundtable ${stage} failure still permits a healthy member single format correction`,async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  const h=await roundtableHarness({handler:async c=>{
    if(c.kind==='joint-'+stage&&c.ctx.run.provider==='claude')return {nativeResult:{failure:{kind:'rate_limited',message:'quota exhausted'}}};
    if(c.kind==='joint-'+stage&&c.ctx.run.provider==='dsh'){
      if(!c.prompt.includes('仅补正上轮 JSON 格式'))await gate;
      return {...opinion('dsh',stage==='independent'),evidence:[{kind:c.prompt.includes('仅补正上轮 JSON 格式')?'inspection':'command',description:'按给定要求核对',result:'未执行命令',eventIds:[],source:'reported'}]};
    }
  }});
  try{
    const opened=await h.open({memberIds:['claude','dsh'],peerReview:stage==='peer'});
    await h.wait(opened.topic.id,d=>d.review!.slots.some(s=>s.memberId==='claude'&&s.stage===stage&&s.status==='blocked'));release();
    const done=await h.wait(opened.topic.id,d=>d.review!.slots.find(s=>s.memberId==='dsh'&&s.stage===stage)?.status==='completed');
    assert.equal(done.review!.review.status,'blocked');
    assert.equal(h.calls.filter(c=>c.kind==='joint-'+stage&&c.ctx.run.provider==='dsh'&&c.prompt.includes('仅补正上轮 JSON 格式')).length,1);
    assert.equal(h.calls.filter(c=>c.kind==='joint-'+stage&&c.ctx.run.provider==='claude').length,1);
    const failed=done.review!.slots.find(s=>s.memberId==='claude'&&s.stage===stage)!;
    await h.act(opened.topic.id,'resolve',{slotId:failed.id,choice:'skip',evidence:''});
    await h.wait(opened.topic.id,d=>d.review?.review.status==='awaiting_decision');
  }finally{release();await h.dispose();}
});
import {fixtureBackup} from './support/backup-fixture';
import type {TaskAddition} from '../src/shared/project-workbench';

test('an empty roundtable creates no project or native session, old council and project review writes are readonly',async()=>{
  const h=await roundtableHarness();try{const before=h.engine.store.list('projects').length;assert.deepEqual(await h.engine.invoke('roundtable.list'),{currentTopicId:undefined,topics:[]});assert.equal(h.engine.store.list('projects').length,before);assert.equal(h.calls.length,0);await assert.rejects(h.engine.invoke('collaboration.start',{mode:'council'}),/圆桌/);await assert.rejects(h.engine.invoke('collaboration.resume',{id:'old'}),/只读|只供阅读/);await assert.rejects(h.engine.invoke('projectFlow.jointReview.start',{}),/圆桌/);assert.equal(h.calls.length,0);}finally{await h.dispose();}
});

test('roundtable preparation is internal context, never a fabricated user message, including old history projections',async()=>{
  const h=await roundtableHarness();try{
    const d=await h.open({kind:'proposals',memberIds:['codex'],peerReview:false});await h.wait(d.topic.id,()=>h.engine.store.roomState(d.topic.roomId).discussion?.phase==='waiting_user');
    const messages=h.engine.store.allRoomMessages(d.topic.id,d.topic.roomId),context=messages.find(m=>m.text.startsWith('围绕议题「'))!;assert.ok(context);assert.equal(context.author,'system');assert.equal(context.contextOnly,true);
    const summary=(await h.get(d.topic.id)).topic.discussionMaterial!;assert.equal(summary.members[0].id,'codex');assert.equal(summary.members[0].opinions,1);assert.equal(summary.truncated,false);assert.equal(summary.findings,0);
    const speech=h.calls.find(c=>!c.kind&&c.ctx.session.purpose!=='room-hand')!;assert.ok(speech.material.messages.some((m:any)=>m.author==='system'&&m.text.includes('"opinions"')),'members still receive the frozen material as context');
    const legacy={...context,author:'user',system:undefined,contextOnly:undefined};h.engine.store.put('room_messages',context.id,legacy);
    const projected=h.engine.store.roomHistory(d.topic.id,undefined,100,d.topic.roomId).messages.find(m=>m.id===context.id)!;assert.equal(projected.author,'system');assert.equal(projected.contextOnly,true);assert.equal(h.engine.store.get<any>('room_messages',context.id)?.author,'user','reading old history does not rewrite stored evidence');
    const exported=await h.engine.invoke('roundtable.export',{topicId:d.topic.id}) as {content:string};assert.ok(!exported.content.includes('审议下面已保存的意见'));
    h.engine.store.put('room_messages','actual-human',{...legacy,id:'actual-human',discussionRevision:2});assert.equal(h.engine.store.roomHistory(d.topic.id,undefined,100,d.topic.roomId).messages.find(m=>m.id==='actual-human')?.author,'user','later human text is not reclassified by its wording');
  }finally{await h.dispose();}
});
test('independent opinions are hidden until the barrier, candidate copies and native contexts are separate',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);const h=await roundtableHarness({handler:async c=>{if(c.kind==='joint-independent'&&c.ctx.session.memberId==='dsh')await gate;}});
  try{const d=await h.open({deliverablePath:'candidate.md'}),id=d.topic.id;const hidden=await h.wait(id,d=>d.completed>=1&&!d.revealed);assert.ok(hidden.review!.slots.every(s=>!s.opinion&&!s.version&&!s.sessionId));assert.equal(h.engine.store.allRoomMessages(id,d.topic.roomId).filter(m=>m.roundtable?.kind==='candidate').length,0);await assert.rejects(h.engine.invoke('room.send',{roomId:d.topic.roomId,mode:'discuss',text:'提前公开'}),/公开/);assert.equal(h.calls.some(c=>c.kind==='joint-peer'),false);
    release();const done=await h.wait(id,d=>d.review?.review.status==='awaiting_decision');assert.equal(done.revealed,true);const slots=done.review!.slots.filter(s=>s.stage==='independent');assert.equal(new Set(slots.map(s=>s.disposableArtifactId)).size,3);assert.equal(new Set(slots.map(s=>s.sessionId)).size,3);assert.equal(h.engine.store.list('project_flows').length,0);assert.equal(h.engine.store.list('flow_rounds').length,0);assert.equal(await readFile(path.join(h.original,'brief.md'),'utf8'),'原材料：活动文案。');const peer=h.calls.filter(c=>c.kind==='joint-peer');assert.equal(peer.length,3);assert.ok(peer.every(c=>c.material.candidates.length===2));
    const confirmed=await h.confirm(id);assert.equal(confirmed.topic.status,'confirmed');assert.match(confirmed.topic.conclusion!.body,/少数意见/);assert.equal(confirmed.review!.review.selectedSlotId,slots[1].id);const before=h.calls.length;await h.act(id,'archive');await h.act(id,'select');await h.engine.invoke('roundtable.export',{topicId:id});assert.equal(h.calls.length,before);await assert.rejects(h.engine.invoke('room.send',{roomId:done.topic.roomId,mode:'discuss',text:'归档后'}),/只供阅读/);
  }finally{release();await h.dispose();}
});
test('reviewing a local directory freezes the basis and never changes its original',async()=>{
  const h=await roundtableHarness();try{const before=await workspaceFingerprint(h.original),d=await h.open({kind:'review',material:{text:'评价资料内容和来源。',directory:h.original}});const done=await h.minutes(d.topic.id);assert.equal(done.review!.review.kind,'artifact');const version=done.topic.materialVersion!,artifact=h.engine.store.get<{root:string}>('flow_artifacts',version.artifactId)!;assert.equal(await readFile(path.join(artifact.root,'brief.md'),'utf8'),'原材料：活动文案。');assert.equal(await workspaceFingerprint(h.original),before);await writeFile(path.join(h.original,'brief.md'),'后来修改');assert.equal((await h.get(d.topic.id)).review!.review.status,'completed');assert.equal(await workspaceFingerprint(artifact.root),version.fingerprint);
    for(const [id,scope] of [['roundtable-project-notice',{projectId:d.topic.projectId}],['roundtable-topic-notice',{threadId:d.topic.id}],['other-roundtable-notice',{projectId:'another-project'}]] as const)h.engine.store.put('attention_dismissals',id,{id,...scope,fingerprint:'saved',dismissedAt:new Date().toISOString()});
    await h.act(d.topic.id,'confirm',{conclusionId:done.topic.conclusion!.id});await h.act(d.topic.id,'end');await h.act(d.topic.id,'delete');await access(path.join(h.original,'brief.md'));assert.equal(h.engine.store.list('roundtable_topics').length,0);assert.equal(h.engine.snapshot().roundtable!.currentTopicId,undefined);assert.deepEqual(h.engine.store.list<{id:string}>('attention_dismissals').map(i=>i.id),['other-roundtable-notice']);assert.ok(!h.engine.snapshot().attention!.items.some(i=>i.projectId===d.topic.projectId));}finally{await h.dispose();}
});
test('dropped images are actual image inputs when supported, persisted material survives restart',async()=>{
  const h=await roundtableHarness();let restarted:Engine|undefined;try{const image=path.join(h.original,'reference.png');await writeFile(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/b6sAAAAASUVORK5CYII=','base64'));const attachments=await h.engine.invoke('attachment.import',{paths:[image]});const d=await h.open({kind:'review',material:{text:'评审参考图；不宣称看过无法读取的图片',attachments}});await h.minutes(d.topic.id);const independent=h.calls.filter(c=>c.kind==='joint-independent');assert.equal(independent.length,3);assert.ok(independent.filter(c=>c.ctx.run.provider!=='dsh').every(c=>c.ctx.attachments?.length===1));assert.ok(independent.find(c=>c.ctx.run.provider==='dsh')!.prompt.includes('收不到图片内容'));await h.engine.close();const before=h.calls.length;restarted=new Engine(h.data,()=>{},()=>{},h.factory);await restarted.probe();const re=await restarted.invoke('roundtable.get',{topicId:d.topic.id}) as RoundtableDetail;assert.equal(re.topic.material.attachments!.length,1);await access(path.join(h.data,'attachments',re.topic.material.attachments![0].id,'reference.png'));assert.equal(h.calls.length,before);}finally{await restarted?.close();await h.dispose();}
});
test('the same open request is idempotent and changed arguments cannot reuse it',async()=>{
  const h=await roundtableHarness();try{const p={requestId:'fixed-open',kind:'proposals',title:'比较',material:{text:'甲乙几种非工程方案'},memberIds:['codex','claude'],synthesizerId:'codex'},first=await h.engine.invoke('roundtable.open',p);assert.deepEqual(await h.engine.invoke('roundtable.open',p),first);await assert.rejects(h.engine.invoke('roundtable.open',{...p,title:'换议题'}),/请求编号/);assert.equal(h.engine.store.list('roundtable_topics').length,1);}finally{await h.dispose();}
});

test('candidate decisions reject failed, blank and foreign slots even when their old IDs remain selectable',async()=>{
  const h=await roundtableHarness();try{
    const opened=await h.open(),d=await h.wait(opened.topic.id,d=>d.review?.review.status==='awaiting_decision');
    const decision=d.review!.decisions.find(item=>item.kind==='candidate')!,slot=d.review!.slots.find(item=>item.id===decision.candidateSlotIds[0])!;
    for(const patch of [{status:'blocked'},{opinion:{...slot.opinion,proposal:'  '}},{jointReviewId:'another-review'}]){
      h.engine.store.put('flow_joint_slots',slot.id,{...slot,...patch});
      await assert.rejects(h.act(d.topic.id,'decide',{decisionId:decision.id,choice:'select',slotId:slot.id,opinion:'核对候选'}),/失败或空白稿件不能采用/);
      assert.equal(h.engine.store.get<any>('flow_joint_decisions',decision.id)?.status,'open');
    }
    h.engine.store.put('flow_joint_slots',slot.id,slot);await h.choose(d.topic.id);
  }finally{await h.dispose();}
});
test('saved project plan and artifact versions are copied as references with no project-flow mutation',async()=>{
  const h=await roundtableHarness();try{const project=await h.engine.invoke('project.create',{directory:h.original}) as Project,plan={id:'saved-plan',projectId:project.id,version:2,revision:4,objective:'市场策划',scope:'文字内容',tasks:[],rounds:[]};h.engine.store.put('flow_plans',plan.id,plan);
    const d=await h.engine.invoke('project.toRoundtable',{requestId:'plan-material',projectId:project.id,source:{planId:plan.id},kind:'review',title:'方案圆桌',memberIds:['codex','claude'],synthesizerId:'codex'}) as RoundtableDetail;await h.minutes(d.topic.id);assert.equal(d.topic.material.source!.planId,plan.id);assert.match(d.topic.material.text!,/"version":2/);assert.deepEqual(h.engine.store.get('flow_plans',plan.id),plan);assert.equal(h.engine.store.list('project_flows').length,0);
    const artifact=await (h.engine as any).projectFlow.artifacts.capture({id:'saved-flow',projectId:project.id},h.original,'submission');h.engine.store.put('flow_submissions','sub',{id:'sub',projectId:project.id,taskId:'author-task',version:{artifactId:artifact.id,fingerprint:artifact.fingerprint,baselineId:artifact.baselineId}});h.engine.store.put('flow_tasks','author-task',{id:'author-task',memberId:'dsh'});
    const candidate=await h.engine.invoke('project.toRoundtable',{requestId:'saved-subject',projectId:project.id,source:{submissionId:'sub'},kind:'review',memberIds:['codex','claude'],synthesizerId:'codex'}) as RoundtableDetail;await h.minutes(candidate.topic.id);await writeFile(path.join(h.original,'brief.md'),'新版本内容');assert.equal((await h.get(candidate.topic.id)).review!.review.status,'completed');assert.equal(h.calls.filter(c=>c.kind==='author-response'&&c.ctx.run.projectId===candidate.topic.projectId).length,1,'the original author has a separate reply stage');
  }finally{await h.dispose();}
});
test('explicit carryback adds a linked project material without calls, and a new plan waits for confirmation',async()=>{
  const h=await roundtableHarness();try{const d=await h.open({deliverablePath:'candidate.md'}),confirmed=await h.confirm(d.topic.id),project=await h.engine.invoke('project.create',{directory:h.original,name:'后续项目'}) as Project;const before=h.calls.length,files=await workspaceFingerprint(h.original);const p={requestId:'carry-material',topicId:d.topic.id,expectedRevision:confirmed.topic.revision,projectId:project.id,as:'material'},result=await h.engine.invoke('roundtable.handoff',p) as {messageId:string};assert.equal(h.calls.length,before);assert.deepEqual(await h.engine.invoke('roundtable.handoff',p),result);assert.equal(h.engine.store.get<any>('room_messages',result.messageId).roundtable.topicId,d.topic.id);assert.equal(await workspaceFingerprint(h.original),files);
    await h.act(d.topic.id,'handoff',{projectId:project.id,as:'plan'});let flow!:ProjectFlowSnapshot;for(let i=0;i<300;i++){flow=await h.engine.invoke('projectFlow.get',{projectId:project.id}) as ProjectFlowSnapshot;if(flow.plan)break;await new Promise(r=>setTimeout(r,15));}assert.equal(flow.plan!.status,'awaiting_confirmation');assert.equal(flow.flow!.sourceRoundtable!.topicId,d.topic.id);const planning=h.calls.find(c=>c.kind==='plan')!;assert.equal(planning.material.sourceRoundtable.selection.selectedSlotId,confirmed.review!.review.selectedSlotId);assert.equal(await workspaceFingerprint(h.original),files);assert.equal(h.engine.store.list('flow_tasks').length,0);
  }finally{await h.dispose();}
});
test('unknown native review does not replay on restart',async()=>{
  const h=await roundtableHarness({handler:async c=>c.kind==='joint-independent'&&c.ctx.run.provider==='codex'?{nativeResult:{unknown:true}}:undefined});let restarted:Engine|undefined;
  try{const d=await h.open(),blocked=await h.wait(d.topic.id,d=>d.review?.review.status==='blocked');assert.equal(blocked.revealed,false);await assert.rejects(h.act(d.topic.id,'end'),/核对/);await h.engine.close();const before=h.calls.length;restarted=new Engine(h.data,()=>{},()=>{},h.factory);await restarted.probe();await new Promise(r=>setTimeout(r,60));assert.equal(h.calls.length,before);const current=await restarted.invoke('roundtable.get',{topicId:d.topic.id}) as RoundtableDetail;assert.equal(current.review!.review.status,'blocked');assert.equal(current.review!.review.dispatchMode,'paused');}finally{await restarted?.close();await h.dispose();}
});

test('stop-all pauses an awaiting-host roundtable, switching topics cannot route a vote to another meeting',async()=>{
  const h=await roundtableHarness();h.setClose(false);try{
    const first=await h.open({handRaise:true});await h.wait(first.topic.id,d=>h.engine.store.roomState(d.topic.roomId).discussion?.phase==='awaiting-host');
    const firstDiscussion=h.engine.store.roomState(first.topic.roomId).discussion!;const second=await h.open({kind:'review',memberIds:['codex','claude'],handRaise:true});await h.wait(second.topic.id,d=>h.engine.store.roomState(d.topic.roomId).discussion?.phase==='awaiting-host');
    await h.act(second.topic.id,'select');await assert.rejects(h.engine.invoke('room.host',{roomId:second.topic.roomId,discussionId:firstDiscussion.id,expectedRevision:firstDiscussion.revision,handRoundId:firstDiscussion.handRound!.id,choice:'member',memberId:'codex'}),/改变|轮|讨论|过期/);
    await h.engine.stopAll();const count=h.calls.length;assert.equal(h.engine.store.roomState(first.topic.roomId).discussion!.phase,'paused');assert.equal(h.engine.store.roomState(second.topic.roomId).discussion!.phase,'paused');await new Promise(r=>setTimeout(r,50));assert.equal(h.calls.length,count);await h.act(first.topic.id,'end');await h.act(first.topic.id,'delete');assert.equal((await h.get(second.topic.id)).topic.id,second.topic.id);assert.equal(h.engine.snapshot().roundtable!.currentTopicId,second.topic.id);
  }finally{await h.dispose();}
});

test('the conversation stop interrupts only the current topic independent calls and does not replay them',async()=>{
  const h=await roundtableHarness({handler:async c=>{if(c.kind==='joint-independent')await new Promise<void>(resolve=>c.release=resolve);}});
  try{
    const original=await workspaceFingerprint(h.original),first=await h.open({memberIds:['claude','dsh'],synthesizerId:'codex',peerReview:false});
    await h.wait(first.topic.id,()=>h.calls.filter(c=>c.kind==='joint-independent'&&c.ctx.run.projectId===first.topic.projectId).length===2);
    const second=await h.open({memberIds:['codex'],synthesizerId:'codex',peerReview:false});
    await h.wait(second.topic.id,()=>h.calls.some(c=>c.kind==='joint-independent'&&c.ctx.run.projectId===second.topic.projectId));
    await h.engine.invoke('room.stop',{roomId:first.topic.roomId});
    const stopped=await h.wait(first.topic.id,d=>d.review?.review.status==='blocked');
    assert.equal(stopped.review!.review.dispatchMode,'paused');assert.equal(stopped.topic.pauseRequested,true);
    assert.ok(h.calls.filter(c=>c.ctx.run.projectId===first.topic.projectId).every(c=>c.stopped));
    const peer=h.calls.find(c=>c.ctx.run.projectId===second.topic.projectId)!;assert.equal(peer.stopped,false);
    assert.equal(h.engine.store.get<Run>('runs',peer.ctx.run.id)!.status,'running');
    const count=h.calls.length;await new Promise(r=>setTimeout(r,80));assert.equal(h.calls.length,count);
    await assert.rejects(h.act(first.topic.id,'resume'),/核对|重发/);assert.equal(h.calls.length,count);
    assert.equal(await workspaceFingerprint(h.original),original);
  }finally{for(const call of h.calls)call.release();await h.dispose();}
});

test('stopping material preparation publishes the topic and prevents dispatch until explicit resume',async()=>{
  const snapshots:any[]=[],h=await roundtableHarness({push:s=>snapshots.push(s)}),artifacts=(h.engine as any).projectFlow.artifacts,originalCapture=artifacts.capture;
  let release!:()=>void,entered!:()=>void,held=false;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
  artifacts.capture=async function(record:any,root:string,kind:string,...args:any[]){if(!held&&kind==='base'&&record.projectId.startsWith('roundtable-')){held=true;entered();await gate;}return originalCapture.call(this,record,root,kind,...args);};
  let opening:Promise<RoundtableDetail>|undefined;
  try{
    opening=h.open({memberIds:['codex','claude'],peerReview:false});await ready;
    const topic=h.engine.snapshot().roundtable!.topics[0];assert.equal(topic.status,'preparing');
    assert.ok(snapshots.some(s=>s.roundtable?.topics.some((t:any)=>t.id===topic.id&&t.status==='preparing'&&t.openingRequestId)));
    await h.engine.invoke('room.stop',{roomId:topic.roomId});release();const prepared=await opening;
    assert.equal(prepared.topic.pauseRequested,true);assert.equal(prepared.review!.review.dispatchMode,'paused');
    assert.equal(h.calls.length,0);await new Promise(r=>setTimeout(r,80));assert.equal(h.calls.length,0);
    await h.act(topic.id,'resume');await h.wait(topic.id,()=>h.calls.length>0);
    assert.equal((await h.get(topic.id)).topic.pauseRequested,false);
  }finally{release();await opening;artifacts.capture=originalCapture;await h.dispose();}
});

test('a selected saved file is copied alone, missing files do not dispatch and failed preparation can be deleted',async()=>{
  const h=await roundtableHarness();try{
    await writeFile(path.join(h.original,'other.md'),'不应进入评审');const project=await h.engine.invoke('project.create',{directory:h.original}) as Project;
    const d=await h.engine.invoke('project.toRoundtable',{requestId:'one-file',projectId:project.id,source:{path:'brief.md'},kind:'review',memberIds:['codex','claude'],synthesizerId:'codex'}) as RoundtableDetail;await h.minutes(d.topic.id);
    const material=h.engine.store.get<{root:string}>('flow_artifacts',(await h.get(d.topic.id)).topic.materialVersion!.artifactId)!;assert.equal(await readFile(path.join(material.root,'brief.md'),'utf8'),'原材料：活动文案。');await assert.rejects(access(path.join(material.root,'other.md')),/ENOENT/);
    const before=h.calls.length,missing=await h.engine.invoke('project.toRoundtable',{requestId:'missing-file',projectId:project.id,source:{path:'missing.md'},kind:'review',memberIds:['codex','claude'],synthesizerId:'codex'}) as RoundtableDetail;assert.equal(missing.topic.status,'blocked');assert.match(missing.topic.error!,/不存在/);assert.equal(h.calls.length,before);await h.act(missing.topic.id,'end');await h.act(missing.topic.id,'delete');await access(path.join(h.original,'other.md'));
  }finally{await h.dispose();}
});

test('a new discussion invalidates old plan and H1 confirmation while prepared additions never execute before confirmation',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r),h=await roundtableHarness({handler:async c=>{if(c.kind==='submission')await gate;}});
  try{
    const d=await h.open({deliverablePath:'candidate.md'});await h.confirm(d.topic.id);const project=await h.engine.invoke('project.create',{directory:h.original}) as Project;await h.act(d.topic.id,'handoff',{projectId:project.id,as:'plan'});
    let flow!:ProjectFlowSnapshot;for(let i=0;i<300;i++){flow=await h.engine.invoke('projectFlow.get',{projectId:project.id}) as ProjectFlowSnapshot;if(flow.plan)break;await new Promise(r=>setTimeout(r,15));}
    const oldPlan=flow.plan!;await h.act(d.topic.id,'discuss');await assert.rejects(h.engine.invoke('projectFlow.plan.confirm',{requestId:'old-roundtable-confirm',planId:oldPlan.id,expectedRevision:oldPlan.revision}),/结论.*改变|旧结论/);
    const next=await h.minutes(d.topic.id);await h.act(d.topic.id,'confirm',{conclusionId:next.topic.conclusion!.id});
    // Start a normal plan, leaving its file tasks in flight while H1 is prepared.
    const additionDirectory=path.join(h.root,'addition-project');await mkdir(additionDirectory);await writeFile(path.join(additionDirectory,'brief.md'),'独立的追加项目材料');const other=await h.engine.invoke('project.create',{directory:additionDirectory,name:'追加项目'}) as Project;await h.engine.invoke('projectFlow.start',{requestId:'addition-plan',projectId:other.id,topic:'文案',leadMemberId:'codex',memberIds:['codex','claude','dsh']});for(let i=0;i<300;i++){flow=await h.engine.invoke('projectFlow.get',{projectId:other.id}) as ProjectFlowSnapshot;if(flow.plan)break;await new Promise(r=>setTimeout(r,15));}
    await h.engine.invoke('projectFlow.plan.confirm',{requestId:'addition-plan-confirm',planId:flow.plan!.id,expectedRevision:flow.plan!.revision});const before=h.engine.store.list('flow_tasks').length;await h.act(d.topic.id,'handoff',{projectId:other.id,as:'task',memberId:'claude'});
    let proposal!:TaskAddition;for(let i=0;i<300;i++){proposal=h.engine.store.list<TaskAddition>('flow_task_additions').at(-1)!;if(proposal?.status==='ready')break;await new Promise(r=>setTimeout(r,15));}assert.equal(proposal.status,'ready');assert.equal(h.engine.store.list('flow_tasks').length,before);assert.equal(proposal.sourceRoundtable!.conclusionId,next.topic.conclusion!.id);assert.ok(h.calls.find(c=>c.kind==='task-addition')!.material.sourceRoundtable.selection.selectedSlotId);
    await h.act(d.topic.id,'discuss');await assert.rejects(h.engine.invoke('projectFlow.task.add',{requestId:'old-addition-confirm',proposalId:proposal.id,expectedRevision:proposal.revision}),/结论.*改变|旧结论/);assert.equal(h.engine.store.list('flow_tasks').length,before);assert.equal(await readFile(path.join(h.original,'brief.md'),'utf8'),'原材料：活动文案。');
  }finally{release();await h.dispose();}
});

test('backup restoration retains roundtable history without continuing meetings or using unbacked-up copies',async()=>{
  const h=await roundtableHarness();let restored:Engine|undefined;try{
    const d=await h.open({kind:'review'});await h.minutes(d.topic.id);await h.engine.close();const backup=await fixtureBackup(h.data,'manual'),restorer=new BackupRestorer(h.data),prepared=await restorer.prepare(backup.id),before=await fixtureBackup(h.data,'before-restore');await restorer.apply(prepared.token,before.id);
    const calls=h.calls.length;restored=new Engine(h.data,()=>{},()=>{},h.factory);await restored.probe();const history=await restored.invoke('roundtable.get',{topicId:d.topic.id}) as RoundtableDetail;assert.equal(history.topic.restoredHistoryOnly,true);assert.equal(history.topic.status,'ended');assert.ok(history.topic.conclusion!.body);assert.equal(restored.store.roomState(d.topic.roomId).discussion!.phase,'idle');assert.equal(h.calls.length,calls);
    await assert.rejects(restored.invoke('roundtable.discuss',{requestId:'restored-resume',topicId:d.topic.id,expectedRevision:history.topic.revision}),/只供阅读/);await assert.rejects(restored.invoke('roundtable.artifact.files',{topicId:d.topic.id}),/备份不包含/);assert.equal((await restored.invoke('roundtable.export',{topicId:d.topic.id}) as {content:string}).content.includes('少数意见'),true);
  }finally{await restored?.close();await h.dispose();}
});
