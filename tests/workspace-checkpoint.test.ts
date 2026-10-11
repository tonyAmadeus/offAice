import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { Project, Session } from '../src/shared/types';
import { prepareWorkspace, applyWorkspace, discardWorkspace } from '../src/backend/workspace';
import { beginCheckpoint, finishCheckpoint, checkpointInfo, undoCheckpoint } from '../src/backend/workspace-checkpoint';

const exec=promisify(execFile),base=path.resolve('.test-cache/checkpoints');
const git=async(cwd:string,args:string[])=>(await exec('git',args,{cwd,windowsHide:true})).stdout;
async function fixture(repository=false){
  await fs.mkdir(base,{recursive:true});const directory=await fs.mkdtemp(path.join(base,'case-')),source=path.join(directory,'source'),data=path.join(directory,'data');
  await fs.mkdir(source);await fs.mkdir(data);await fs.writeFile(path.join(source,'change.txt'),'before');await fs.writeFile(path.join(source,'keep.txt'),'keep');
  await fs.writeFile(path.join(source,'remove.bin'),Buffer.from([0,255,3]));await fs.writeFile(path.join(source,'rename-old.txt'),'rename');
  if(repository){await git(source,['init']);await git(source,['add','.']);await git(source,['-c','user.name=Test','-c','user.email=test@local','commit','-m','baseline']);await fs.writeFile(path.join(source,'keep.txt'),'existing staged edit');await git(source,['add','keep.txt']);await fs.writeFile(path.join(source,'untracked.txt'),'existing untracked');}
  const project:Project={id:'p',name:'test',directory:source,createdAt:'',collaborationPaused:false};
  const session:Session={id:'s',projectId:'p',provider:'claude',title:'test',revision:1,writeMode:true,createdAt:'',updatedAt:''};
  const prepared=await prepareWorkspace(project,session,true,data);Object.assign(session,{workspace:prepared.directory,workspaceKind:prepared.kind});
  const file=(name:string)=>path.join(session.workspace!,name);
  const cleanup=async()=>{await discardWorkspace(session,project,data);assert.ok(path.relative(base,directory).startsWith('case-'));await fs.rm(directory,{recursive:true,force:true});};
  return {directory,source,data,project,session,file,cleanup};
}
for(const repository of [false,true])test(`${repository?'Git':'plain copy'}: last-round undo restores binary/deleted/renamed files and leaves the source and earlier edits intact`,async()=>{
  const f=await fixture(repository);try{
    const originalIndex=repository?await fs.readFile(path.join(f.source,'.git','index')):undefined;
    const index=repository?(await git(f.session.workspace!,['rev-parse','--git-path','index'])).trim():undefined;
    const copyIndex=index?await fs.readFile(index):undefined;
    await beginCheckpoint(f.session,'round-1',f.data);if(index)assert.deepEqual(await fs.readFile(index),copyIndex,'private snapshot never changes the real index');
    await fs.writeFile(f.file('earlier.txt'),'first-round edit');await finishCheckpoint(f.session,'round-1',f.data);
    assert.equal(await beginCheckpoint(f.session,'round-2',f.data),'round-1');
    await fs.writeFile(f.file('change.txt'),'round-two change');await fs.unlink(f.file('remove.bin'));await fs.rename(f.file('rename-old.txt'),f.file('rename-new.txt'));await fs.writeFile(f.file('added.bin'),Buffer.from([1,0,4]));
    if(repository){await fs.writeFile(f.file('.gitignore'),'ignored/');await fs.mkdir(f.file('ignored'));await fs.writeFile(f.file('ignored/out.txt'),'ignored build');await git(f.session.workspace!,['add','change.txt']);}
    const ended=await finishCheckpoint(f.session,'round-2',f.data);assert.equal(ended.status,'available');
    await fs.writeFile(f.file('manual-unrelated.txt'),'later human edit');
    await assert.rejects(undoCheckpoint(f.session,'round-1',f.data),/最近一轮已经改变/);
    const result=await undoCheckpoint(f.session,'round-2',f.data);assert.equal(result.status,'undone');
    assert.equal(await fs.readFile(f.file('change.txt'),'utf8'),'before');assert.deepEqual(await fs.readFile(f.file('remove.bin')),Buffer.from([0,255,3]));
    assert.equal(await fs.readFile(f.file('rename-old.txt'),'utf8'),'rename');await assert.rejects(fs.access(f.file('rename-new.txt')));await assert.rejects(fs.access(f.file('added.bin')));
    assert.equal(await fs.readFile(f.file('earlier.txt'),'utf8'),'first-round edit');assert.equal(await fs.readFile(f.file('manual-unrelated.txt'),'utf8'),'later human edit');
    assert.equal(await fs.readFile(path.join(f.source,'change.txt'),'utf8'),'before');assert.equal((await checkpointInfo(f.session,f.data)).canUndo,false);
    if(repository){assert.deepEqual(await fs.readFile(path.join(f.source,'.git','index')),originalIndex);assert.deepEqual(await fs.readFile(index!),copyIndex);assert.equal(await git(f.source,['stash','list']),'');assert.equal(await fs.readFile(f.file('ignored/out.txt'),'utf8'),'ignored build');}
  }finally{await f.cleanup();}
});
test('a later edit to any touched file cancels the entire undo without changing other files',async()=>{
  const f=await fixture();try{
    await beginCheckpoint(f.session,'r',f.data);await fs.writeFile(f.file('change.txt'),'round');await fs.writeFile(f.file('keep.txt'),'round');await finishCheckpoint(f.session,'r',f.data);
    await fs.writeFile(f.file('change.txt'),'human edit');const result=await undoCheckpoint(f.session,'r',f.data);
    assert.equal(result.canUndo,false);assert.equal(result.conflicts.length,1);assert.equal(await fs.readFile(f.file('keep.txt'),'utf8'),'round');assert.equal(await fs.readFile(f.file('change.txt'),'utf8'),'human edit');
  }finally{await f.cleanup();}
});
test('undo after an apply changes only the copy; applying the reverted copy remains an explicit action',async()=>{
  const f=await fixture();try{
    await beginCheckpoint(f.session,'r',f.data);await fs.writeFile(f.file('change.txt'),'applied round');await finishCheckpoint(f.session,'r',f.data);
    await applyWorkspace(f.session.workspace!,f.source);await undoCheckpoint(f.session,'r',f.data);
    assert.equal(await fs.readFile(path.join(f.source,'change.txt'),'utf8'),'applied round');assert.equal(await fs.readFile(f.file('change.txt'),'utf8'),'before');
    await applyWorkspace(f.session.workspace!,f.source);assert.equal(await fs.readFile(path.join(f.source,'change.txt'),'utf8'),'before');
  }finally{await f.cleanup();}
});
test('Git index edits after the round conflict, and a committed round never rewrites Git history',async()=>{
  const f=await fixture(true);try{
    await beginCheckpoint(f.session,'r',f.data);await fs.writeFile(f.file('change.txt'),'round');await finishCheckpoint(f.session,'r',f.data);
    await git(f.session.workspace!,['add','change.txt']);assert.equal((await undoCheckpoint(f.session,'r',f.data)).conflicts[0].path,'Git');assert.equal(await fs.readFile(f.file('change.txt'),'utf8'),'round');
    await beginCheckpoint(f.session,'commit-round',f.data);await git(f.session.workspace!,['-c','user.name=Test','-c','user.email=test@local','commit','-m','AI commit']);
    const head=await git(f.session.workspace!,['rev-parse','HEAD']);const result=await finishCheckpoint(f.session,'commit-round',f.data);assert.equal(result.status,'unavailable');assert.match(result.reason!,/提交/);
    await undoCheckpoint(f.session,'commit-round',f.data);assert.equal(await git(f.session.workspace!,['rev-parse','HEAD']),head);
  }finally{await f.cleanup();}
});
test('no-op, missing finish and unconfirmed process cleanup never offer an unsafe undo',async()=>{
  const f=await fixture();try{
    assert.equal((await checkpointInfo(f.session,f.data)).status,'missing');await beginCheckpoint(f.session,'no-op',f.data);assert.equal((await checkpointInfo(f.session,f.data)).canUndo,false);
    assert.equal((await finishCheckpoint(f.session,'no-op',f.data)).status,'none');
    await beginCheckpoint(f.session,'unclean',f.data);await fs.writeFile(f.file('change.txt'),'partial');assert.equal((await finishCheckpoint(f.session,'unclean',f.data,false)).status,'unavailable');
    assert.equal((await undoCheckpoint(f.session,'unclean',f.data)).canUndo,false);assert.equal(await fs.readFile(f.file('change.txt'),'utf8'),'partial');
  }finally{await f.cleanup();}
});
test('Git-only staging changes can be undone and changed ignore rules never hide earlier eligible files',async()=>{
  const f=await fixture(true);try{
    const index=(await git(f.session.workspace!,['rev-parse','--git-path','index'])).trim(),before=await fs.readFile(index);
    await beginCheckpoint(f.session,'stage',f.data);await git(f.session.workspace!,['add','keep.txt']);const stage=await finishCheckpoint(f.session,'stage',f.data);assert.equal(stage.status,'available');assert.equal(stage.changes.length,0);
    await undoCheckpoint(f.session,'stage',f.data);assert.deepEqual(await fs.readFile(index),before);
    await beginCheckpoint(f.session,'ignore',f.data);await fs.writeFile(f.file('.gitignore'),'untracked.txt\n');await fs.writeFile(f.file('untracked.txt'),'modified then ignored');await finishCheckpoint(f.session,'ignore',f.data);
    assert.equal((await undoCheckpoint(f.session,'ignore',f.data)).status,'undone');assert.equal(await fs.readFile(f.file('untracked.txt'),'utf8'),'existing untracked');
  }finally{await f.cleanup();}
});
test('a failed replacement rolls back earlier file writes, and an existing Git index lock cancels undo',async()=>{
  const f=await fixture(true);const rename=fs.rename;try{
    await beginCheckpoint(f.session,'r',f.data);await fs.writeFile(f.file('change.txt'),'round');await fs.writeFile(f.file('keep.txt'),'round');await finishCheckpoint(f.session,'r',f.data);
    const directory=(await git(f.session.workspace!,['rev-parse','--absolute-git-dir'])).trim(),lock=path.join(directory,'index.lock');await fs.writeFile(lock,'another process');
    assert.equal((await undoCheckpoint(f.session,'r',f.data)).canUndo,false);await fs.unlink(lock);
    let rejected=false;fs.rename=async(from,to)=>{if(!rejected&&String(to)===f.file('keep.txt')){rejected=true;throw new Error('simulated disk failure');}await rename(from,to);};
    await assert.rejects(undoCheckpoint(f.session,'r',f.data),/disk failure/);assert.equal(await fs.readFile(f.file('change.txt'),'utf8'),'round');assert.equal(await fs.readFile(f.file('keep.txt'),'utf8'),'round');
    assert.equal((await checkpointInfo(f.session,f.data)).canUndo,true);await assert.rejects(fs.access(lock));
  }finally{fs.rename=rename;await f.cleanup();}
});
test('links, foreign workspace roots and corrupted backups are rejected before any restoration',async()=>{
  const f=await fixture();try{
    await assert.rejects(beginCheckpoint({...f.session,workspace:f.source},'foreign',f.data),/工作区目录/);
    await assert.rejects(beginCheckpoint({...f.session,workspaceKind:'original'},'original',f.data),/独立工作副本/);
    await beginCheckpoint(f.session,'r',f.data);await fs.writeFile(f.file('change.txt'),'round');await finishCheckpoint(f.session,'r',f.data);
    const objectRoot=path.join(f.data,'checkpoints',createHash('sha256').update(f.session.id).digest('hex').slice(0,24),'objects');
    await fs.writeFile(path.join(objectRoot,createHash('sha256').update('before').digest('hex')),'damaged');
    assert.equal((await undoCheckpoint(f.session,'r',f.data)).canUndo,false);assert.equal(await fs.readFile(f.file('change.txt'),'utf8'),'round');
    await fs.mkdir(path.join(f.directory,'external'));await fs.symlink(path.join(f.directory,'external'),f.file('link'),'junction');
    await assert.rejects(beginCheckpoint(f.session,'link-round',f.data),/链接/);
    await fs.unlink(f.file('link'));
  }finally{await f.cleanup();}
});

