import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/backend/engine';
import type { Adapter, AdapterContext, Project, RoomId, RoomMessage } from '../src/shared/types';
import type { Plan, PlanPayload, ProjectFlowSnapshot } from '../src/shared/project-flow';

async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM flow-meeting-')),prompts:string[]=[];
  const factory=(id:AdapterContext['run']['provider']):Adapter=>({probe:async()=>({id,name:id,available:true,auth:'subscription',detail:'fixture',capabilities:{steer:false,cancel:'native',streaming:true,write:true,history:true}}),stop:async()=>{},start:async(ctx,prompt)=>{
    ctx.markDelivery('confirmed');prompts.push(prompt);
    const payload:PlanPayload={objective:`方案 ${prompts.length}`,scope:'a.txt',deliverables:['a.txt'],acceptanceCriteria:['内容正确'],rounds:[{key:'r1',title:'第一轮',goal:'修改文件',requiresUserAcceptance:true}],tasks:[{key:'a',roundKey:'r1',title:'修改 A',memberId:'claude',goal:'修改文件',inputs:[],completionCriteria:['内容正确'],dependencies:[],allowedPaths:['a.txt']}]};
    ctx.emit('delta',JSON.stringify({protocol:'airoom.project-flow',version:1,kind:'plan',payload}));return {};
  }});
  const engine=new Engine(path.join(root,'data'),()=>{},()=>{},factory);await engine.probe();const projects:Project[]=[];
  for(const name of ['Alpha','Beta']){const directory=path.join(root,name);await mkdir(directory);projects.push(await engine.invoke('project.create',{directory,name}) as Project);}
  const rooms=projects.map(project=>`project:${project.id}` as RoomId),threads=rooms.map(room=>engine.store.currentRoomThread(room));
  const put=(room:number,message:Partial<RoomMessage>&Pick<RoomMessage,'id'|'text'>)=>engine.store.roomScope(rooms[room]).put('room_messages',message.id,{author:'user',status:'done',at:new Date().toISOString(),threadId:threads[room].id,...message});
  const start=(extra:Record<string,unknown>={})=>engine.invoke('projectFlow.start',{requestId:crypto.randomUUID(),projectId:projects[0].id,topic:'起草方案',leadMemberId:'codex',memberIds:['codex','claude'],...extra});
  const state=()=>engine.invoke('projectFlow.get',{projectId:projects[0].id}) as Promise<ProjectFlowSnapshot>;
  async function waitFor(check:(data:ProjectFlowSnapshot)=>boolean){const deadline=Date.now()+6000;for(;;){const data=await state();if(check(data))return data;if(Date.now()>deadline)assert.fail('planning did not settle');await new Promise(resolve=>setTimeout(resolve,10));}}
  return {engine,projects,rooms,threads,prompts,put,start,state,waitFor,root,dispose:async()=>{await engine.close();await rm(root,{recursive:true,force:true});}};
}
const material=(prompt:string)=>JSON.parse(prompt.split('\n任务材料：')[1]);

test('a plan can start from completed member discussion without a user-written topic',async()=>{
  const h=await fixture();try{
    h.put(0,{id:'member-topic',author:'claude',text:'我们已讨论好，只修改 A 的内容。'});
    h.put(1,{id:'foreign-topic',author:'codex',text:'另一个项目的目标不能被采用。'});
    await h.start({topic:undefined});const data=await h.waitFor(data=>Boolean(data.plan)),context=material(h.prompts[0]);
    assert.match(data.flow!.topic!,/项目会议.*讨论/);assert.equal(context.topic,data.flow!.topic);
    assert.deepEqual(context.discussion.messages.map((message:RoomMessage)=>message.id),['member-topic']);
    assert.equal(JSON.stringify(context).includes('另一个项目的目标'),false);
  }finally{await h.dispose();}
});

test('a missing or blank topic needs usable project discussion; invalid types and unfinished text do not dispatch',async()=>{
  const h=await fixture();try{
    h.put(0,{id:'unfinished-topic',author:'claude',status:'speaking',text:'尚未提交的内容'});
    h.put(0,{id:'system-topic',system:true,text:'系统状态'});
    h.put(1,{id:'foreign-topic',author:'user',text:'外部项目的讨论'});
    for(const topic of [undefined,'  '])await assert.rejects(h.start({topic}),/先.*会议.*讨论|填写.*topic/);
    assert.equal(h.prompts.length,0);assert.equal(h.engine.store.list('project_flows').length,0);
    h.put(0,{id:'valid-topic',author:'claude',text:'目标是修改 A'});
    for(const topic of [null,0,{}])await assert.rejects(h.start({topic}),/文字字段/);
    await h.start({topic:'  '});await h.waitFor(data=>Boolean(data.plan));assert.equal(h.prompts.length,1);
  }finally{await h.dispose();}
});

