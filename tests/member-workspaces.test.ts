import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Engine} from './helpers/seeded-engine';
import {Store} from '../src/backend/store';
import {harness} from './helpers/project-flow-harness';
import type {Adapter,AdapterContext,Project,Run,Session,MemberProfile,RoomMessage} from '../src/shared/types';
import type {PersonalRoomData,DeskTopic,MemberWork} from '../src/shared/member-workspaces';
import type {WorkLogPage} from '../src/shared/work-log';
import type {TaskAddition} from '../src/shared/project-workbench';

const sleep=()=>new Promise(r=>setTimeout(r,20));
async function until<T>(read:()=>T|false|undefined){for(let n=0;n<400;n++){const v=read();if(v)return v;await sleep();}throw Error('condition did not settle');}
async function startDesk(engine:Engine,memberId:string){await engine.invoke('desk.open',{memberId});await engine.invoke('desk.topic',{memberId});return engine.invoke('desk.open',{memberId}) as Promise<PersonalRoomData>;}
async function junction(source:string,target:string){for(let n=0;;n++){try{await symlink(source,target,'junction');return;}catch(error){if(process.platform!=='win32'||!['EBUSY','EPERM'].includes((error as NodeJS.ErrnoException).code??'')||n>=20)throw error;await sleep();}}}
async function fixture(handler?:(ctx:AdapterContext,prompt:string)=>Promise<void>){
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM member-workspaces-')),data=path.join(root,'data'),calls:{ctx:AdapterContext;prompt:string}[]=[];
  const factory=(provider:Session['provider']):Adapter=>({probe:async()=>({id:provider,name:provider,available:true,auth:'subscription',detail:'fake',capabilities:{streaming:true,history:true,write:true,cancel:'native',steer:false}}),start:async(ctx,prompt)=>{calls.push({ctx,prompt});ctx.markDelivery('confirmed');await handler?.(ctx,prompt);ctx.persistNativeSession('native-'+ctx.session.id,'airoom');ctx.emit('delta',prompt.includes('话题压缩')?'保留目标与未完成工作':'这份内容已经整理。');return {};},stop:async()=>{}});
  const engine=new Engine(data,()=>{},()=>{},factory);await engine.probe();
  return {root,data,calls,engine,factory,get:(roomId:string)=>engine.invoke('room.get',{roomId}) as Promise<PersonalRoomData>,close:async()=>{await engine.close();await rm(root,{recursive:true,force:true,maxRetries:5});}};
}
test('deleting the current desk topic restores the recent same-folder topic, then leaves an empty folder without creating sessions',async()=>{
  const f=await fixture();try{
    const roomId='desk:claude',first=await startDesk(f.engine,'claude');await writeFile(path.join(first.directory!,'成果.txt'),'keep');await f.engine.invoke('desk.topic',{memberId:'claude',title:'最近的话题'});const second=await f.get(roomId),count=f.engine.store.list('sessions').length,revision=second.state.revision!;
    for(const [id,scope] of [['desk-topic-notice',{threadId:second.currentThreadId}],['desk-session-notice',{sessionId:second.sessionId}],['other-topic-notice',{threadId:first.currentThreadId}]] as const)f.engine.store.put('attention_dismissals',id,{id,...scope,fingerprint:'saved',dismissedAt:new Date().toISOString()});
    await f.engine.invoke('room.delete',{roomId,threadId:second.currentThreadId});const restored=await f.get(roomId);assert.equal(restored.currentThreadId,first.currentThreadId);assert.equal(restored.threads.length,1);assert.ok(restored.state.revision!>revision);assert.equal(f.engine.store.list('sessions').length,count-1);assert.deepEqual(f.engine.store.list<{id:string}>('attention_dismissals').map(i=>i.id),['other-topic-notice']);
    await f.engine.invoke('room.delete',{roomId,threadId:first.currentThreadId});const empty=await f.get(roomId);assert.equal(empty.currentThreadId,'');assert.equal(empty.threads.length,0);assert.equal(f.engine.store.list('sessions').length,count-2);assert.equal(await readFile(path.join(first.directory!,'成果.txt'),'utf8'),'keep');assert.ok(f.engine.store.get<DeskTopic>('desk_topics',first.currentThreadId)?.deletedAt);assert.equal(f.calls.length,0);assert.equal(f.engine.store.list('attention_dismissals').length,0);
  }finally{await f.close();}
});
test('deleting a current topic fences new sends and does not restore its folder after the viewer switches',async()=>{
  const f=await fixture();let release!:()=>void;try{
    const first=await startDesk(f.engine,'claude'),roomId='desk:claude',other=path.join(f.root,'other');await mkdir(other);const gate=new Promise<void>(r=>{release=r;});let entered=false;const remove=(f.engine as any).deleteSession.bind(f.engine);(f.engine as any).deleteSession=async(...args:unknown[])=>{entered=true;await gate;return remove(...args);};
    const deletion=f.engine.invoke('room.delete',{roomId,threadId:first.currentThreadId});await until(()=>entered);await assert.rejects(f.engine.invoke('room.send',{roomId,text:'race'}),/正在删除/);await f.engine.invoke('desk.switchFolder',{memberId:'claude',directory:other});release();await deletion;const current=await f.get(roomId);assert.equal(current.directory,other);assert.equal(current.currentThreadId,'');assert.equal(f.calls.length,0);
  }finally{release?.();await f.close();}
});

