import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, unlink, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Engine } from '../src/backend/engine';
import { applyWorkspace, prepareWorkspace, workspaceFingerprint } from '../src/backend/workspace';
import { beginCheckpoint, finishCheckpoint, undoCheckpoint } from '../src/backend/workspace-checkpoint';
import type { Adapter, AdapterContext, Collaboration, Project, Session, Run } from '../src/shared/types';

const exec=promisify(execFile);
async function git(root:string,args:string[]){return exec('git',args,{cwd:root,windowsHide:true});}
for(const useGit of [false,true])test(`${useGit?'Git':'copy'} relay inherits additions, deletions, renames and binary files in a fresh copy, retaining the original baseline`,async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM relay-')),source=path.join(directory,'project'),data=path.join(directory,'data');await mkdir(source);
  await writeFile(path.join(source,'file.txt'),'original');await writeFile(path.join(source,'delete.txt'),'delete');await writeFile(path.join(source,'rename.txt'),'rename');
  if(useGit){await git(source,['init','-q']);await git(source,['add','.']);await git(source,['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','baseline']);}
  const project:Project={id:'p',name:'p',directory:source,createdAt:'',collaborationPaused:false};
  const session=(id:string):Session=>({id,projectId:'p',provider:'claude',title:id,writeMode:true,revision:1,createdAt:'',updatedAt:''});
  const first={...session('first'),...(await prepareWorkspace(project,session('first'),true,data))};
  const author={...session('first'),workspace:first.directory,workspaceKind:first.kind};
  let next:Session|undefined;
  try{
    await writeFile(path.join(first.directory,'file.txt'),'stage one');await unlink(path.join(first.directory,'delete.txt'));await rename(path.join(first.directory,'rename.txt'),path.join(first.directory,'renamed.txt'));
    await writeFile(path.join(first.directory,'image.bin'),Buffer.from([0,255,128,0]));
    const version=await workspaceFingerprint(first.directory);
    await assert.rejects(prepareWorkspace(project,session('wrong-version'),true,data,author,'0'.repeat(64)),/交接前发生变化/);
    const inherited=await prepareWorkspace(project,session('next'),true,data,author);next={...session('next'),workspace:inherited.directory,workspaceKind:inherited.kind};
    assert.notEqual(next.workspace,first.directory);assert.equal(inherited.inherited!.fingerprint,version);
    assert.equal(await readFile(path.join(next.workspace!,'file.txt'),'utf8'),'stage one');
    assert.deepEqual(await readFile(path.join(next.workspace!,'image.bin')),Buffer.from([0,255,128,0]));
    await assert.rejects(readFile(path.join(next.workspace!,'delete.txt')),/ENOENT/);assert.equal(await readFile(path.join(next.workspace!,'renamed.txt'),'utf8'),'rename');
    if(useGit){
      await git(first.directory,['add','-A','--','.',':(exclude).airoom']);await git(first.directory,['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','stage one']);
      const committed=await prepareWorkspace(project,session('after-commit'),true,data,author,version);
      assert.equal(await workspaceFingerprint(committed.directory),version,'a committed predecessor hands over the same content');
      await writeFile(path.join(source,'file.txt'),'external edit');assert.ok((await applyWorkspace(committed.directory,source)).conflicts.some(item=>item.path==='file.txt'),'committing must retain the first project baseline');await writeFile(path.join(source,'file.txt'),'original');
    }
    await beginCheckpoint(next,'round',data);await writeFile(path.join(next.workspace!,'file.txt'),'stage two');await finishCheckpoint(next,'round',data,true);
    assert.equal(await readFile(path.join(first.directory,'file.txt'),'utf8'),'stage one');assert.equal(await readFile(path.join(source,'file.txt'),'utf8'),'original');
    const undone=await undoCheckpoint(next,'round',data);assert.equal(undone.status,'undone');assert.equal(await readFile(path.join(next.workspace!,'file.txt'),'utf8'),'stage one');
    await writeFile(path.join(source,'file.txt'),'external edit');const conflict=await applyWorkspace(next.workspace!,source);assert.equal(conflict.applied.length,0);assert.ok(conflict.conflicts.some(item=>item.path==='file.txt'));
    await writeFile(path.join(source,'file.txt'),'original');const applied=await applyWorkspace(next.workspace!,source);assert.equal(applied.conflicts.length,0);assert.equal(await readFile(path.join(source,'file.txt'),'utf8'),'stage one');
    assert.deepEqual(await readFile(path.join(source,'image.bin')),Buffer.from([0,255,128,0]));await assert.rejects(readFile(path.join(source,'delete.txt')),/ENOENT/);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('legacy collaboration records remain readable but cannot start or resume dispatch',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM legacy-relay-')),source=path.join(directory,'project');await mkdir(source);
  const engine=new Engine(path.join(directory,'data'),()=>{},()=>{});
  try{
    const project=await engine.invoke('project.create',{directory:source}) as Project;
    const legacy:Collaboration={id:'legacy',projectId:project.id,topic:'历史成果',members:['codex','claude'],lead:'codex',mode:'relay',status:'paused',stage:'旧任务已完成一部分',sessionIds:[],createdAt:''};
    engine.store.put('collaborations',legacy.id,legacy);engine.store.put('workflows',legacy.id,{phase:1,results:['保留真实成果'],runIds:[]});
    await assert.rejects(engine.invoke('collaboration.start',{projectId:project.id,members:legacy.members,lead:'codex',mode:'relay',topic:'新接力'}),/圆桌|流程/);
    await assert.rejects(engine.invoke('collaboration.resume',{id:legacy.id}),/只读|只供阅读/);
    assert.deepEqual(engine.snapshot().collaborations,[legacy]);assert.equal(engine.snapshot().runs.length,0);
    assert.deepEqual(engine.store.get('workflows',legacy.id),{phase:1,results:['保留真实成果'],runIds:[]});
  }finally{await engine.close();await rm(directory,{recursive:true,force:true});}
});

test('old council cannot create new dispatch after the independent roundtable replacement',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM council-'));const engine=new Engine(directory,()=>{},()=>{});try{await assert.rejects(engine.invoke('collaboration.start',{mode:'council',topic:'比较两个方案'}),/圆桌/);assert.equal(engine.store.list('collaborations').length,0);assert.equal(engine.store.list('sessions').length,0);}finally{await engine.close();await rm(directory,{recursive:true,force:true});}
});