test('a new topic omitted after a finished flow uses only subsequent discussion rather than restarting the old goal',async()=>{
  const h=await fixture();try{
    const end=new Date(Date.now()-1000).toISOString(),old=new Date(Date.now()-2000).toISOString();
    h.engine.store.put('project_flows','previous',{id:'previous',flowId:'previous',projectId:h.projects[0].id,schemaVersion:1,revision:1,createdAt:old,updatedAt:end,status:'completed',dispatchMode:'paused',leadMemberId:'codex',memberIds:['codex','claude'],roomId:h.rooms[0],topic:'旧目标',blockedReasons:[]});
    h.put(0,{id:'old-topic',at:old,text:'之前的目标已经完成，不要重新执行。'});
    h.engine.store.put('room_threads',h.threads[0].id,{...h.threads[0],summary:{text:'旧讨论的压缩摘要不应自动成为新目标。',by:'codex',at:new Date().toISOString(),upTo:'old-topic',count:1}});
    await assert.rejects(h.start({topic:undefined}),/先.*会议.*讨论|填写.*topic/);assert.equal(h.prompts.length,0);
    h.put(0,{id:'fresh-topic',author:'claude',text:'新讨论决定修改 A 的新部分。'});
    await h.start({topic:undefined});await h.waitFor(data=>Boolean(data.plan));
    assert.deepEqual(material(h.prompts[0]).discussion.messages.map((message:RoomMessage)=>message.id),['fresh-topic']);
    assert.equal(JSON.stringify(material(h.prompts[0])).includes('之前的目标'),false);
  }finally{await h.dispose();}
});

test('a completed compressed discussion can supply an omitted topic while empty background cannot',async()=>{
  const h=await fixture();try{
    h.engine.store.put('room_threads',h.threads[0].id,{...h.threads[0],summary:{text:'  ',by:'codex',at:new Date().toISOString(),count:1}});
    await assert.rejects(h.start({topic:undefined}),/先.*会议.*讨论|填写.*topic/);
    h.engine.store.put('room_threads',h.threads[0].id,{...h.threads[0],summary:{text:'讨论结论：修改 A 并保留兼容性。',by:'codex',at:new Date().toISOString(),count:1}});
    await h.start({topic:undefined});await h.waitFor(data=>Boolean(data.plan));
    assert.equal(material(h.prompts[0]).discussion.background,'讨论结论：修改 A 并保留兼容性。');
  }finally{await h.dispose();}
});

test('a completed meeting minute alone can supply an omitted topic and remains scoped to the selected project',async()=>{
  const h=await fixture();try{
    h.put(0,{id:'minute-topic',author:'claude',kind:'summary',text:'讨论结论：只修改 A，保留已有行为。'});
    await h.start({topic:undefined,minutesMessageId:'minute-topic'});const data=await h.waitFor(data=>Boolean(data.plan));
    assert.equal(data.flow!.discussionContext!.minutesMessageId,'minute-topic');
    assert.equal(data.flow!.discussionContext!.minutes!.text,'讨论结论：只修改 A，保留已有行为。');
    assert.deepEqual(data.flow!.discussionContext!.messages,[]);
  }finally{await h.dispose();}
});

test('planning captures completed meeting minutes and subsequent remarks from its own project room',async()=>{
  const h=await fixture();try{
    h.put(0,{id:'before',text:'会议原始讨论'});h.put(0,{id:'minutes',author:'claude',kind:'summary',text:'结论：只改 A，尚未确定发布时间。'});h.put(0,{id:'after',text:'保留原来的配色。'});h.put(1,{id:'foreign',text:'另一个项目的私有材料'});
    h.engine.store.put('room_states',h.rooms[0],{active:false,mode:'discuss',discussion:{id:'meeting',members:['codex','claude'],phase:'idle',revision:1,seen:{},lastSpoke:{},priority:[],calls:0,limit:0,allowance:0,minutes:0,deadline:0,questions:[],reviewRequired:[],noProgress:0,latestUserId:'before',meetingMinutes:{status:'done',messageId:'minutes',proposalId:'closure',memberId:'claude'}}});
    await h.start({threadId:h.threads[0].id});const data=await h.waitFor(data=>Boolean(data.plan));
    const context=material(h.prompts[0]).discussion;
    assert.equal(context.minutesMessageId,'minutes');assert.equal(context.minutes.text,'结论：只改 A，尚未确定发布时间。');assert.deepEqual(context.messages.map((message:RoomMessage)=>message.id),['after']);assert.equal(JSON.stringify(context).includes('私有材料'),false);
    assert.deepEqual(data.flow!.discussionContext,context);assert.equal(data.flow!.threadId,h.threads[0].id);assert.equal(data.flow!.topic,'起草方案');
    await h.engine.invoke('room.clear',{roomId:h.rooms[0]});h.put(0,{id:'new-topic',text:'后续讨论，不能改写旧方案依据'});
    await h.engine.invoke('projectFlow.plan.revise',{requestId:'revise',planId:data.plan!.id,expectedRevision:data.plan!.revision,instruction:'补充验收要求'});
    await h.waitFor(data=>data.plan?.version===2);assert.deepEqual(material(h.prompts[1]).discussion,context);
  }finally{await h.dispose();}
});