test('desk migration imports all ordinary projects once without changing native/session/workspace records and excludes internal creation',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM desk-migration-')),data=path.join(root,'data'),store=new Store(data),at='2026-10-01T10:00:00.000Z';
  const session=(id:string,projectId:string,extra:Partial<Session>={}):Session=>({id,projectId,provider:'claude',title:id,createdAt:at,updatedAt:at,revision:3,writeMode:true,nativeId:'native-'+id,workspace:path.join(root,id),workspaceKind:'copy',...extra});
  const a=session('ordinary-a','p1'),b=session('ordinary-b','p2',{archived:true}),flow=session('flow','p1',{purpose:'flow-task'}),lounge=session('lounge-session','hidden');
  for(const [id,kind] of [['p1',undefined],['p2',undefined],['hidden','lounge']] as const)store.put('projects',id,{id,name:id,directory:root,createdAt:at,collaborationPaused:false,kind});
  for(const s of [a,b,flow,lounge])store.put('sessions',s.id,s);store.close();
  let engine=new Engine(data,()=>{},()=>{});
  try{
    assert.deepEqual(engine.store.get('sessions',a.id),a);assert.deepEqual(engine.store.get('sessions',b.id),b);
    assert.deepEqual(engine.store.list<DeskTopic>('desk_topics').map(t=>t.sessionId).sort(),[a.id,b.id]);
    const empty=await engine.invoke('desk.open',{memberId:'claude'}) as PersonalRoomData;assert.equal(empty.threads.length,0);assert.equal(engine.store.list<Session>('sessions').length,4);
    const report=await engine.invoke('desk.switchFolder',{memberId:'claude',directory:root}) as PersonalRoomData;assert.equal(report.threads.length,2);
    assert.ok(report.threads.find(t=>t.id==='desk-topic-'+b.id)?.archivedAt);
    engine.createSession('p1','claude','internal flow',false,'claude','flow-plan');assert.equal(engine.store.list<DeskTopic>('desk_topics').length,2);
    await engine.close();engine=new Engine(data,()=>{},()=>{});assert.equal(engine.store.list<DeskTopic>('desk_topics').length,2);assert.deepEqual(engine.store.get('sessions',a.id),a);
  }finally{await engine.close();await rm(root,{recursive:true,force:true,maxRetries:5});}
});

test('desk chat uses a concise conversation briefing while explicit flow tasks keep their task briefing',async()=>{
  const f=await fixture();try{
    const first=await startDesk(f.engine,'claude');await f.engine.invoke('room.send',{roomId:'desk:claude',text:'你好'});
    await until(()=>f.engine.store.list<Run>('runs').some(r=>r.sessionId===first.sessionId&&r.status==='ended'));
    assert.equal(f.calls[0].ctx.conversation,'desk');assert.match(f.calls[0].prompt,/普通聊天无需先列计划/);assert.doesNotMatch(f.calls[0].prompt,/任务修订：/);
    const deskSession=f.engine.store.get<Session>('sessions',first.sessionId!)!;
    const task=f.engine.createSession(deskSession.projectId,'claude','正式工作',false,'claude','flow-task');
    const {runId}=await f.engine.send(task.id,'检查项目') as {runId:string};await until(()=>f.engine.store.get<Run>('runs',runId)?.status==='ended');
    assert.equal(f.calls[1].ctx.conversation,undefined);assert.match(f.calls[1].prompt,/任务修订：/);assert.match(f.calls[1].prompt,/公开说明计划、实际工具活动/);
  }finally{await f.close();}
});

