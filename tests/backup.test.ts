import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rename, rm, writeFile, symlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createBackup, DEPLOY_BACKUPS_KEPT, publishBackupDirectory } from '../src/backend/backup';
import { BackupRestorer, backupDirectory } from '../src/backend/backup-restore';
import { Store } from '../src/backend/store';
import { BUILTIN_MEMBERS } from '../src/shared/defaults';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'AIROOM backup-')), data = path.join(directory, 'data');
  const store = new Store(data), at = new Date().toISOString();
  store.put('members', 'claude', { ...BUILTIN_MEMBERS[0], name: '备份里的 Claudia' });
  store.put('room_threads', 't', { id: 't', title: '话题', createdAt: at });
  for (const id of ['m1', 'm2']) store.put('room_messages', id, { id, author: 'user', text: id, at, status: 'done', threadId: 't' });
  // Left open: the backup must read a consistent copy while the app still has the database (and its WAL) open.
  await mkdir(path.join(data, 'assets'), { recursive: true }); await writeFile(path.join(data, 'assets', 'card.webp'), 'portrait');
  await mkdir(path.join(data, 'attachments', 'a1'), { recursive: true }); await writeFile(path.join(data, 'attachments', 'a1', '图.png'), 'picture');
  for (const [folder, file] of [['native/claude', '.credentials.json'], ['members/codex', 'codex.exe'], ['workspaces/w', 'x.ts'], ['checkpoints/c', 'y'], ['logs', 'today.jsonl']]) {
    await mkdir(path.join(data, folder), { recursive: true }); await writeFile(path.join(data, folder, file), 'never in a backup');
  }
  await writeFile(path.join(directory, 'deployment-receipt.json'), '﻿' + JSON.stringify({ sourceCommit: 'abc1234', userSessionAcceptance: 'pending' }));
  let closed=false;const close=()=>{if(!closed){closed=true;store.close();}};
  return { directory, data, store, close, cleanup: async () => { close(); await rm(directory, { recursive: true, force: true }); } };
}

test('a backup holds a consistent database, pictures and attachments, never logins, and passes the restore check', async () => {
  const f = await fixture();
  try {
    f.store.put('room_messages', 'm3', { id: 'm3', author: 'user', text: '还在 WAL 里的最新消息', at: new Date().toISOString(), status: 'done', threadId: 't' });
    const result = await createBackup(f.data, 'manual');
    assert.equal(path.dirname(result.directory), backupDirectory(f.data), 'backups live beside the data folder, not inside it');
    // The store always has its default topic besides the one written here.
    assert.deepEqual(result.manifest.counts, { threads: 2, messages: 3, members: 1, sessions: 0, runs: 0 });
    assert.equal(result.manifest.sourceCommit, 'abc1234'); assert.equal(result.manifest.reason, 'manual'); assert.equal(result.manifest.formatVersion, 1);
    assert.deepEqual(result.manifest.files.map(file => file.path), ['airoom.sqlite', 'assets/card.webp', 'attachments/a1/图.png']);
    // Gptia's restorer is the other half of the format: it must accept this backup unchanged.
    const preview = await new BackupRestorer(f.data).preview(result.id);
    assert.deepEqual(preview.memberNames, ['备份里的 Claudia']); assert.equal(preview.manifest.counts.messages, 3);
    const listed = await new BackupRestorer(f.data).list();
    assert.deepEqual(listed.map(entry => [entry.id, entry.error]), [[result.id, undefined]]);
    assert.equal((await readdir(backupDirectory(f.data))).some(name => name.startsWith('.partial-')), false);
  } finally { await f.cleanup(); }
});

test('an installed app in a separate folder records its own build instead of the legacy data-parent runtime',async()=>{
  const f=await fixture(),previous=process.env.AIROOM_APP_ROOT;
  try{
    const app=path.join(f.directory,'installed/resources/app');await mkdir(app,{recursive:true});await writeFile(path.join(app,'package.json'),JSON.stringify({version:'0.2.0'}));await writeFile(path.join(f.directory,'installed/build-manifest.json'),JSON.stringify({sourceCommit:'new-installed-build'}));process.env.AIROOM_APP_ROOT=app;
    const backup=await createBackup(f.data,'manual');assert.equal(backup.manifest.sourceCommit,'new-installed-build');assert.equal(backup.manifest.appVersion,'0.2.0');
  }finally{if(previous===undefined)delete process.env.AIROOM_APP_ROOT;else process.env.AIROOM_APP_ROOT=previous;await f.cleanup();}
});

test('manual, deployment and before-restore backups share one verified latest copy', async () => {
  const f = await fixture();
  try {
    assert.equal(DEPLOY_BACKUPS_KEPT,1);
    for(const reason of ['manual','deploy','before-restore','manual'] as const){
      const latest=await createBackup(f.data,reason);
      assert.deepEqual(await readdir(backupDirectory(f.data)),[latest.id]);
      await new BackupRestorer(f.data).preview(latest.id);
    }
  } finally { await f.cleanup(); }
});

test('failed creation preserves the last good backup; corrupt backups can be deleted without touching current data',async()=>{
  const f=await fixture();
  try{
    const good=await createBackup(f.data,'manual'),before=await readFile(path.join(f.data,'airoom.sqlite'));
    const outside=path.join(f.directory,'outside');await mkdir(outside);await writeFile(path.join(outside,'keep.txt'),'keep');
    const link=path.join(f.data,'assets','linked');await symlink(outside,link,'junction');
    await assert.rejects(createBackup(f.data,'manual'),/链接/);
    assert.deepEqual((await new BackupRestorer(f.data).list()).map(item=>item.id),[good.id]);
    assert.equal(await readFile(path.join(outside,'keep.txt'),'utf8'),'keep');
    await rm(link);await writeFile(path.join(good.directory,'manifest.json'),'broken');
    const backups=new BackupRestorer(f.data);assert.ok((await backups.list())[0].error);
    await backups.remove(good.id);assert.deepEqual(await backups.list(),[]);
    assert.deepEqual(await readFile(path.join(f.data,'airoom.sqlite')),before);
  }finally{await f.cleanup();}
});

