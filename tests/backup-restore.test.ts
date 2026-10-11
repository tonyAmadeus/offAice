import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BackupRestorer, recoverInterruptedRestore } from '../src/backend/backup-restore';
import { Store } from '../src/backend/store';
import { Engine } from '../src/backend/engine';
import { BUILTIN_MEMBERS, DEFAULT_SETTINGS } from '../src/shared/defaults';
import { fixtureBackup } from './support/backup-fixture';
import type { Run, Session } from '../src/shared/types';

const loginFiles=['native/claude/.credentials.json','native/codex/home/auth.json','native/dsh/profile.json','secrets/acp-test.secret','deepseek.secret'];

test('backup restore retains isolated meeting roots and history while resetting every room state and native context',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM room-restore-')),data=path.join(directory,'data');let store=new Store(data);
  try{
    for(const id of ['a','b']){
      store.put('projects',id,{id,name:id,directory,createdAt:'',collaborationPaused:false});const thread=store.ensureProjectRoom(id);
      const roomId=`project:${id}` as const,hidden=`hidden-${id}`;store.put('projects',hidden,{id:hidden,kind:'lounge',roomId,name:id,directory:path.join(data,'old-'+id),createdAt:'',collaborationPaused:false});
      store.put('sessions','s-'+id,{id:'s-'+id,projectId:hidden,provider:'codex',roomId,roomThreadId:thread.id,revision:1,writeMode:false,createdAt:'',updatedAt:'',nativeId:'old-native-'+id});
      store.put('room_states',roomId,{active:true,mode:'chat',speaking:'codex',compressing:'claude',generatingImage:true,discussion:{mentionQueue:[{memberId:'codex',messageId:'m-'+id}],workWaiting:true}});store.put('room_messages','m-'+id,{id:'m-'+id,threadId:thread.id,author:'user',text:id,at:''});
    }
    store.close();const backup=await fixtureBackup(data,'manual'),restorer=new BackupRestorer(data),prepared=await restorer.prepare(backup.id),before=await fixtureBackup(data,'before-restore');await restorer.apply(prepared.token,before.id);store=new Store(data);
    assert.notEqual(store.get<any>('projects','hidden-a').directory,store.get<any>('projects','hidden-b').directory);
    for(const id of ['a','b']){const state=store.roomState(`project:${id}`),session=store.get<Session>('sessions','s-'+id)!;assert.equal(state.active,false);assert.equal(state.speaking,undefined);assert.equal(state.compressing,undefined);assert.equal(state.generatingImage,undefined);assert.equal(state.discussion!.mentionQueue!.length,0);assert.equal(state.discussion!.workWaiting,false);assert.equal(session.nativeId,undefined);assert.equal(session.restoredHistoryOnly,false);assert.equal(store.roomView(`project:${id}`).messages[0].text,id);}
  }finally{try{store.close();}catch{}await rm(directory,{recursive:true,force:true});}
});
async function writeLogins(data:string,label:string){for(const name of loginFiles){const file=path.join(data,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,`${label}: synthetic ${name}`);}}
async function assertLogins(data:string,label:string){for(const name of loginFiles)assert.equal(await readFile(path.join(data,name),'utf8'),`${label}: synthetic ${name}`);}