test('personal folders write directly; topic switching keeps original native context, and external folders use an immutable copy',async()=>{
  const f=await fixture(async(ctx,prompt)=>{if(prompt.includes('写下笔记'))await writeFile(path.join(ctx.cwd,'笔记.md'),'个人成果');});
  try{
    const roomId='desk:claude',first=await startDesk(f.engine,'claude');
    assert.equal(first.direct,true);assert.equal(first.directory,path.join(f.data,'desks','claude'));assert.equal((await stat(first.directory!)).isDirectory(),true);
    assert.equal(f.calls.length,0);await f.engine.invoke('room.send',{roomId,text:'写下笔记'});await until(()=>f.engine.store.list<Run>('runs').some(r=>r.sessionId===first.sessionId&&r.status==='ended'));
    assert.equal(await readFile(path.join(first.directory!,'笔记.md'),'utf8'),'个人成果');const native=f.engine.store.get<Session>('sessions',first.sessionId!)!.nativeId;
    const second=await f.engine.invoke('room.archive',{roomId,title:'新的独立话题'}) as {id:string};await f.engine.invoke('room.send',{roomId,text:'新话题的问题'});await until(()=>f.calls.length===2);await until(()=>f.engine.store.list<Run>('runs').filter(r=>r.status==='ended').length===2);
    assert.notEqual(f.calls[0].ctx.session.id,f.calls[1].ctx.session.id);assert.equal(f.calls[1].ctx.session.nativeId,undefined);
    await f.engine.invoke('room.select',{roomId,threadId:first.currentThreadId});await f.engine.invoke('room.send',{roomId,text:'继续原话题'});await until(()=>f.calls.length===3);assert.equal(f.calls[2].ctx.session.nativeId,native);await until(()=>f.engine.store.list<Run>('runs').filter(r=>r.status==='ended').length===3);
    const source=path.join(f.root,'other');await mkdir(source);await writeFile(path.join(source,'source.txt'),'原稿');
    await f.engine.invoke('desk.switchFolder',{memberId:'claude',directory:source});await f.engine.invoke('room.archive',{roomId,title:'外部资料'});const external=await f.get(roomId);assert.equal(external.direct,false);const saved=structuredClone(f.engine.store.get<Session>('sessions',first.sessionId!)!);
    await f.engine.invoke('room.send',{roomId,text:'看看资料'});await until(()=>f.calls.length===4);await until(()=>f.engine.store.list<Run>('runs').filter(r=>r.status==='ended').length===4);
    assert.notEqual(f.calls[3].ctx.cwd,source);assert.equal(external.directory,source);assert.equal(await readFile(path.join(source,'source.txt'),'utf8'),'原稿');assert.deepEqual(f.engine.store.get('sessions',first.sessionId!),saved);
    const folders=f.engine.snapshot().projects.filter(p=>!p.kind);assert.equal(folders.length,0,'managed personal execution roots stay out of public projects');
    const written=f.engine.store.list<Run>('runs').find(r=>r.sessionId===external.sessionId)!;f.engine.store.put('runs',written.id,{...written,workspaceUndo:{...written.workspaceUndo,status:'available'}});assert.equal(f.engine.snapshot().attention?.items.some(a=>a.kind==='acceptance'&&a.runId===written.id),false,'personal topics do not enter project review or acceptance');
    await assert.rejects(f.engine.invoke('room.delete',{roomId,threadId:second.id}),/当前文件夹/);
    await f.engine.invoke('desk.switchFolder',{memberId:'claude',personal:true});await f.engine.invoke('room.delete',{roomId,threadId:second.id});await f.engine.invoke('snapshot',{});assert.equal((await f.get(roomId)).threads.some(t=>t.id===second.id),false);await f.engine.invoke('desk.switchFolder',{memberId:'claude',directory:source});
    const archived=f.engine.store.get<Session>('sessions',external.sessionId!)!;f.engine.store.put('sessions',archived.id,{...archived,archived:true});await f.engine.invoke('desk.switchFolder',{memberId:'claude',personal:true});await f.engine.invoke('desk.switchFolder',{memberId:'claude',directory:source});assert.equal(f.engine.store.get<Session>('sessions',archived.id)?.archived,false,'opening a folder restores its last archived native session for continuation');
    await assert.rejects(f.engine.invoke('room.select',{roomId:'desk:codex',threadId:first.currentThreadId}),/话题/);
    const restored=f.engine.store.get<Session>('sessions',external.sessionId!)!;f.engine.store.put('sessions',restored.id,{...restored,restoredHistoryOnly:true});const requestCount=f.calls.length;
    await assert.rejects(f.engine.invoke('room.compress',{roomId}),/仅保留历史/);await assert.rejects(f.engine.invoke('room.clear',{roomId}),/仅保留历史/);assert.equal(f.calls.length,requestCount);assert.equal(f.engine.store.get<Session>('sessions',restored.id)?.nativeId,restored.nativeId);
  }finally{await f.close();}
});

test('personal history cursors freeze IDs across new arrivals, reactions survive projection, and read tokens are per topic',async()=>{
  const f=await fixture();try{
    const roomId='desk:codex',desk=await startDesk(f.engine,'codex');
    for(let i=0;i<5;i++)f.engine.store.put('room_messages','m'+i,{id:'m'+i,roomId,threadId:desk.currentThreadId,author:'codex',text:'saved '+i,at:new Date(1000+i).toISOString(),status:'done'});
    const one=await f.engine.invoke('room.history',{roomId,limit:2}) as PersonalRoomData;assert.deepEqual(one.messages.map(m=>m.id),['m3','m4']);
    f.engine.store.put('room_messages','later',{id:'later',roomId,threadId:desk.currentThreadId,author:'codex',text:'new arrival',at:new Date().toISOString(),status:'done'});
    const two=await f.engine.invoke('room.history',{roomId,before:one.before,limit:2}) as PersonalRoomData;assert.deepEqual(two.messages.map(m=>m.id),['m1','m2']);assert.ok(!two.messages.some(m=>m.id==='later'));
    const fresh=await f.get(roomId);assert.equal(f.engine.snapshot().rooms?.find(r=>r.roomId===roomId)?.unread,true);await f.engine.invoke('room.read',{roomId,readToken:fresh.readToken});assert.equal(f.engine.snapshot().rooms?.find(r=>r.roomId===roomId)?.unread,false);
    await f.engine.invoke('room.archive',{roomId,title:'another'});await assert.rejects(f.engine.invoke('room.history',{roomId,before:one.before}),/分页/);await assert.rejects(f.engine.invoke('room.read',{roomId,readToken:fresh.readToken}),/阅读位置/);
    await f.engine.invoke('room.select',{roomId,threadId:desk.currentThreadId});assert.equal(f.engine.snapshot().rooms?.find(r=>r.roomId===roomId)?.unread,false);
    await f.engine.invoke('room.send',{roomId,text:'一个问题'});await until(()=>f.engine.store.list<Run>('runs').some(r=>r.status==='ended'));const message=(await f.get(roomId)).messages.find(m=>m.runId)!;
    await f.engine.invoke('room.react',{roomId,messageId:message.id,emoji:'👍'});await f.engine.invoke('room.rename',{roomId,threadId:desk.currentThreadId,title:'重命名'});assert.deepEqual((await f.get(roomId)).messages.find(m=>m.id===message.id)?.reactions,{'👍':['user']});
  }finally{await f.close();}
});