test('rotation preserves a corrupt old payload for inspection while retaining the new verified backup',async()=>{
  const f=await fixture();try{
    const old=await createBackup(f.data,'manual');await writeFile(path.join(old.directory,'assets/card.webp'),'corrupted portrait');
    const latest=await createBackup(f.data,'deploy'),backups=new BackupRestorer(f.data);assert.equal((await backups.list()).length,2);await assert.rejects(backups.preview(old.id));await backups.preview(latest.id);
    await backups.remove(old.id);assert.deepEqual((await backups.list()).map(item=>item.id),[latest.id]);
  }finally{await f.cleanup();}
});

test('backup deletion rejects traversal, linked descendants and a prepared restore source',async()=>{
  const f=await fixture();
  try{
    const good=await createBackup(f.data,'manual'),backups=new BackupRestorer(f.data);
    for(const id of ['..','../data','C:/Windows','.partial-copy'])await assert.rejects(backups.remove(id),/编号无效/);
    const prepared=await backups.prepare(good.id);await assert.rejects(backups.remove(good.id),/准备恢复/);await backups.cancel(prepared.token);
    const link=path.join(good.directory,'escape');await symlink(f.data,link,'junction');
    await assert.rejects(backups.remove(good.id),/链接/);assert.ok((await lstat(good.directory)).isDirectory());
    await rm(link);await backups.remove(good.id);assert.deepEqual(await backups.list(),[]);
  }finally{await f.cleanup();}
});

test('a prepared restore remains usable after the before-restore backup rotates its original source',async()=>{
  const f=await fixture();
  try{
    const good=await createBackup(f.data,'manual'),backups=new BackupRestorer(f.data),prepared=await backups.prepare(good.id);
    const before=await createBackup(f.data,'before-restore');
    assert.deepEqual((await backups.list()).map(item=>item.id),[before.id]);
    f.close();const result=await backups.apply(prepared.token,before.id);assert.equal(result.restored,true);
  }finally{await f.cleanup();}
});

test('a failed backup leaves no folder behind, and an unused data folder is skipped by the deploy command', async () => {
  const f = await fixture();
  try {
    await assert.rejects(createBackup(f.data, 'weekly' as never), /原因无效/);
    await assert.rejects(createBackup(path.join(f.directory, 'empty'), 'deploy'), /还没有可备份的资料/);
    const empty = path.join(f.directory, 'unused'); await mkdir(empty);
    const run = spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/backend/backup.ts'), empty, 'deploy'], { encoding: 'utf8', env: process.env });
    assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /跳过备份/);
    const ok = spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/backend/backup.ts'), f.data, 'deploy'], { encoding: 'utf8', env: process.env });
    assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /已备份/);
    const [id] = (await readdir(backupDirectory(f.data))).filter(name => name.includes('-deploy-'));
    assert.equal(JSON.parse(await readFile(path.join(backupDirectory(f.data), id, 'manifest.json'), 'utf8')).reason, 'deploy');
  } finally { await f.cleanup(); }
});

test('a brief Windows publish lock retries only the final rename and preserves all completed files',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM backup-publish-')),partial=path.join(root,'partial'),directory=path.join(root,'backup');
  try{
    await mkdir(partial);await writeFile(path.join(partial,'manifest.json'),'complete manifest');let moves=0;
    await publishBackupDirectory(partial,directory,async(from,to)=>{
      moves++;assert.equal(await readFile(path.join(from,'manifest.json'),'utf8'),'complete manifest');
      if(moves<=2)throw Object.assign(new Error('temporary scanner lock'),{code:'EPERM'});
      await rename(from,to);
    },'win32');
    assert.equal(moves,3);assert.equal(await readFile(path.join(directory,'manifest.json'),'utf8'),'complete manifest');assert.deepEqual(await readdir(root),['backup']);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('backup publish never retries permanent errors or replaces an existing destination',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM backup-publish-')),partial=path.join(root,'partial'),directory=path.join(root,'backup');
  try{
    await mkdir(partial);await mkdir(directory);await writeFile(path.join(directory,'manifest.json'),'existing backup');let moves=0;
    const locked=Object.assign(new Error('locked'),{code:'EPERM'});
    await assert.rejects(publishBackupDirectory(partial,directory,async()=>{moves++;throw locked;},'win32'),error=>error===locked);assert.equal(moves,1);assert.equal(await readFile(path.join(directory,'manifest.json'),'utf8'),'existing backup');
    await rm(directory,{recursive:true});
    for(const [code,platform] of [['EIO','win32'],['EEXIST','win32'],['EPERM','linux']] as const){
      moves=0;const failure=Object.assign(new Error('permanent failure'),{code});
      await assert.rejects(publishBackupDirectory(partial,directory,async()=>{moves++;throw failure;},platform),error=>error===failure);assert.equal(moves,1);
    }
    moves=0;const started=Date.now();await assert.rejects(publishBackupDirectory(partial,directory,async()=>{moves++;throw locked;},'win32'),error=>error===locked);
    assert.ok(moves>1&&moves<10);assert.ok(Date.now()-started<5000,'persistent locks must stop after a bounded wait');assert.deepEqual(await readdir(root),['partial']);
  }finally{await rm(root,{recursive:true,force:true});}
});
