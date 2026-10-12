import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Engine} from './helpers/seeded-engine';
import type {Adapter,AdapterContext,MemberProfile,Project,Run,Session} from '../src/shared/types';
import type {PersonalRoomData} from '../src/shared/member-workspaces';
import {harness} from './helpers/project-flow-harness';

async function until(check:()=>boolean){for(let i=0;i<400;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('expected state did not settle');}
async function fixture(handler?:(ctx:AdapterContext)=>Promise<void>){
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM card-lifecycle-')),data=path.join(root,'data'),calls:AdapterContext[]=[];let stops=0;
  const factory=(id:Session['provider']):Adapter=>({probe:async()=>({id,name:id,available:true,auth:'account',detail:'fixture',capabilities:{streaming:true,write:false,history:true,cancel:'native',steer:false}}),start:async ctx=>{calls.push(ctx);ctx.markDelivery('confirmed');await handler?.(ctx);ctx.emit('delta','保存的一份成果');return {};},stop:async()=>{stops++;}});
  const engine=new Engine(data,()=>{},()=>{},factory);await engine.probe();
  const project=await engine.invoke('project.create',{name:'保留成果的项目',directory:root}) as Project;
  return {root,data,engine,project,factory,calls,stops:()=>stops,close:async()=>{await engine.close();await rm(root,{recursive:true,force:true,maxRetries:5});}};
}

test('hiding a card during a reply only changes presentation, and the same member keeps chatting',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let gated=true;
  const f=await fixture(async()=>{if(gated)await gate;});try{
    const member=await f.engine.invoke('team.save',{member:{executor:'claude',name:'继续工作的编辑',persona:'认真核对',model:'fixture-model'}}) as MemberProfile;
    const session=f.engine.createSession(f.project.id,'claude',undefined,false,member.id);
    const {runId}=await f.engine.invoke('session.send',{sessionId:session.id,text:'第一轮'}) as {runId:string};await until(()=>f.calls.length===1);
    const providers=structuredClone(f.engine.snapshot().providers),savedSession=f.engine.store.get('sessions',session.id),savedRun=f.engine.store.get('runs',runId);
    await f.engine.invoke('team.visibility',{id:member.id,hidden:true});
    const hidden=f.engine.snapshot().members.find(m=>m.id===member.id)! as MemberProfile & {cardHidden:boolean};assert.equal(hidden.cardHidden,true);assert.equal(hidden.persona,member.persona);assert.equal(hidden.model,member.model);
    assert.deepEqual(f.engine.snapshot().providers,providers);assert.deepEqual(f.engine.store.get('sessions',session.id),savedSession);assert.deepEqual(f.engine.store.get('runs',runId),savedRun);assert.equal(f.stops(),0);
    await assert.rejects(f.engine.invoke('team.delete',{id:member.id}),/任务在进行|停止/);assert.ok(f.engine.store.members().some(m=>m.id===member.id));
    await assert.rejects(f.engine.invoke('team.visibility',{id:member.id,hidden:'false'}),/显示|隐藏|布尔/);
    release();gated=false;await until(()=>Boolean(f.engine.store.get<Run>('runs',runId)?.completedAt));
    await f.engine.invoke('team.save',{member:{...member,name:'编辑的新名字'}});assert.equal((f.engine.snapshot().members.find(m=>m.id===member.id) as any).cardHidden,true,'ordinary configuration saves preserve the separate visibility setting');
    const next=await f.engine.invoke('session.send',{sessionId:session.id,text:'隐藏时继续聊天'}) as {runId:string};await until(()=>Boolean(f.engine.store.get<Run>('runs',next.runId)?.completedAt));assert.equal(f.calls.length,2);assert.equal(f.calls[1].session.memberId,member.id);
    await f.engine.invoke('team.visibility',{id:member.id,hidden:false});assert.equal((f.engine.snapshot().members.find(m=>m.id===member.id) as any).cardHidden,false);
    await assert.rejects(f.engine.invoke('team.visibility',{id:'missing',hidden:true}),/不存在/);
  }finally{release();await f.close();}
});

