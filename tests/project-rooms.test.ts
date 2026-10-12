import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/backend/store';
import { Engine } from './helpers/seeded-engine';
import { migrateRoundReports, stageRoundReport, publishRoundReports } from '../src/backend/project-room-reports';
import type { Round, ProjectFlow } from '../src/shared/project-flow';
import type { Adapter, AdapterContext, Project, RoomId, RoomMessage, RoomState, Run, Session } from '../src/shared/types';

async function waitFor(check:()=>boolean){const until=Date.now()+6000;while(!check()){if(Date.now()>until)assert.fail('room did not settle');await new Promise(r=>setTimeout(r,10));}}
const view=(engine:Engine,roomId:RoomId)=>engine.store.roomView(roomId);
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM project-rooms-'));
  const calls:{ctx:AdapterContext;prompt:string;input:any;release:()=>void;stopped:boolean}[]=[];
  const factory=(id:AdapterContext['run']['provider']):Adapter=>{
    let call:typeof calls[number]|undefined;
    return {probe:async()=>({id,name:id,available:true,auth:'subscription',detail:'fixture',capabilities:{steer:false,cancel:'native',streaming:true,write:true,history:true,imageGeneration:true}}),
      start:async(ctx,prompt)=>{
        ctx.markDelivery('confirmed');let release!:()=>void;const gate=new Promise<void>(r=>release=r);
        const input=prompt.includes('\nAIROOM_CONTEXT\n')?JSON.parse(prompt.split('\nAIROOM_CONTEXT\n')[1]):prompt.includes('\nAIROOM_HAND_CONTEXT\n')?JSON.parse(prompt.split('\nAIROOM_HAND_CONTEXT\n')[1]):{};
        call={ctx,prompt,input,release,stopped:false};calls.push(call);await gate;
        if(call.stopped)return {stopped:true};
        if(ctx.session.purpose==='room-summary')ctx.emit('delta',`摘要 ${ctx.session.roomId}`);
        else if(ctx.session.purpose==='room-hand')ctx.emit('delta',JSON.stringify({want:1,why:'需要核对'}));
        else if(ctx.run.imageGeneration)ctx.emit('delta','没有生成图片');
        else ctx.emit('delta',input.turn?JSON.stringify({version:1,turn:input.turn,revision:input.revision,action:'speak',body:`回复 ${ctx.session.roomId}`}):'完成任务');
        return {};
      },stop:async()=>{if(call){call.stopped=true;call.release();}},
    };
  };
  const engine=new Engine(path.join(root,'data'),()=>{},()=>{},factory);await engine.probe();
  const projects:Project[]=[];for(const name of ['Alpha','Beta']){const directory=path.join(root,name);await mkdir(directory);projects.push(await engine.invoke('project.create',{directory,name}) as Project);}
  const rooms=projects.map(p=>`project:${p.id}` as RoomId);
  return {engine,projects,rooms,root,calls,dispose:async()=>{calls.forEach(c=>c.release());await engine.close();await rm(root,{recursive:true,force:true});}};
}
const send=(engine:Engine,roomId:RoomId,text:string,extra:Record<string,unknown>={})=>engine.invoke('room.send',{roomId,mode:'discuss',text,memberIds:['codex'],maxCalls:1,...extra});