test('empty folders never create sessions; folder aliases share a cursor and foreign-folder actions are rejected',async()=>{
  const f=await fixture();try{
    const memberId='claude',roomId='desk:claude';
    const blank=await f.engine.invoke('desk.open',{memberId}) as PersonalRoomData;
    assert.equal(blank.currentThreadId,'');assert.equal(blank.sessionId,undefined);assert.equal(f.engine.store.list<Session>('sessions').length,0);
    await assert.rejects(f.engine.invoke('room.send',{roomId,text:'先说话'}),/先开新话题/);
    const own=await startDesk(f.engine,memberId),other=path.join(f.root,'materials'),alias=path.join(f.root,'alias');await mkdir(other);await junction(other,alias);
    const empty=await f.engine.invoke('desk.switchFolder',{memberId,directory:other+path.sep}) as PersonalRoomData;
    assert.equal(empty.currentThreadId,'');assert.deepEqual(empty.threads,[]);assert.equal(f.engine.store.list<Session>('sessions').length,1);
    for(const method of ['room.select','room.rename','room.export','room.delete','room.compress','room.history'])await assert.rejects(f.engine.invoke(method,{roomId,threadId:own.currentThreadId,title:'不应改名'}),/当前文件夹/);
    await assert.rejects(f.engine.invoke('room.archive',{roomId,directory:own.directory}),/先切换文件夹/);
    await f.engine.invoke('desk.topic',{memberId,title:'资料'});const first=await f.get(roomId);
    await f.engine.invoke('desk.topic',{memberId,title:'资料二'});await f.engine.invoke('room.select',{roomId,threadId:first.currentThreadId});
    await f.engine.invoke('desk.switchFolder',{memberId,personal:true});const viaAlias=await f.engine.invoke('desk.switchFolder',{memberId,directory:alias}) as PersonalRoomData;
    assert.equal(viaAlias.currentThreadId,first.currentThreadId);assert.equal(viaAlias.folderKey,first.folderKey);assert.equal(viaAlias.folders?.filter(x=>x.key===first.folderKey).length,1);
    if(process.platform==='win32')assert.equal((await f.engine.invoke('desk.switchFolder',{memberId,directory:other.toUpperCase()}) as PersonalRoomData).folderKey,first.folderKey);
  }finally{await f.close();}
});

test('folder selection and each folder recent topic survive restart; empty-folder view also survives',async()=>{
  const f=await fixture();let engine=f.engine;try{
    const memberId='codex',roomId='desk:codex',own=await startDesk(engine,memberId),other=path.join(f.root,'other');await mkdir(other);
    await engine.invoke('desk.topic',{memberId,title:'第二个'});await engine.invoke('room.select',{roomId,threadId:own.currentThreadId});
    await engine.invoke('desk.switchFolder',{memberId,directory:other});await engine.close();engine=new Engine(f.data,()=>{},()=>{},f.factory);
    const empty=await engine.invoke('desk.open',{memberId}) as PersonalRoomData;assert.equal(empty.directory,other);assert.equal(empty.currentThreadId,'');
    await engine.invoke('desk.switchFolder',{memberId,personal:true});assert.equal((await engine.invoke('desk.open',{memberId}) as PersonalRoomData).currentThreadId,own.currentThreadId);
    assert.equal(engine.store.list<Session>('sessions').length,2);
  }finally{await engine.close();await rm(f.root,{recursive:true,force:true,maxRetries:5});}
});

test('deleting an empty archived topic advances backend revision and its migration tombstone prevents resurrection',async()=>{
  const f=await fixture();try{
    const memberId='claude',roomId='desk:claude',first=await startDesk(f.engine,memberId),old=structuredClone(f.engine.store.get<Session>('sessions',first.sessionId!)!);
    await f.engine.invoke('desk.topic',{memberId,title:'保留当前'});
    const revision=()=>f.engine.snapshot().rooms!.find(r=>r.roomId===roomId)!.revision,before=revision();
    await f.engine.invoke('room.delete',{roomId,threadId:first.currentThreadId});assert.ok(revision()>before);
    f.engine.store.put('sessions',old.id,old);f.engine.store.delete('desk_session_links',old.id);await f.engine.invoke('snapshot',{});
    assert.equal((await f.get(roomId)).threads.some(t=>t.id===first.currentThreadId),false);assert.ok(f.engine.store.get<DeskTopic>('desk_topics',first.currentThreadId)?.deletedAt);
  }finally{await f.close();}
});