async function fixture(){
  const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM restore-')),data=path.join(directory,'data'),project=path.join(directory,'project');await mkdir(project);await writeFile(path.join(project,'file.txt'),'project stays current');
  const store=new Store(data),at=new Date().toISOString();
  store.put('settings','main',{...DEFAULT_SETTINGS,automationPolicies:{'member-chat':{enabled:true,dailyLimit:5}}});store.put('members','claude',{...BUILTIN_MEMBERS[0],name:'备份人物'});
  store.put('projects','p',{id:'p',name:'项目',directory:project,createdAt:at,collaborationPaused:false});
  store.put('sessions','s',{id:'s',projectId:'p',provider:'claude',title:'旧任务',revision:1,writeMode:true,createdAt:at,updatedAt:at,nativeId:'native-old',nativeHome:'airoom',workspace:path.join(data,'workspaces','old'),workspaceKind:'copy'});
  store.put('runs','r',{id:'r',sessionId:'s',projectId:'p',provider:'claude',revision:1,status:'ended',delivery:'confirmed',input:'task',bootId:'old',createdAt:at,updatedAt:at,completedAt:at,workspaceUndo:{status:'available'}});
  store.put('runs','pending',{id:'pending',sessionId:'s',projectId:'p',provider:'claude',revision:1,status:'running',delivery:'confirmed',input:'pending',bootId:'old',createdAt:at,updatedAt:at});
  store.put('outbox','r',{runId:'r',sessionId:'s',delivery:'confirmed'});store.put('outbox','pending',{runId:'pending',sessionId:'s',delivery:'confirmed'});
  store.put('outbox','pending-supplement',{runId:'pending',sessionId:'s',kind:'steer',delivery:'prepared'});
  store.put('approvals','a',{id:'a',runId:'pending',sessionId:'s',provider:'claude',state:'pending'});store.put('providers','claude',{id:'claude',name:'Claude',auth:'subscription',available:true,detail:'fake',capabilities:{steer:false,cancel:'native',streaming:true,write:true,history:true}});store.put('quotas','claude',{provider:'claude'});
  store.put('timed_jobs','job',{id:'job',name:'旧提醒',enabled:true,revision:1,schedule:{kind:'interval',minutes:60},action:{kind:'notice',text:'old'},createdAt:at,updatedAt:at,nextAt:new Date(Date.now()+3600000).toISOString()});
  await mkdir(path.join(data,'assets'));await writeFile(path.join(data,'assets','card.webp'),'old portrait');await mkdir(path.join(data,'attachments','picture'),{recursive:true});await writeFile(path.join(data,'attachments','picture','image.png'),'old image');
  await mkdir(path.join(data,'native','claude'),{recursive:true});await writeFile(path.join(data,'native','claude','.credentials.json'),'test credentials stay out of backups');store.close();
  return {directory,data,project,cleanup:()=>rm(directory,{recursive:true,force:true})};
}
test('a checked staged restore retains history and pictures, clears native/copy references, and never resumes old work',async()=>{
  const f=await fixture();let engine:Engine|undefined;
  try{
    await writeLogins(f.data,'before backup');
    const backup=await fixtureBackup(f.data,'manual'),restorer=new BackupRestorer(f.data),preview=await restorer.preview(backup.id);
    assert.equal(preview.manifest.counts.sessions,1);assert.deepEqual(preview.memberNames,['备份人物']);
    const prepared=await restorer.prepare(backup.id);await writeFile(path.join(f.data,'assets','card.webp'),'new portrait');await writeLogins(f.data,'current login');const before=await fixtureBackup(f.data,'before-restore');
    const moved:string[]=[];
    const result=await restorer.apply(prepared.token,before.id,async(source,target)=>{moved.push(path.relative(f.data,String(source)));await rename(source,target);});assert.equal(result.restored,true);assert.equal(await readFile(path.join(f.data,'assets','card.webp'),'utf8'),'old portrait');
    assert.equal(await readFile(path.join(f.project,'file.txt'),'utf8'),'project stays current');await assertLogins(f.data,'current login');
    assert.ok(moved.every(name=>!['native','secrets','deepseek.secret'].includes(name)),'login roots must never leave the data directory');
    for(const name of ['native','secrets','deepseek.secret'])await assert.rejects(readFile(path.join(result.rollbackDirectory,name)),/ENOENT/);
    assert.match(result.detail,/当前成员登录已保留/);
    let dispatched=0;engine=new Engine(f.data,()=>{},()=>{},()=>{dispatched++;throw new Error('native work must never start');});
    const session=engine.store.get<Session>('sessions','s')!;assert.equal(session.restoredHistoryOnly,true);assert.equal(session.nativeId,undefined);assert.equal(session.workspace,undefined);
    assert.equal(engine.store.get<Run>('runs','r')!.workspaceUndo!.status,'unavailable');assert.equal(engine.store.get<Run>('runs','pending')!.status,'unknown');
    assert.equal(engine.store.get<{delivery:string}>('outbox','r')!.delivery,'confirmed','completed historical receipts stay factual');assert.equal(engine.store.get<{delivery:string}>('outbox','pending')!.delivery,'unknown');
    assert.equal(engine.store.get<{delivery:string}>('outbox','pending-supplement')!.delivery,'unknown','a prepared steer may already be delivered and cannot be treated as withdrawn');
    assert.equal(engine.store.get<{state:string}>('approvals','a')!.state,'expired');assert.equal(engine.snapshot().automation!.paused,true);assert.equal(engine.snapshot().automation!.jobs[0].enabled,false);
    await assert.rejects(engine.send('s','continue'),/仅保留历史/);await assert.rejects(engine.invoke('run.validate',{runId:'r',validation:'old'}),/仅保留历史/);await assert.rejects(engine.invoke('workspace.apply',{sessionId:'s'}),/仅保留历史/);
    assert.deepEqual(await engine.invoke('artifact.list',{sessionId:'s'}),[]);assert.equal(dispatched,0);
  }finally{await engine?.close();await f.cleanup();}
});
test('corrupt backup and staged files or traversal records are rejected before current data changes',async()=>{
  const f=await fixture();try{
    const backup=await fixtureBackup(f.data,'manual'),restorer=new BackupRestorer(f.data),current=await readFile(path.join(f.data,'airoom.sqlite'));
    const prepared=await restorer.prepare(backup.id),before=await fixtureBackup(f.data,'before-restore');
    const stages=await readdir(path.join(f.directory,'.restore-previews'));await writeFile(path.join(f.directory,'.restore-previews',stages[0],'attachments','picture','image.png'),'corrupted staging');
    await assert.rejects(restorer.apply(prepared.token,before.id),/校验失败/);assert.deepEqual(await readFile(path.join(f.data,'airoom.sqlite')),current);
    await writeFile(path.join(backup.directory,'attachments','picture','image.png'),'corrupted backup');await assert.rejects(restorer.preview(backup.id),/校验失败/);
    const manifest={...backup.manifest,files:[...backup.manifest.files,{path:'assets/../../native/auth.json',size:0,sha256:'0'.repeat(64)}]};await writeFile(path.join(backup.directory,'manifest.json'),JSON.stringify(manifest));await assert.rejects(restorer.prepare(backup.id),/越界/);
    assert.deepEqual(await readFile(path.join(f.data,'airoom.sqlite')),current);await assert.rejects(restorer.apply('invented-token',before.id),/预览已过期/);
  }finally{await f.cleanup();}
});
test('a replacement failure restores payloads without moving or rolling back current logins',async()=>{
  const f=await fixture();try{
    await writeLogins(f.data,'before backup');
    const backup=await fixtureBackup(f.data,'manual'),restorer=new BackupRestorer(f.data),prepared=await restorer.prepare(backup.id),before=await fixtureBackup(f.data,'before-restore'),current=await readFile(path.join(f.data,'airoom.sqlite'));
    await assert.rejects(restorer.apply(prepared.token,before.id,async(source,target)=>{
      assert.ok(!['native','secrets','deepseek.secret'].includes(path.relative(f.data,String(source))),'even transiently, login roots must stay put');
      if(String(source).includes('.restore-previews')&&path.basename(String(target))==='attachments'){await writeLogins(f.data,'externally renewed login');throw new Error('simulated locked folder');}
      await rename(source,target);
    }),/已恢复原状/);
    assert.deepEqual(await readFile(path.join(f.data,'airoom.sqlite')),current);assert.equal(await readFile(path.join(f.data,'assets','card.webp'),'utf8'),'old portrait');await assertLogins(f.data,'externally renewed login');
  }finally{await f.cleanup();}
});
test('startup recovery rolls back a process death between payload replacements',async()=>{
  const f=await fixture();try{
    await writeLogins(f.data,'current login');
    const backup=await fixtureBackup(f.data,'manual'),restorer=new BackupRestorer(f.data),prepared=await restorer.prepare(backup.id),stage=path.join(f.directory,'.restore-previews',prepared.token),rollback=path.join(f.directory,`.restore-rollback-${randomUUID()}`);await mkdir(rollback);
    const current=await readFile(path.join(f.data,'airoom.sqlite'));
    const journal=path.join(f.directory,`.restore-journal-${createHash('sha256').update(f.data.toLowerCase()).digest('hex').slice(0,20)}.json`);
    await writeFile(journal,JSON.stringify({dataDirectory:f.data,stage,rollback,original:['airoom.sqlite','native','assets','attachments'],payload:['airoom.sqlite','assets','attachments'],phase:'replacing'}));
    await rename(path.join(f.data,'airoom.sqlite'),path.join(rollback,'airoom.sqlite'));await rename(path.join(stage,'airoom.sqlite'),path.join(f.data,'airoom.sqlite'));
    await recoverInterruptedRestore(f.data);assert.deepEqual(await readFile(path.join(f.data,'airoom.sqlite')),current);await assert.rejects(readFile(journal),/ENOENT/);assert.equal(await readFile(path.join(f.data,'assets','card.webp'),'utf8'),'old portrait');await assertLogins(f.data,'current login');
  }finally{await f.cleanup();}
});