test('card deletion preserves conversations, run evidence, files and the external connection, but removes live configuration',async()=>{
  const f=await fixture();try{
    const executor=await f.engine.invoke('executor.save',{executor:{name:'独立程序',command:process.execPath,args:[],env:{}}}) as {id:string};
    const member=await f.engine.invoke('team.save',{member:{executor:executor.id,name:'留名的编辑',persona:'要删除的人设',memory:'要删除的记忆',model:'private-model'}}) as MemberProfile;
    await f.engine.invoke('desk.open',{memberId:member.id});await f.engine.invoke('desk.topic',{memberId:member.id,title:'原来的个人对话'});const desk=await f.engine.invoke('desk.open',{memberId:member.id}) as PersonalRoomData;
    const sent=await f.engine.invoke('room.send',{roomId:`desk:${member.id}`,text:'留下这段对话'}) as {runId:string};await until(()=>Boolean(f.engine.store.get<Run>('runs',sent.runId)?.completedAt));
    const file=path.join(f.data,'desks',member.id,'成果.txt');await writeFile(file,'成果原样保留');
    const lounge:Project={id:'saved-lounge',name:'历史茶歇室上下文',directory:f.root,createdAt:new Date().toISOString(),kind:'lounge',memberIds:[member.id],collaborationPaused:false};f.engine.store.put('projects',lounge.id,lounge);
    const privateSession=f.engine.createSession(lounge.id,member.executor,'茶歇室历史',false,member.id);const savedRun=await f.engine.invoke('session.send',{sessionId:privateSession.id,text:'上下文也要保留'}) as {runId:string};await until(()=>Boolean(f.engine.store.get<Run>('runs',savedRun.runId)?.completedAt));
    const entities=['sessions','runs','room_messages','room_threads','personal_rooms','desk_topics','desk_session_links','outbox'];const facts=entities.map(e=>f.engine.store.list(e));const events=f.engine.store.listEvents(privateSession.id),connection=structuredClone(f.engine.snapshot().executors);
    await assert.rejects(f.engine.invoke('team.delete',{id:member.id,folderChoice:'delete'}),/保留|人物卡/);assert.ok(f.engine.store.members().some(m=>m.id===member.id));
    await f.engine.invoke('team.delete',{id:member.id});
    assert.equal(f.engine.store.get('members',member.id),undefined);assert.ok(!f.engine.store.members().some(m=>m.id===member.id));
    assert.deepEqual(entities.map(e=>f.engine.store.list(e)),facts);assert.deepEqual(f.engine.store.listEvents(privateSession.id),events);assert.equal(await readFile(file,'utf8'),'成果原样保留');assert.deepEqual(f.engine.snapshot().executors,connection);
    const identity=f.engine.store.get<MemberProfile>('removed_members',member.id)!;assert.equal(identity.name,member.name);assert.equal(identity.persona,undefined);assert.equal(identity.memory,undefined);assert.equal(identity.memories,undefined);assert.equal(identity.model,undefined);
    assert.equal((await f.engine.invoke('desk.open',{memberId:member.id}) as PersonalRoomData).currentThreadId,desk.currentThreadId);
    const exported=await f.engine.invoke('room.export',{roomId:`desk:${member.id}`,threadId:desk.currentThreadId}) as {content:string};assert.match(exported.content,/留名的编辑/);assert.match(exported.content,/保存的一份成果/);
    await assert.rejects(f.engine.invoke('session.send',{sessionId:privateSession.id,text:'继续'}),/原成员已删除/);
    const reopened=new Engine(f.data,()=>{},()=>{},f.factory);try{assert.ok(!reopened.store.members().some(m=>m.id===member.id));assert.ok(reopened.snapshot().executors?.some(e=>e.id===executor.id));assert.ok(reopened.store.get('sessions',privateSession.id));}finally{await reopened.close();}
  }finally{await f.close();}
});

