import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {Engine} from '../src/backend/engine';
import type {Adapter,MemberProfile,ProviderId} from '../src/shared/types';

test('built-in connections delete durably, preserve history and credentials, and restore explicitly',async()=>{
  const parent=path.resolve('.test-cache/builtin-connections');await mkdir(parent,{recursive:true});
  const data=await mkdtemp(path.join(parent,'run-')),probed:ProviderId[]=[];
  const factory=(id:ProviderId):Adapter=>({probe:async()=>{probed.push(id);return {id,name:id,available:true,auth:'subscription',runtimeReady:true,detail:'fixture',capabilities:{streaming:true,write:true,history:true,cancel:'native',steer:false}};},start:async()=>assert.fail('no model work'),stop:async()=>{}});
  let engine=new Engine(data,()=>{},()=>{},factory);
  try{
    const work=path.join(data,'work');await mkdir(work);
    const project=await engine.invoke('project.create',{name:'history',directory:work}) as {id:string};
    const session=engine.createSession(project.id,'codex');
    const member=await engine.invoke('team.save',{member:{name:'使用 Codex 的人物',executor:'codex'}}) as MemberProfile;
    await assert.rejects(engine.invoke('executor.delete',{id:'codex'}),/还有成员在使用/);
    await engine.invoke('team.delete',{id:member.id,folderChoice:'keep'});
    const credential=path.join(data,'credential-fixture.secret');await writeFile(credential,'retained');
    const paths={codex:process.execPath,claude:process.execPath,dsh:process.execPath};
    await engine.invoke('settings.save',{settings:{...engine.settings,paths}});
    for(const id of ['codex','claude','dsh'] as const){await engine.probe(id);await engine.invoke('executor.delete',{id});}
    assert.deepEqual(engine.snapshot().removedProviders.sort(),['claude','codex','dsh']);
    assert.deepEqual(engine.snapshot().providers,[]);
    assert.deepEqual(engine.settings.paths,{});
    assert.ok(engine.store.get('sessions',session.id));
    assert.equal(await readFile(credential,'utf8'),'retained');
    await assert.rejects(engine.send(session.id,'continue'),/连接已删除/);
    await assert.rejects(engine.invoke('internal.provider.loginBegin',{provider:'codex'}),/连接已删除/);
    await assert.rejects(engine.invoke('team.save',{member:{name:'deleted',executor:'codex'}}),/连接已删除/);
    await engine.close();engine=new Engine(data,()=>{},()=>{},factory);probed.length=0;
    await engine.probe();assert.deepEqual(probed,[]);
    assert.deepEqual(engine.snapshot().removedProviders.sort(),['claude','codex','dsh']);
    await engine.invoke('executor.restore',{id:'codex'});
    await engine.probe('codex');assert.deepEqual(probed,['codex']);
    assert.ok(!engine.snapshot().removedProviders.includes('codex'));
    assert.ok(engine.store.get('sessions',session.id));
    assert.equal(await readFile(credential,'utf8'),'retained');
    await assert.rejects(engine.invoke('executor.restore',{id:'deepseek'}),/不存在/);
    await engine.invoke('executor.delete',{id:'codex'});
    await engine.invoke('member.use',{provider:'codex',version:null});
    assert.ok(!engine.snapshot().removedProviders.includes('codex'),'selecting a checked installed version reconnects the program');
  }finally{await engine.close();assert.equal(path.dirname(data),parent);await rm(data,{recursive:true,force:true});}
});