for(const boundary of ['index','head'])test(`Git ${boundary} changed just before the undo lock is preserved without any file restoration`,async()=>{
  const f=await fixture(true),open=fs.open;let laterIndex:Buffer|undefined,laterHead:string|undefined;
  try{
    await beginCheckpoint(f.session,'r',f.data);await fs.writeFile(f.file('change.txt'),'round');await finishCheckpoint(f.session,'r',f.data);
    const directory=(await git(f.session.workspace!,['rev-parse','--absolute-git-dir'])).trim(),index=path.join(directory,'index'),lock=path.join(directory,'index.lock');
    let injected=false;
    fs.open=(async(...args:Parameters<typeof open>)=>{
      if(!injected&&String(args[0])===lock){
        injected=true;
        if(boundary==='index')await git(f.session.workspace!,['add','change.txt']);
        else await git(f.session.workspace!,['-c','user.name=Test','-c','user.email=test@local','commit','--allow-empty','-m','later commit']);
        laterIndex=await fs.readFile(index);laterHead=await git(f.session.workspace!,['rev-parse','HEAD']);
      }
      return open(...args);
    }) as typeof open;
    await assert.rejects(undoCheckpoint(f.session,'r',f.data),/撤销前 Git/);assert.equal(injected,true);
    assert.equal(await fs.readFile(f.file('change.txt'),'utf8'),'round');assert.deepEqual(await fs.readFile(index),laterIndex);assert.equal(await git(f.session.workspace!,['rev-parse','HEAD']),laterHead);await assert.rejects(fs.access(lock));
  }finally{fs.open=open;await f.cleanup();}
});