test('built-in cards can all be deleted without resurrecting on restart or erasing implicit-member history',async()=>{
  const f=await fixture();try{
    await f.engine.invoke('team.save',{member:{id:'claude',name:'自定的 Claudia',persona:'删除这个配置'}});
    const session=f.engine.createSession(f.project.id,'claude');assert.equal(session.memberId,undefined,'old built-in sessions use the provider as their identity');const saved=structuredClone(f.engine.store.get('sessions',session.id));
    for(const member of f.engine.store.members())await f.engine.invoke('team.delete',{id:member.id});
    assert.deepEqual(f.engine.snapshot().members,[]);assert.deepEqual(f.engine.store.get('sessions',session.id),saved);assert.equal(f.engine.store.get<MemberProfile>('removed_members','claude')?.name,'自定的 Claudia');
    await assert.rejects(f.engine.invoke('session.send',{sessionId:session.id,text:'继续'}),/原成员已删除/);assert.throws(()=>f.engine.createSession(f.project.id,'claude'),/成员|人物卡/);
    const reopened=new Engine(f.data,()=>{},()=>{},f.factory);try{assert.deepEqual(reopened.snapshot().members,[]);assert.ok(reopened.store.get('sessions',session.id));const added=await reopened.invoke('team.save',{member:{executor:'claude',name:'新的角色'}}) as MemberProfile;assert.notEqual(added.id,'claude');assert.deepEqual(reopened.store.members().map(m=>m.id),[added.id]);}finally{await reopened.close();}
  }finally{await f.close();}
});

test('hidden built-in cards stay hidden after configuration reset and cold restart',async()=>{
  const f=await fixture();try{
    await f.engine.invoke('team.save',{member:{id:'claude',name:'改过名字的成员',persona:'改过的人设'}});await f.engine.invoke('team.visibility',{id:'claude',hidden:true});
    await f.engine.invoke('team.reset',{id:'claude'});assert.equal(f.engine.store.members().find(m=>m.id==='claude')?.cardHidden,true);assert.equal(f.engine.store.members().find(m=>m.id==='claude')?.name,'Claudia');
    const reopened=new Engine(f.data,()=>{},()=>{},f.factory);try{assert.equal(reopened.store.members().find(m=>m.id==='claude')?.cardHidden,true);assert.equal(reopened.store.members().length,3);await reopened.invoke('team.visibility',{id:'claude',hidden:false});assert.equal(reopened.store.members().find(m=>m.id==='claude')?.cardHidden,false);}finally{await reopened.close();}
  }finally{await f.close();}
});

test('deleting a project participant retains saved reports, execution facts and their readable attribution',async()=>{
  const h=await harness();try{
    await h.confirm();await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');const roomId=`report:${h.project.id}:claude`;
    const before=await h.engine.invoke('report.open',{projectId:h.project.id,memberId:'claude'}) as PersonalRoomData;assert.ok(before.messages.some(m=>m.memberReport));
    const exported=await h.engine.invoke('room.export',{roomId,threadId:before.currentThreadId});const entities=['runs','flow_submissions','flow_reviews','flow_acceptances','flow_rounds','flow_tasks'];const facts=entities.map(e=>h.engine.store.list(e));const calls=h.calls.length;
    await h.engine.invoke('team.delete',{id:'claude'});
    const after=await h.engine.invoke('report.open',{projectId:h.project.id,memberId:'claude'}) as PersonalRoomData;assert.deepEqual(after.messages,before.messages);assert.deepEqual(entities.map(e=>h.engine.store.list(e)),facts);assert.deepEqual(await h.engine.invoke('room.export',{roomId,threadId:after.currentThreadId}),exported);assert.equal(h.calls.length,calls);
    const roster=await h.engine.invoke('projectFlow.memberReports',{projectId:h.project.id,limit:1}) as {members:{id:string;name:string;historical:boolean}[]};assert.ok(roster.members.some(m=>m.id==='claude'&&m.name==='Claudia'&&m.historical));
  }finally{await h.dispose();}
});