test('switching folders during a pending question keeps the run and cross-folder attention; stop affects only the displayed topic',async()=>{
  const f=await fixture(async ctx=>{await ctx.approve({type:'question',title:'资料范围',detail:'确认范围',options:[{id:'answer',label:'回答'}]});});try{
    f.engine.settings.defaultAutoApprove=false;
    const memberId='claude',roomId='desk:claude',own=await startDesk(f.engine,memberId),other=path.join(f.root,'empty');await mkdir(other);
    await f.engine.invoke('room.send',{roomId,text:'等待回答'});const run=await until(()=>f.engine.store.list<Run>('runs').find(r=>r.sessionId===own.sessionId&&r.status==='waiting_user'));
    const switched=await f.engine.invoke('desk.switchFolder',{memberId,directory:other}) as PersonalRoomData;
    assert.equal(switched.currentThreadId,'');assert.equal(switched.state.active,false);assert.equal(switched.folders?.find(f=>f.personal)?.pending,true);assert.equal(f.engine.snapshot().rooms?.find(r=>r.roomId===roomId)?.pending,true);
    await f.engine.invoke('room.stop',{roomId});assert.equal(f.engine.store.get<Run>('runs',run.id)?.status,'waiting_user');
    await f.engine.invoke('desk.switchFolder',{memberId,personal:true});await f.engine.invoke('room.select',{roomId,threadId:own.currentThreadId});await f.engine.invoke('room.stop',{roomId});await until(()=>f.engine.store.get<Run>('runs',run.id)?.status==='stopped');
  }finally{await f.close();}
});

test('a compression completes on its original topic after a folder switch without altering the other folder native session',async()=>{
  let release:()=>void=()=>{},entered=false;const gate=new Promise<void>(resolve=>release=resolve);
  const f=await fixture(async(_ctx,prompt)=>{if(prompt.includes('话题压缩')){entered=true;await gate;}});try{
    const memberId='claude',roomId='desk:claude',own=await startDesk(f.engine,memberId),other=path.join(f.root,'other');await mkdir(other);
    await f.engine.invoke('desk.switchFolder',{memberId,directory:other});await f.engine.invoke('desk.topic',{memberId});const external=await f.get(roomId),saved=structuredClone(f.engine.store.get<Session>('sessions',external.sessionId!)!);
    await f.engine.invoke('desk.switchFolder',{memberId,personal:true});const compression=f.engine.invoke('room.compress',{roomId});await until(()=>entered);
    await f.engine.invoke('desk.switchFolder',{memberId,directory:other});assert.equal((await f.get(roomId)).state.compressing,undefined);
    await f.engine.invoke('room.stop',{roomId});release();await compression;
    assert.ok(f.engine.store.get<{summary?:unknown}>('room_threads',own.currentThreadId)?.summary);assert.deepEqual(f.engine.store.get('sessions',external.sessionId!),saved);assert.equal((await f.get(roomId)).currentThreadId,external.currentThreadId);
  }finally{release();await f.close();}
});

test('deleting a card always preserves files and historical identity, and never follows junctions',async()=>{
  const f=await fixture();try{
    const member=await f.engine.invoke('team.save',{member:{executor:'claude',name:'编辑'}}) as MemberProfile;const folder=path.join(f.data,'desks',member.id);await writeFile(path.join(folder,'保留.txt'),'keep');
    const topic=await startDesk(f.engine,member.id);await assert.rejects(f.engine.invoke('team.delete',{id:member.id,folderChoice:'delete'}),/保留|人物卡/);assert.ok(f.engine.store.members().some(m=>m.id===member.id));
    await f.engine.invoke('team.delete',{id:member.id,folderChoice:'keep'});assert.equal(await readFile(path.join(folder,'保留.txt'),'utf8'),'keep');assert.equal(f.engine.store.get<Session>('sessions',topic.sessionId!)?.memberId,member.id);await assert.rejects(f.engine.invoke('room.send',{roomId:'desk:'+member.id,text:'继续'}),/历史记录/);
    assert.equal((await f.engine.invoke('desk.open',{memberId:member.id}) as PersonalRoomData).currentThreadId,topic.currentThreadId,'the removed member still opens their original read-only history');
    await assert.rejects(f.engine.invoke('desk.folder',{memberId:member.id}),/历史记录/);
    const other=await f.engine.invoke('team.save',{member:{executor:'codex',name:'另一个编辑'}}) as MemberProfile;const managed=path.join(f.data,'desks',other.id),outside=path.join(f.root,'outside');await mkdir(outside);await writeFile(path.join(outside,'untouched'),'outside');await rm(managed,{recursive:true});await junction(outside,managed);
    await assert.rejects(f.engine.invoke('team.delete',{id:other.id}),/联接/);assert.equal(await readFile(path.join(outside,'untouched'),'utf8'),'outside');await rm(managed);await mkdir(managed);await writeFile(path.join(managed,'keep'),'inside');await junction(outside,path.join(managed,'external-link'));await f.engine.invoke('team.delete',{id:other.id});assert.equal(await readFile(path.join(managed,'keep'),'utf8'),'inside');assert.equal(await readFile(path.join(outside,'untouched'),'utf8'),'outside');
  }finally{await f.close();}
});