test('rooms-v1 migrates legacy history and state transactionally once, with one writable global truth',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM rooms-migrate-')),db=new DatabaseSync(path.join(root,'airoom.sqlite'));
  db.exec('CREATE TABLE entities(entity TEXT,id TEXT,value TEXT,PRIMARY KEY(entity,id));');
  const put=(entity:string,id:string,value:unknown)=>db.prepare('INSERT INTO entities VALUES(?,?,?)').run(entity,id,JSON.stringify(value));
  put('room_threads','old',{id:'old',title:'项目 Alpha',createdAt:'2026',archivedAt:'2027'});put('room_threads','current',{id:'current',title:'当前',createdAt:'2028'});
  put('room','current',{id:'current'});put('room','state',{active:true,mode:'chat',topic:'保留状态'});put('room_messages','m',{id:'m',threadId:'old',author:'user',text:'历史',at:'2026'});
  put('room_messages','unscoped',{id:'unscoped',author:'user',text:'更早的未分话题记录',at:'2025'});
  put('projects','p',{id:'p',name:'Alpha',directory:root,createdAt:'',collaborationPaused:false});db.close();
  let store=new Store(root);try{
    assert.equal(store.currentRoomThread().id,'current');assert.equal(store.roomThreads().length,3);assert.ok(store.roomThreads().every(t=>t.roomId==='global'));assert.equal(store.allRoomMessages('room-main')[0].id,'unscoped');assert.equal(store.roomState().topic,'保留状态');
    const project=store.currentRoomThread('project:p');assert.equal(project.projectId,'p');assert.equal(store.roomThreads('project:p').length,1);
    store.put('room','state',{active:false,mode:'chat',topic:'新真相'});
    const audit=new DatabaseSync(path.join(root,'airoom.sqlite'));assert.equal(JSON.parse((audit.prepare("SELECT value FROM entities WHERE entity='room' AND id='state'").get() as {value:string}).value).topic,'保留状态');audit.close();
    store.close();store=new Store(root);assert.equal(store.roomState().topic,'新真相');assert.equal(store.currentRoomThread('project:p').id,project.id);assert.equal(store.allRoomMessages('old')[0].text,'历史');
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test('room reads do not create meetings; explicit ensure is idempotent and rejects missing or hidden projects',async()=>{
  const h=await fixture();try{
    h.engine.store.put('projects','manual',{id:'manual',name:'manual',directory:h.root});
    await assert.rejects(h.engine.invoke('room.get',{roomId:'project:manual'}),/尚未创建/);
    const first=await h.engine.invoke('projectRoom.ensure',{projectId:'manual'});assert.deepEqual(await h.engine.invoke('projectRoom.ensure',{projectId:'manual'}),first);
    await assert.rejects(h.engine.invoke('room.get',{roomId:'project:missing'}));await assert.rejects(h.engine.invoke('room.get',{roomId:'wrong'}));
    const revision=view(h.engine,h.rooms[0]).state.revision;await h.engine.invoke('room.get',{roomId:h.rooms[0]});assert.equal(view(h.engine,h.rooms[0]).state.revision,revision);
  }finally{await h.dispose();}
});

test('a failed rooms-v1 migration rolls back threads, cursors and its marker',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM rooms-rollback-')),file=path.join(root,'airoom.sqlite');let db=new DatabaseSync(file);
  db.exec("CREATE TABLE entities(entity TEXT,id TEXT,value TEXT,PRIMARY KEY(entity,id));CREATE TRIGGER reject_cursor BEFORE INSERT ON entities WHEN NEW.entity='room_cursors' BEGIN SELECT RAISE(ABORT,'fixture migration failure');END;");
  db.prepare('INSERT INTO entities VALUES(?,?,?)').run('room_threads','old',JSON.stringify({id:'old',title:'历史',createdAt:''}));db.close();
  try{assert.throws(()=>new Store(root),/fixture migration failure/);db=new DatabaseSync(file);assert.equal(db.prepare("SELECT id FROM entities WHERE entity='room_migrations'").all().length,0);assert.equal(JSON.parse((db.prepare("SELECT value FROM entities WHERE entity='room_threads'").get() as {value:string}).value).roomId,undefined);db.exec('DROP TRIGGER reject_cursor');db.close();const recovered=new Store(root);assert.equal(recovered.currentRoomThread().id,'old');recovered.close();}
  finally{await rm(root,{recursive:true,force:true});}
});

test('queued hand votes and image generation can be stopped separately from another room',async()=>{
  const h=await fixture();try{
    await Promise.all(h.rooms.map(id=>send(h.engine,id,'需要举手',{memberIds:['codex','claude'],handRaise:true,hostPick:false,style:'meeting',maxCalls:12})));
    await waitFor(()=>{h.calls.filter(c=>!c.ctx.session.purpose).forEach(c=>c.release());return h.calls.filter(c=>c.ctx.session.purpose==='room-hand').length>=2;});
    const first=h.calls.find(c=>c.ctx.session.purpose==='room-hand')!.ctx.session.roomId!;await h.engine.invoke('room.stop',{roomId:first});
    const other=h.rooms.find(id=>id!==first)!;await waitFor(()=>h.calls.filter(c=>c.ctx.session.roomId===other&&c.ctx.session.purpose==='room-hand').length===2);
    assert.ok(h.calls.filter(c=>c.ctx.session.roomId===other).every(c=>!c.stopped));
    await h.engine.invoke('room.stop',{roomId:other});await waitFor(()=>h.rooms.every(id=>!view(h.engine,id).state.active));
    await h.engine.invoke('room.end',{roomId:first,discussionId:view(h.engine,first).state.discussion!.id});
    await h.engine.invoke('room.generateImage',{roomId:first,memberId:'codex',text:'一个房间'});await waitFor(()=>h.calls.some(c=>c.ctx.run.imageGeneration));
    await h.engine.invoke('room.stop',{roomId:other});const image=h.calls.find(c=>c.ctx.run.imageGeneration)!;assert.equal(image.stopped,false);
    await h.engine.invoke('room.stop',{roomId:first});assert.equal(image.stopped,true);await waitFor(()=>!view(h.engine,first).state.active);
  }finally{await h.dispose();}
});

test('three discussions run concurrently with isolated prompts, sessions, cursors and single-room stop',async()=>{
  const h=await fixture();try{
    await Promise.all([send(h.engine,h.rooms[0],'Alpha secret'),send(h.engine,h.rooms[1],'Beta secret'),send(h.engine,'global','Global secret')]);
    await waitFor(()=>h.calls.length===3);assert.equal(new Set(h.calls.map(c=>c.ctx.session.id)).size,3);assert.equal(new Set(h.calls.map(c=>c.ctx.cwd)).size,3);
    for(const call of h.calls){const own=call.ctx.session.roomId;assert.ok(own);assert.equal(call.ctx.settings.permissions.codex.commands,'deny');assert.equal(call.ctx.session.writeMode,false);
      const serialized=JSON.stringify(call.input);assert.match(serialized,new RegExp(own===h.rooms[0]?'Alpha secret':own===h.rooms[1]?'Beta secret':'Global secret'));assert.ok(!serialized.includes(own===h.rooms[0]?'Beta secret':'Alpha secret'));
    }
    await h.engine.invoke('room.get',{roomId:h.rooms[1]});await h.engine.invoke('room.stop',{roomId:h.rooms[0]});
    assert.equal(h.calls.find(c=>c.ctx.session.roomId===h.rooms[0])!.stopped,true);assert.ok(h.calls.filter(c=>c.ctx.session.roomId!==h.rooms[0]).every(c=>!c.stopped));
    h.calls.filter(c=>c.ctx.session.roomId!==h.rooms[0]).forEach(c=>c.release());await waitFor(()=>['global',...h.rooms].every(id=>!h.engine.store.roomState(id as RoomId).active));
    assert.ok(view(h.engine,h.rooms[1]).messages.some(m=>m.text===`回复 ${h.rooms[1]}`));assert.ok(h.engine.snapshot().room.messages.every(m=>!m.text.includes('Alpha')&&!m.text.includes('Beta')));
    assert.equal(view(h.engine,h.rooms[0]).state.discussion!.phase,'paused');
  }finally{await h.dispose();}
});

test('foreign topic/message references are rejected for reads, replies, reactions, handoffs and memory edits',async()=>{
  const h=await fixture();try{
    const a=view(h.engine,h.rooms[0]),b=view(h.engine,h.rooms[1]),message:RoomMessage={id:'foreign',threadId:b.threadId,author:'codex',text:'Beta-only',at:'',status:'done'};h.engine.store.put('room_messages',message.id,message);
    for(const method of ['room.history','room.export','room.rename','room.delete','room.compress','room.uninherit','memory.dismiss','memory.accept'])await assert.rejects(h.engine.invoke(method,{roomId:h.rooms[0],threadId:b.threadId,title:'bad'}),/房间/);
    for(const method of ['room.react','run.verdict','room.handoff'])await assert.rejects(h.engine.invoke(method,{roomId:h.rooms[0],messageId:message.id,projectId:h.projects[0].id,text:'bad',emoji:'👍'}),/房间/);
    await assert.rejects(send(h.engine,h.rooms[0],'cross reply',{replyTo:message.id}),/房间/);
    await assert.rejects(h.engine.invoke('room.handoff',{roomId:h.rooms[0],projectId:h.projects[1].id,memberId:'codex',threadId:a.threadId,text:'wrong project'}),/当前项目/);
    await assert.rejects(h.engine.invoke('room.archive',{roomId:h.rooms[0],inherit:true,from:b.threadId}),/房间/);
    assert.equal(view(h.engine,h.rooms[0]).messages.length,0);assert.equal(view(h.engine,h.rooms[1]).messages[0].text,'Beta-only');
  }finally{await h.dispose();}
});

test('project work completion returns to the originating room despite other room reads and activity',async()=>{
  const h=await fixture();try{
    const sent=await h.engine.invoke('room.handoff',{roomId:h.rooms[0],projectId:h.projects[0].id,memberId:'codex',text:'只检查 Alpha 的文件',writeMode:false}) as {runId:string};
    await waitFor(()=>h.calls.some(c=>c.ctx.run.id===sent.runId));
    await h.engine.invoke('room.get',{roomId:h.rooms[1]});await h.engine.invoke('room.get');
    h.calls.find(c=>c.ctx.run.id===sent.runId)!.release();await waitFor(()=>view(h.engine,h.rooms[0]).messages.some(m=>m.link?.runId===sent.runId&&m.link.outcome==='ended'));
    assert.equal(view(h.engine,h.rooms[1]).messages.length,0);assert.equal(h.engine.snapshot().room.messages.length,0);
  }finally{await h.dispose();}
});

test('clearing and compressing one room keeps the other room native context and history',async()=>{
  const h=await fixture();try{
    for(const id of h.rooms){await send(h.engine,id,`消息 ${id}`);await waitFor(()=>h.calls.some(c=>c.ctx.session.roomId===id));h.calls.find(c=>c.ctx.session.roomId===id)!.release();await waitFor(()=>!view(h.engine,id).state.active);}
    const beta=h.calls.find(c=>c.ctx.session.roomId===h.rooms[1])!.ctx.session.id;
    await assert.rejects(h.engine.invoke('room.archive',{roomId:h.rooms[0]}),/固定话题/);
    const compress=h.engine.invoke('room.compress',{roomId:h.rooms[0],memberId:'codex'});await waitFor(()=>h.calls.some(c=>c.ctx.session.purpose==='room-summary'));
    const summary=h.calls.find(c=>c.ctx.session.purpose==='room-summary')!;assert.match(summary.prompt,/项目会议室/);assert.ok(!summary.prompt.includes(`消息 ${h.rooms[1]}`));summary.release();await compress;
    assert.ok(h.engine.store.get('sessions',beta));assert.equal(view(h.engine,h.rooms[1]).messages.length,2);
    await h.engine.invoke('room.clear',{roomId:h.rooms[0]});assert.equal(view(h.engine,h.rooms[0]).messages.length,0);assert.equal(view(h.engine,h.rooms[1]).messages.length,2);assert.ok(h.engine.store.get('sessions',beta));
  }finally{await h.dispose();}
});

test('all-stop includes every room and restart keeps all discussions paused with no replay',async()=>{
  const h=await fixture();try{
    await Promise.all(h.rooms.map(id=>send(h.engine,id,'本房间待完成')));await waitFor(()=>h.calls.length===2);await h.engine.invoke('all.stop');await waitFor(()=>h.rooms.every(id=>!view(h.engine,id).state.active));assert.ok(h.calls.every(c=>c.stopped));
    await h.engine.close();let requests=0;const restarted=new Engine(path.join(h.root,'data'),()=>{},()=>{},()=>({probe:async()=>{throw new Error('no probe');},start:async()=>{requests++;return {};},stop:async()=>{}}));
    try{for(const id of h.rooms){assert.equal(view(restarted,id).state.active,false);assert.equal(view(restarted,id).state.discussion!.phase,'paused');}await new Promise(r=>setTimeout(r,100));assert.equal(requests,0);}finally{await restarted.close();}
  }finally{await h.dispose();}
});

test('room maintenance permits reads and rejects project-flow mutations before recording requests',async()=>{
  const h=await fixture();try{
    await h.engine.invoke('internal.restore.begin');
    for(const method of ['projectFlow.start','projectFlow.plan.confirm','projectFlow.round.accept','projectFlow.resume'])await assert.rejects(h.engine.invoke(method,{requestId:method,projectId:h.projects[0].id}),/正在备份或恢复资料/);
    assert.equal(h.engine.store.list('flow_requests').length,0);assert.equal(h.engine.store.list('project_flows').length,0);
    await h.engine.invoke('projectFlow.get',{projectId:h.projects[0].id});await h.engine.invoke('room.get',{roomId:h.rooms[0]});await h.engine.invoke('room.history',{roomId:h.rooms[1]});
    await assert.rejects(send(h.engine,h.rooms[0],'blocked'),/正在备份/);await h.engine.invoke('internal.restore.cancel');
  }finally{await h.dispose();}
});

test('round report publication is durable, idempotent and limited to its project room, including migration',async()=>{
  const h=await fixture();try{
    const flow:ProjectFlow={id:'flow',flowId:'flow',schemaVersion:1,revision:1,createdAt:'2026',updatedAt:'2026',projectId:h.projects[0].id,leadMemberId:'codex',memberIds:['codex','claude'],roomId:h.rooms[0],status:'completed',dispatchMode:'paused',blockedReasons:[]};h.engine.store.put('project_flows',flow.id,flow);
    const round:Round={id:'round',flowId:flow.id,projectId:flow.projectId,planId:'plan',schemaVersion:1,revision:1,createdAt:'2026',key:'r1',goal:'完成',requiresUserAcceptance:true,index:0,taskIds:[],integrationFixCount:0,status:'accepted',title:'第一轮',integrationId:'integrated',updatedAt:'2026',report:{summary:'完成了 Alpha 成品',completedTaskKeys:['a'],deliverables:['a.txt'],validationSummary:'已读取',remainingIssues:[],nextRoundSummary:'',userDecisionNeeded:'请验收'}};
    h.engine.store.transaction(()=>{h.engine.store.put('flow_rounds',round.id,round);stageRoundReport(h.engine.store,round);});publishRoundReports(h.engine.store);publishRoundReports(h.engine.store);
    assert.equal(view(h.engine,h.rooms[0]).messages.length,1);assert.equal(view(h.engine,h.rooms[1]).messages.length,0);assert.equal(h.engine.snapshot().room.messages.length,0);
    const id=view(h.engine,h.rooms[0]).messages[0].id;assert.equal(view(h.engine,h.rooms[0]).messages[0].flowReport!.roundId,round.id);
    h.engine.store.delete('room_migrations','flow-reports-v1');migrateRoundReports(h.engine.store);assert.equal(view(h.engine,h.rooms[0]).messages.length,1);
    h.engine.store.delete('room_messages',id);publishRoundReports(h.engine.store);assert.equal(view(h.engine,h.rooms[0]).messages.length,0,'cleared publications never reappear');
  }finally{await h.dispose();}
});
