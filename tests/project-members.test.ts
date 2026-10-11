import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Engine} from '../src/backend/engine';
import {Store} from '../src/backend/store';
import {createBackup} from '../src/backend/backup';
import {BackupRestorer} from '../src/backend/backup-restore';
import {projectMembers} from '../src/renderer/project-members';
import type {Project,PushEvent,Snapshot} from '../src/shared/types';

async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM project-members-')),data=path.join(root,'data'),source=path.join(root,'source');
  await mkdir(source);const events:PushEvent[]=[],engine=new Engine(data,event=>events.push(event),()=>{});
  const project=await engine.invoke('project.create',{directory:source,name:'会议项目'}) as Project;
  return {root,data,source,engine,project,events,dispose:async()=>{await engine.close();assert.ok(path.relative(os.tmpdir(),root).startsWith('AIROOM project-members-'));await rm(root,{recursive:true,force:true});}};
}

test('project.update persists a deduplicated participant list without renaming, broadcasts and survives restart',async()=>{
  const h=await fixture();let restarted:Engine|undefined;
  try{
    const updated=await h.engine.invoke('project.update',{projectId:h.project.id,memberIds:['claude','codex','claude']}) as Project;
    assert.deepEqual(updated.memberIds,['claude','codex']);assert.equal(updated.name,'会议项目');assert.equal(updated.directory,h.source);
    await new Promise<void>(resolve=>setImmediate(resolve));
    const push=h.events.filter(e=>e.type==='snapshot').at(-1)!;
    assert.equal(push.type,'snapshot');if(push.type==='snapshot')assert.deepEqual(push.snapshot.projects.find(p=>p.id===h.project.id)!.memberIds,['claude','codex']);
    await h.engine.close();restarted=new Engine(h.data,()=>{},()=>{});
    const snapshot=await restarted.invoke('snapshot',{}) as Snapshot;assert.deepEqual(snapshot.projects.find(p=>p.id===h.project.id)!.memberIds,['claude','codex']);
  }finally{await restarted?.close();await h.dispose();}
});

test('participant validation is atomic with rename, rejects nonexistent members and permits an explicit empty list',async()=>{
  const h=await fixture();try{
    await h.engine.invoke('project.update',{projectId:h.project.id,memberIds:['codex'],name:'已保存'});
    for(const memberIds of [null,'codex',[0],[''],['missing'],['codex','missing'],[{}]]){
      await assert.rejects(h.engine.invoke('project.update',{projectId:h.project.id,name:'不能写入',memberIds}),/成员|名单/);
      const saved=h.engine.store.get<Project>('projects',h.project.id)!;assert.equal(saved.name,'已保存');assert.deepEqual(saved.memberIds,['codex']);
    }
    await assert.rejects(h.engine.invoke('project.update',{projectId:h.project.id,name:'  ',memberIds:[]}),/名称不能为空/);
    assert.deepEqual(h.engine.store.get<Project>('projects',h.project.id)!.memberIds,['codex']);
    await h.engine.invoke('project.update',{projectId:h.project.id,memberIds:[]});
    assert.deepEqual(h.engine.store.get<Project>('projects',h.project.id)!.memberIds,[]);
    await h.engine.invoke('project.update',{projectId:h.project.id,name:'只改名称'});
    assert.deepEqual(h.engine.store.get<Project>('projects',h.project.id)!.memberIds,[]);
    await assert.rejects(h.engine.invoke('project.update',{projectId:'missing',memberIds:[]}),/不存在|找不到/);
  }finally{await h.dispose();}
});

test('real backup and restore retain project participants and their explicit empty state',async()=>{
  const h=await fixture();let restored:Store|undefined;try{
    await h.engine.invoke('project.update',{projectId:h.project.id,memberIds:['claude','codex']});
    const other=await h.engine.invoke('project.create',{directory:h.source,name:'空名单项目'}) as Project;
    await h.engine.invoke('project.update',{projectId:other.id,memberIds:[]});await h.engine.close();
    const backup=await createBackup(h.data,'manual'),changed=new Store(h.data);
    changed.put('projects',h.project.id,{...changed.get<Project>('projects',h.project.id)!,memberIds:[]});
    changed.put('projects',other.id,{...changed.get<Project>('projects',other.id)!,memberIds:['dsh']});changed.close();
    const restorer=new BackupRestorer(h.data),prepared=await restorer.prepare(backup.id),before=await createBackup(h.data,'before-restore');
    await restorer.apply(prepared.token,before.id);restored=new Store(h.data);
    assert.deepEqual(restored.get<Project>('projects',h.project.id)!.memberIds,['claude','codex']);
    assert.deepEqual(restored.get<Project>('projects',other.id)!.memberIds,[]);
  }finally{restored?.close();await h.dispose();}
});

test('removing a project removes its participant state from the database and snapshot without affecting another project',async()=>{
  const h=await fixture();try{
    const other=await h.engine.invoke('project.create',{directory:h.source,name:'另一个项目'}) as Project;
    await h.engine.invoke('project.update',{projectId:h.project.id,memberIds:['codex']});
    await h.engine.invoke('project.update',{projectId:other.id,memberIds:['claude']});
    await h.engine.invoke('project.remove',{projectId:h.project.id,discardWorkspaces:false});
    assert.equal(h.engine.store.get('projects',h.project.id),undefined);
    const snapshot=await h.engine.invoke('snapshot',{}) as Snapshot;assert.equal(snapshot.projects.some(p=>p.id===h.project.id),false);
    assert.deepEqual(snapshot.projects.find(p=>p.id===other.id)!.memberIds,['claude']);
  }finally{await h.dispose();}
});

test('an explicit backend empty participant list overrides stale local storage while legacy projects still read it',()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>JSON.stringify(['claude'])}});
  try{
    assert.deepEqual(projectMembers({id:'p',memberIds:[]}),[]);
    assert.deepEqual(projectMembers({id:'p',memberIds:['codex']}),['codex']);
    assert.deepEqual(projectMembers({id:'p'}),['claude']);
  }finally{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else Reflect.deleteProperty(globalThis,'localStorage');}
});

test('deleting a custom participant prunes project rosters without removing the other participants',async()=>{
  const h=await fixture();try{
    const original=h.engine.store.members().find(member=>member.id==='claude')!;
    h.engine.store.put('members','custom',{...original,id:'custom',name:'临时参会成员',builtIn:false});
    await h.engine.invoke('project.update',{projectId:h.project.id,memberIds:['custom','codex']});
    await h.engine.invoke('team.delete',{id:'custom',folderChoice:'keep'});
    assert.deepEqual(h.engine.store.get<Project>('projects',h.project.id)!.memberIds,['codex']);
    assert.equal(h.engine.store.members().some(member=>member.id==='custom'),false);
  }finally{await h.dispose();}
});
