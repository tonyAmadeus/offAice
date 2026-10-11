import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {prepareWorkspace,applyWorkspace} from '../src/backend/workspace';
import {beginCheckpoint,finishCheckpoint,checkpointInfo,undoCheckpoint} from '../src/backend/workspace-checkpoint';
import {projectUndoInfo,undoWriteback} from '../src/backend/workspace-writeback';
import type {Project,Session} from '../src/shared/types';
async function fixture(){
  const root=path.resolve('.test-cache/writeback');await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(path.join(root,'case-'));
  const source=path.join(dir,'source'),data=path.join(dir,'data');await fs.mkdir(source);await fs.mkdir(data);
  await fs.writeFile(path.join(source,'a.txt'),'before-a');await fs.writeFile(path.join(source,'b.bin'),Buffer.from([0,255,4]));
  const project={id:'p',name:'fixture',directory:source,createdAt:'',collaborationPaused:false} as Project;
  const session={id:'s',projectId:'p',provider:'claude',title:'fixture',revision:1,writeMode:true,createdAt:'',updatedAt:''} as Session;
  const prepared=await prepareWorkspace(project,session,true,data);Object.assign(session,{workspace:prepared.directory,workspaceKind:prepared.kind});
  const copy=session.workspace!,original=(name:string)=>path.join(source,name),file=(name:string)=>path.join(copy,name);
  await beginCheckpoint(session,'r',data);await fs.writeFile(file('a.txt'),'after-a');await fs.unlink(file('b.bin'));await fs.writeFile(file('c.txt'),'new-c');await finishCheckpoint(session,'r',data);
  const undo=(partial=false,copyUndo=()=>undoCheckpoint(session,'r',data))=>undoWriteback(copy,'r',source,partial,()=>{},copyUndo);
  return {dir,source,copy,data,session,original,file,undo,cleanup:()=>fs.rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100})};
}
test('writeback undo restores exact original bytes, additions and deletions; another apply remains valid',async()=>{const f=await fixture();try{
  await applyWorkspace(f.copy,f.source,undefined,'r');assert.equal((await projectUndoInfo(f.copy,'r',f.source))?.conflicts.length,0);
  assert.equal((await f.undo()).status,'undone');assert.equal(await fs.readFile(f.original('a.txt'),'utf8'),'before-a');assert.deepEqual(await fs.readFile(f.original('b.bin')),Buffer.from([0,255,4]));await assert.rejects(fs.stat(f.original('c.txt')),{code:'ENOENT'});
  assert.equal((await checkpointInfo(f.session,f.data)).status,'undone');assert.equal((await applyWorkspace(f.copy,f.source)).unchanged,true);
  await fs.writeFile(f.file('a.txt'),'next');assert.equal((await applyWorkspace(f.copy,f.source)).applied.length,1);assert.equal(await fs.readFile(f.original('a.txt'),'utf8'),'next');
}finally{await f.cleanup();}});
test('changed originals require explicit partial undo and are retained',async()=>{const f=await fixture();try{
  await applyWorkspace(f.copy,f.source,undefined,'r');await fs.writeFile(f.original('a.txt'),'human');const info=await projectUndoInfo(f.copy,'r',f.source);assert.deepEqual(info?.conflicts.map(c=>c.path),['a.txt']);assert.equal(info?.canRestoreUnchanged,true);
  await assert.rejects(f.undo(),/只恢复/);assert.equal(await fs.readFile(f.original('c.txt'),'utf8'),'new-c');await f.undo(true);assert.equal(await fs.readFile(f.original('a.txt'),'utf8'),'human');assert.deepEqual(await fs.readFile(f.original('b.bin')),Buffer.from([0,255,4]));
  assert.equal((await applyWorkspace(f.copy,f.source)).conflicts[0].path,'a.txt');
}finally{await f.cleanup();}});
test('failed copy undo rolls original files and apply baseline back together',async()=>{const f=await fixture();try{
  await applyWorkspace(f.copy,f.source,undefined,'r');const baseline=await fs.readFile(path.join(f.copy,'.airoom/baseline.json'));
  await assert.rejects(f.undo(false,async()=>{throw new Error('copy failure');}),/copy failure/);assert.equal(await fs.readFile(f.original('a.txt'),'utf8'),'after-a');assert.equal(await fs.readFile(f.original('c.txt'),'utf8'),'new-c');assert.deepEqual(await fs.readFile(path.join(f.copy,'.airoom/baseline.json')),baseline);assert.equal((await projectUndoInfo(f.copy,'r',f.source))?.status,'applied');
  await f.undo();assert.equal(await fs.readFile(f.original('a.txt'),'utf8'),'before-a');
}finally{await f.cleanup();}});
test('repeated writebacks in one round preserve the first original contents',async()=>{const f=await fixture();try{
  await applyWorkspace(f.copy,f.source,undefined,'r');await fs.writeFile(f.file('a.txt'),'after-again');await applyWorkspace(f.copy,f.source,undefined,'r');
  // A copy edited after its checkpoint is correctly refused; the original must stay untouched too.
  await assert.rejects(f.undo(),/副本状态/);assert.equal(await fs.readFile(f.original('a.txt'),'utf8'),'after-again');
}finally{await f.cleanup();}});