for(const phase of ['replacing','committed'] as const)for(const renewed of [false,true])test(`legacy ${phase} journal ${renewed?'preserves renewed':'recovers missing'} local logins`,async()=>{
  const f=await fixture();try{
    await writeLogins(f.data,'prior login');
    const backup=await fixtureBackup(f.data,'manual'),restorer=new BackupRestorer(f.data),prepared=await restorer.prepare(backup.id),stage=path.join(f.directory,'.restore-previews',prepared.token),rollback=path.join(f.directory,`.restore-rollback-${randomUUID()}`);await mkdir(rollback);
    for(const name of ['native','secrets','deepseek.secret'])await rename(path.join(f.data,name),path.join(rollback,name));
    if(renewed)await writeLogins(f.data,'renewed login');
    const journal=path.join(f.directory,`.restore-journal-${createHash('sha256').update(f.data.toLowerCase()).digest('hex').slice(0,20)}.json`);
    await writeFile(journal,JSON.stringify({dataDirectory:f.data,stage,rollback,original:['airoom.sqlite','native','secrets','deepseek.secret','assets','attachments'],payload:['airoom.sqlite','assets','attachments'],phase}));
    await recoverInterruptedRestore(f.data);await assertLogins(f.data,renewed?'renewed login':'prior login');await assert.rejects(readFile(journal),/ENOENT/);
    if(renewed)await assertLogins(rollback,'prior login');
    await recoverInterruptedRestore(f.data);await assertLogins(f.data,renewed?'renewed login':'prior login');
  }finally{await f.cleanup();}
});
test('manual backup writes one checked bundle and failed writes release the maintenance lock',async()=>{
  const f=await fixture();let engine:Engine|undefined;
  try{
    engine=new Engine(f.data,()=>{},()=>{},undefined,undefined,undefined,async(data,reason)=>{await fixtureBackup(data,reason);});
    const entry=await engine.invoke('backup.create') as {id:string};assert.ok(entry.id.includes('manual'));assert.equal((await engine.invoke('backup.list') as unknown[]).length,1);
    await engine.close();engine=new Engine(f.data,()=>{},()=>{},undefined,undefined,undefined,async()=>{throw new Error('disk unavailable');});
    await assert.rejects(engine.invoke('backup.create'),/disk unavailable/);await assert.doesNotReject(engine.invoke('settings.save',{settings:engine.settings}));
  }finally{await engine?.close();await f.cleanup();}
});