test('personal report reads and room overviews scan execution tables a bounded number of times',async()=>{
  const h=await harness();try{
    await h.confirm();await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');
    const roomId=`report:${h.project.id}:claude`,store=h.engine.store;
    await h.engine.invoke('report.open',{projectId:h.project.id,memberId:'claude'});
    const original=store.list.bind(store),scans=new Map<string,number>();
    store.list=((entity:string)=>{scans.set(entity,(scans.get(entity)??0)+1);return original(entity);}) as typeof store.list;
    try{
      const page=await h.engine.invoke('room.get',{roomId}) as PersonalRoomData;assert.ok(page.messages.some(m=>m.memberReport));
      assert.ok((scans.get('runs')??0)<=4,'reading one report must not rescan runs for all personal rooms');
      scans.clear();const overviews=(h.engine as any).memberWorkspaces.overviews();assert.ok(overviews.some((r:any)=>r.roomId===roomId));
      for(const entity of ['runs','sessions','flow_operations','approvals'])assert.ok((scans.get(entity)??0)<=2,entity+' must be batched across rooms');
    }finally{store.list=original;}
  }finally{await h.dispose();}
});

test('report pagination counts logical cards and survives new versions without losing saved facts or user questions',async()=>{
  const h=await harness();try{
    await h.confirm();await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');
    const roomId=`report:${h.project.id}:claude`,data=await h.engine.invoke('report.open',{projectId:h.project.id,memberId:'claude'}) as PersonalRoomData,seed=data.messages.find(m=>m.memberReport)!,threadId=data.currentThreadId,base=Date.now()+1000;
    for(let n=0;n<12;n++)for(let v=0;v<3;v++)h.engine.store.put('room_messages',`legacy-${n}-${v}`,{...seed,id:`legacy-${n}-${v}`,text:`第 ${n} 组，版本 ${v}`,at:new Date(base+n*10+v).toISOString(),memberReportVersions:undefined,memberReport:{...seed.memberReport!,id:`report-${n}`,summary:[`第 ${n} 组，版本 ${v}`]}});
    h.engine.store.put('room_messages','saved-question',{id:'saved-question',roomId:roomId as RoomMessage['roomId'],threadId,author:'user',text:'保留旧版本的问题',replyTo:'legacy-0-0',at:new Date(base+200).toISOString()} satisfies RoomMessage);
    const original=h.engine.store.allRoomMessages(threadId,roomId as any),first=await h.engine.invoke('room.history',{roomId,threadId,limit:3}) as PersonalRoomData;assert.equal(first.messages.length,3);assert.ok(first.before);
    h.engine.store.put('room_messages','updated-old-report',{...seed,id:'updated-old-report',text:'第 0 组最新状态',at:new Date(base+300).toISOString(),memberReportVersions:undefined,memberReport:{...seed.memberReport!,id:'report-0',summary:['第 0 组最新状态']}});
    const pages=[...first.messages];let cursor:string|undefined=first.before;while(cursor){const page=await h.engine.invoke('room.history',{roomId,threadId,before:cursor,limit:3}) as PersonalRoomData;pages.push(...page.messages);cursor=page.before;}
    const facts=pages.filter(m=>m.memberReport);assert.equal(new Set(facts.map(m=>m.memberReport!.id)).size,facts.length);assert.ok(pages.some(m=>m.id==='saved-question'&&m.replyTo==='legacy-0-0'));assert.equal(facts.find(m=>m.memberReport!.id==='report-0')?.text,'第 0 组最新状态');assert.equal(facts.find(m=>m.memberReport!.id==='report-0')?.memberReportVersions?.length,3);
    for(const saved of original)assert.deepEqual(h.engine.store.get('room_messages',saved.id),saved);
    const exported=await h.engine.invoke('room.export',{roomId}) as {content:string};assert.match(exported.content,/版本 0/);assert.match(exported.content,/最新状态/);
    const latest=await h.engine.invoke('room.get',{roomId}) as PersonalRoomData;await h.engine.invoke('room.read',{roomId,readToken:latest.readToken});assert.equal(h.engine.snapshot().rooms?.find(r=>r.roomId===roomId)?.unread,false);
  }finally{await h.dispose();}
});