test('without minutes planning includes compressed background and completed discussion, excluding stale and flow cards',async()=>{
  const h=await fixture();try{
    h.put(0,{id:'compressed',text:'已压缩的旧讨论'});h.engine.store.put('room_threads',h.threads[0].id,{...h.threads[0],summary:{text:'确定范围为 A，仍需讨论验收。',by:'codex',at:'2026',upTo:'compressed',count:1}});
    h.put(0,{id:'user',text:'验收要覆盖旧数据。'});h.put(0,{id:'member',author:'claude',text:'建议增加迁移验证。'});
    h.put(0,{id:'legacy-user',text:'也保留早期用户记录。',status:undefined});
    h.put(0,{id:'stale',author:'codex',text:'过期结果',discussionStale:true});h.put(0,{id:'unfinished',text:'未完成',status:'speaking'});h.put(0,{id:'system',text:'内部提醒',system:true});h.put(0,{id:'flow',text:'既有方案卡片',flowPlan:{flowId:'old',planId:'old-plan',version:1}});
    await h.start({threadId:h.threads[0].id});await h.waitFor(data=>Boolean(data.plan));const context=material(h.prompts[0]).discussion;
    assert.equal(context.background,'确定范围为 A，仍需讨论验收。');assert.deepEqual(context.messages.map((message:RoomMessage)=>message.id),['user','member','legacy-user']);assert.equal(context.minutesMessageId,undefined);
  }finally{await h.dispose();}
});

test('foreign, incomplete, stale or oversized discussion materials fail before any model dispatch',async()=>{
  const h=await fixture();try{
    h.put(1,{id:'foreign-minutes',kind:'summary',text:'Beta 纪要'});h.put(0,{id:'unfinished',kind:'summary',text:'未完成纪要',status:'speaking'});h.put(0,{id:'stale',kind:'summary',text:'过期纪要',discussionStale:true});
    await assert.rejects(h.start({threadId:h.threads[1].id}),/不属于当前项目/);
    for(const minutesMessageId of ['foreign-minutes','unfinished','stale','missing'])await assert.rejects(h.start({minutesMessageId}),/所选会议纪要/);
    h.put(0,{id:'large',text:'讨论'.repeat(31000)});await assert.rejects(h.start(),/先压缩/);
    assert.equal(h.prompts.length,0);assert.equal(h.engine.store.list('project_flows').length,0);assert.equal(h.engine.store.list('flow_requests').length,0);
  }finally{await h.dispose();}
});

test('plan history is scoped and ordered, with durable room cards that do not return after clearing or restarting',async()=>{
  const h=await fixture();try{
    await h.start();const first=await h.waitFor(data=>Boolean(data.plan)&&h.engine.store.roomView(h.rooms[0]).messages.some(message=>message.flowPlan));
    await h.engine.invoke('projectFlow.plan.revise',{requestId:'second',planId:first.plan!.id,expectedRevision:first.plan!.revision,instruction:'修改验收要求'});
    const second=await h.waitFor(data=>data.plan?.version===2&&h.engine.store.roomView(h.rooms[0]).messages.filter(message=>message.flowPlan).length===2);
    assert.deepEqual(second.plans.map(plan=>[plan.version,plan.objective,plan.roundCount,plan.taskCount]),[[1,'方案 1',1,1],[2,'方案 2',1,1]]);assert.equal('tasks' in second.plans[0],false);
    const old=await h.engine.invoke('projectFlow.detail',{kind:'plan',id:second.plans[0].id,projectId:h.projects[0].id}) as Plan;assert.equal(old.tasks.length,1);
    await assert.rejects(h.engine.invoke('projectFlow.detail',{kind:'plan',id:old.id,projectId:h.projects[1].id}),/不属于当前项目/);
    assert.equal(h.engine.store.roomView(h.rooms[1]).messages.length,0);assert.equal(h.engine.snapshot().room.messages.length,0);
    await h.engine.invoke('room.clear',{roomId:h.rooms[0]});h.engine.store.delete('room_migrations','flow-cards-v1');await h.engine.close();let dispatched=0;
    const restarted=new Engine(path.join(h.root,'data'),()=>{},()=>{},()=>({probe:async()=>{throw new Error('no probe');},start:async()=>{dispatched++;return {};},stop:async()=>{}}));
    try{const data=await restarted.invoke('projectFlow.get',{projectId:h.projects[0].id}) as ProjectFlowSnapshot;assert.equal(data.plans.length,2);assert.equal(data.flow!.dispatchMode,'paused');assert.equal(restarted.store.roomView(h.rooms[0]).messages.length,0);assert.equal(dispatched,0);}finally{await restarted.close();}
  }finally{await h.dispose();}
});