test('backup refuses active account checks and blocks new work until its checked bundle is saved',async()=>{
  const f=await fixture();let engine:Engine|undefined,releaseProbe!:()=>void,releaseBackup!:()=>void;
  const probeGate=new Promise<void>(resolve=>{releaseProbe=resolve;}),backupGate=new Promise<void>(resolve=>{releaseBackup=resolve;});let probes=0;
  let entered!:()=>void;const writing=new Promise<void>(resolve=>{entered=resolve;});
  try{
    engine=new Engine(f.data,()=>{},()=>{},id=>({probe:async()=>{probes++;await probeGate;return {id,name:id,auth:'none',available:false,detail:'test only',capabilities:{steer:false,cancel:'native',streaming:true,write:true,history:true}};},start:async()=>{throw new Error('no model request expected');},stop:async()=>{}}),undefined,undefined,async(data,reason)=>{entered();await backupGate;await fixtureBackup(data,reason);});
    const probing=engine.probe('claude');await assert.rejects(engine.invoke('backup.create'),/连接检测/);releaseProbe();await probing;
    const wasPaused=engine.snapshot().automation!.paused,saving=engine.invoke('backup.create');await writing;
    assert.equal(engine.snapshot().automation!.paused,true);
    await assert.rejects(engine.invoke('settings.save',{settings:engine.settings}),/正在备份或恢复/);await assert.rejects(engine.send('s','new work'),/正在备份或恢复/);
    await assert.rejects(engine.invoke('backup.delete',{id:'backup-in-use',confirm:true}),/正在备份或恢复/);
    await engine.probe('claude');assert.equal(probes,1,'a retry cannot refresh credentials during maintenance');
    releaseBackup();await saving;assert.equal(engine.snapshot().automation!.paused,wasPaused);await assert.doesNotReject(engine.invoke('settings.save',{settings:engine.settings}));
  }finally{releaseProbe();releaseBackup();await engine?.close();await f.cleanup();}
});