test('report messages are immutable saved facts; scoped read-only answers stay in the report and reuse M2/member work',async()=>{
  const h=await harness({handler:async c=>{if(c.kind==='')return {answer:'只读解释'};return undefined;}});try{
    await h.confirm();await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');const count=h.calls.length,roomId=`report:${h.project.id}:claude`;
    const first=await h.engine.invoke('report.open',{projectId:h.project.id,memberId:'claude'}) as PersonalRoomData;assert.ok(first.messages.some(m=>m.memberReport));assert.equal(h.calls.length,count);
    const old=structuredClone(first.messages),work=await h.engine.invoke('report.work',{projectId:h.project.id,memberId:'claude'}) as MemberWork;assert.ok(work.runs.length>0);assert.ok(work.runs.every(r=>(h.engine.store.get<Session>('sessions',r.sessionId)?.memberId??r.provider)==='claude'&&r.projectId===h.project.id));
    const log=await h.engine.invoke('projectFlow.log',{projectId:h.project.id,target:{kind:'member',id:'claude'}}) as WorkLogPage;assert.ok(log.entries.length);assert.ok(log.entries.every(e=>!e.runId||work.runs.some(r=>r.id===e.runId)));
    const beforeRoom=h.engine.store.allRoomMessages(h.engine.store.currentRoomThread(`project:${h.project.id}`).id,`project:${h.project.id}`).length;
    const sent=await h.engine.invoke('room.send',{roomId,text:'请解释依据，不改变任务'}) as {messageId:string};await until(()=>h.engine.store.list<RoomMessage>('room_messages').find(m=>m.roomId===roomId&&m.replyTo===sent.messageId&&m.status==='done'));
    assert.equal(h.calls.length,count+1);const call=h.calls.at(-1)!;assert.equal(call.ctx.session.writeMode,false);assert.equal(call.ctx.settings.permissions.claude.commands,'deny');assert.ok(call.ctx.run.input.includes(h.project.id));assert.ok(call.ctx.run.input.includes('flowOperationId')===false,'context limits raw runs to relevant fields');
    assert.equal(h.engine.store.allRoomMessages(h.engine.store.currentRoomThread(`project:${h.project.id}`).id,`project:${h.project.id}`).length,beforeRoom);assert.equal(h.engine.store.list<DeskTopic>('desk_topics').length,0,'report and project-flow helpers never become desk topics');
    await h.accept();await h.wait(s=>s.flow!.status==='completed');const changed=await h.engine.invoke('room.get',{roomId}) as PersonalRoomData;assert.ok(changed.messages.length>first.messages.length);for(const m of old){const stored=h.engine.store.get<RoomMessage>('room_messages',m.id)!;assert.equal(stored.text,m.text);assert.deepEqual(stored.memberReport,m.memberReport);}const facts=changed.messages.filter(m=>m.memberReport);assert.equal(new Set(facts.map(m=>m.memberReport!.id)).size,facts.length);assert.ok(facts.some(m=>m.memberReportVersions?.length));
    const again=await h.engine.invoke('room.get',{roomId}) as PersonalRoomData;assert.deepEqual(again.messages.map(m=>m.id),changed.messages.map(m=>m.id));
    const exported=await h.engine.invoke('room.export',{roomId}) as {content:string};assert.match(exported.content,/a.txt/);
    await sleep();await h.engine.invoke('project.remove',{projectId:h.project.id});assert.ok(!h.engine.snapshot().rooms?.some(r=>r.projectId===h.project.id));assert.equal(h.engine.store.list<Session>('sessions').some(s=>s.roomId===roomId),false);
  }finally{await h.dispose();}
});

test('report questions can explicitly source H1 proposals; foreign member/project/message sources cannot',async()=>{
  const h=await harness({handler:async c=>c.kind==='task-addition'?{completionCriteria:['补充正确'],allowedPaths:['a.txt'],inScope:true,scopeReason:'原范围'}:c.kind===''?{answer:'只读'}:undefined});try{
    await h.confirm();await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');const roomId=`report:${h.project.id}:claude`;await h.engine.invoke('report.open',{projectId:h.project.id,memberId:'claude'});
    const sent=await h.engine.invoke('room.send',{roomId,text:'请追加一段解释'}) as {messageId:string};await until(()=>h.engine.store.list<RoomMessage>('room_messages').find(m=>m.replyTo===sent.messageId&&m.status==='done'));
    let s=await h.state();const params={requestId:'report-proposal',flowId:s.flow!.id,expectedRevision:s.flow!.revision,roundId:s.rounds[0].id,memberId:'claude',title:'追加解释',goal:'请追加一段解释',sourceMessageId:sent.messageId};
    const result=await h.engine.invoke('projectFlow.task.prepare',params) as {proposalId:string};const proposal=await until(()=>{const p=h.engine.store.get<TaskAddition>('flow_task_additions',result.proposalId);return p&&p.status!=='preparing'?p:false;});assert.equal(proposal.source,'report');assert.equal(proposal.sourceMessageId,sent.messageId);assert.equal((await h.state()).tasks.length,s.tasks.length,'preparing is not confirmation');
    s=await h.state();await assert.rejects(h.engine.invoke('projectFlow.task.prepare',{...params,requestId:'foreign-member',expectedRevision:s.flow!.revision,memberId:'dsh'}),/成员|项目/);
    const fact=(await h.engine.invoke('room.get',{roomId}) as PersonalRoomData).messages.find(m=>m.memberReport)!;await assert.rejects(h.engine.invoke('projectFlow.task.prepare',{...params,requestId:'fact-source',expectedRevision:s.flow!.revision,sourceMessageId:fact.id}),/用户|来源/);
  }finally{await h.dispose();}
});

test('stop during personal report preparation fences dispatch; all-stop also fences compression',async()=>{
  const h=await harness();try{
    await h.confirm();await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');const roomId=`report:${h.project.id}:claude`;await h.engine.invoke('report.open',{projectId:h.project.id,memberId:'claude'});const before=h.calls.length;
    await h.engine.invoke('room.send',{roomId,text:'准备阶段就停止'});await h.engine.invoke('room.stop',{roomId});await until(()=>!h.engine.snapshot().rooms?.find(r=>r.roomId===roomId)?.state.active);assert.equal(h.calls.length,before);
    const desk=await startDesk(h.engine,'claude');h.engine.store.put('room_messages','to-compress',{id:'to-compress',roomId:'desk:claude',threadId:desk.currentThreadId,author:'user',text:'待整理',at:new Date().toISOString()});
    const compress=h.engine.invoke('room.compress',{roomId:'desk:claude'});await h.engine.invoke('all.stop',{});await assert.rejects(compress,/压缩未完成/);assert.equal(h.calls.length,before);assert.equal(h.engine.store.get<Session>('sessions',desk.sessionId!)?.revision,1);
  }finally{await h.dispose();}
});

test('H2 supplements use the same task revision and report source; other members cannot supply that source',async()=>{
  const h=await harness();try{
    h.quota('claude',false);await h.confirm();let state=await h.wait(s=>s.tasks.some(t=>t.key==='a'&&['pending','ready','queued'].includes(t.status)));const roomId=`report:${h.project.id}:claude` as const;
    const room=await h.engine.invoke('report.open',{projectId:h.project.id,memberId:'claude'}) as PersonalRoomData;
    const message:RoomMessage={id:'report-requirement',roomId,threadId:room.currentThreadId,author:'user',text:'补充说明 a.txt 的来源',at:new Date().toISOString()};h.engine.store.put('room_messages',message.id,message);
    state=await h.state();const task=state.tasks.find(t=>t.key==='a')!,before=structuredClone(h.engine.store.get('flow_plans',state.plan!.id));
    await h.engine.invoke('projectFlow.task.supplement',{requestId:'report-supplement',taskId:task.id,expectedRevision:task.revision,text:message.text,sourceMessageId:message.id});
    const changed=(await h.state()).tasks.find(t=>t.id===task.id)!;assert.equal(changed.supplements?.at(-1)?.source,'report');assert.equal(changed.supplements?.at(-1)?.sourceMessageId,message.id);assert.deepEqual(h.engine.store.get('flow_plans',state.plan!.id),before);
    const foreign=(await h.state()).tasks.find(t=>t.key==='b')!;await assert.rejects(h.engine.invoke('projectFlow.task.supplement',{requestId:'foreign-supplement',taskId:foreign.id,expectedRevision:foreign.revision,text:message.text,sourceMessageId:message.id}),/来源/);
  }finally{await h.dispose();}
});

test('report answers and flow tasks share canonical approvals but separate stop scopes from the board and attention',async()=>{
  const h=await harness({handler:async c=>{
    if(c.kind==='submission'&&c.material.task.memberId==='claude')await c.ctx.approve({type:'approval',title:'作者审批',detail:'a.txt',options:[{id:'native_once',label:'仅允许这次'},{id:'native_deny',label:'拒绝'}]});
    if(c.ctx.session.roomId?.startsWith('report:'))await c.ctx.approve({type:'question',title:'只读回答的问题',detail:'请确认资料范围',options:[{id:'answer',label:'回答'}]});
  }});try{
    h.engine.settings.defaultAutoApprove=false;await h.confirm();await until(()=>h.engine.store.list<Run>('runs').find(r=>r.provider==='claude'&&r.status==='waiting_user'));
    const roomId=`report:${h.project.id}:claude`;await h.engine.invoke('report.open',{projectId:h.project.id,memberId:'claude'});const work=await h.engine.invoke('report.work',{projectId:h.project.id,memberId:'claude'}) as MemberWork,approval=work.approvals.find(a=>a.state==='pending')!;assert.ok(approval);assert.equal(h.engine.snapshot().attention?.items.find(i=>i.approvalId===approval.id)?.runId,approval.runId);
    await h.engine.invoke('room.send',{roomId,text:'解释我的任务'});const question=await until(()=>h.engine.store.list<MemberWork['approvals'][number]>('approvals').find(a=>a.type==='question'&&a.state==='pending'&&h.engine.store.get<Session>('sessions',a.sessionId)?.roomId===roomId));
    await h.engine.invoke('room.stop',{roomId});await until(()=>!h.engine.snapshot().rooms?.find(r=>r.roomId===roomId)?.state.active);assert.equal(h.engine.store.get<Run>('runs',approval.runId)?.status,'waiting_user');assert.notEqual(h.engine.store.get<Run>('runs',question.runId)?.status,'waiting_user');
    const other=structuredClone(h.engine.store.list<Run>('runs').filter(r=>r.projectId===h.project.id&&r.provider==='dsh'));
    await h.engine.invoke('run.stop',{runId:approval.runId});await until(()=>['stopped','unknown'].includes(h.engine.store.get<Run>('runs',approval.runId)!.status));assert.equal(h.engine.store.get<MemberWork['approvals'][number]>('approvals',approval.id)?.state,'expired');assert.equal(h.engine.snapshot().attention?.items.some(i=>i.approvalId===approval.id),false);
    for(const r of other)if(r.completedAt)assert.deepEqual(h.engine.store.get('runs',r.id),r);
    const refreshed=await h.engine.invoke('report.work',{projectId:h.project.id,memberId:'claude'}) as MemberWork;assert.ok(refreshed.runs.some(r=>r.id===approval.runId));assert.ok(refreshed.operations.some(o=>o.runId===approval.runId));
  }finally{await h.dispose();}
});
