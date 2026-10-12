import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from './helpers/seeded-engine';
import { memberPermissions, normalizeMemberPermissions } from '../src/shared/permissions';
import { DEFAULT_SETTINGS, normalizePermissions, automaticWorkSettings } from '../src/shared/defaults';
import { connectionLabel } from '../src/shared/executor-connection';
import type { AcpExecutor, Adapter, AdapterContext, MemberProfile, Project, ProviderId, Run } from '../src/shared/types';

async function until(check: () => boolean) { const end = Date.now() + 10000; while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('run did not finish'); }

test('each person inherits missing permission fields and external defaults survive normalization and automatic preset', () => {
  const id = 'acp-12345678', defaults = {commands:'ask' as const,fileScope:'workspace' as const,network:true};
  const settings = {...DEFAULT_SETTINGS, permissions:normalizePermissions({...DEFAULT_SETTINGS.permissions,[id]:defaults}), memberPermissions:{one:{commands:'deny' as const}}};
  assert.deepEqual(memberPermissions(settings,{id:'one',executor:id}),{...defaults,commands:'deny'});
  assert.deepEqual(memberPermissions(settings,{id:'two',executor:id}),defaults);
  assert.deepEqual(automaticWorkSettings(settings).permissions[id],defaults);
  assert.throws(()=>normalizeMemberPermissions({one:{network:'yes'}}),/无效/);
  assert.throws(()=>normalizeMemberPermissions({one:{extra:true}}),/无效/);
  assert.throws(()=>normalizeMemberPermissions({missing:{network:false}},new Set(['one'])),/不存在/);
});

test('built-in and external personas apply independent permissions to real engine runs, persist, and remove only deleted overrides',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM person-permissions-')),data=path.join(root,'data'),contexts:AdapterContext[]=[];
  const factory=(id:ProviderId):Adapter=>({probe:async()=>({id,name:id,available:true,auth:id==='dsh'||id.startsWith('acp-')?'account':'subscription',detail:'fixture',runtimeReady:true,capabilities:{streaming:true,write:true,history:true,cancel:'native',steer:false}}),start:async ctx=>{contexts.push(ctx);ctx.markDelivery('confirmed');ctx.emit('delta','done');return {};},stop:async()=>{}});
  let engine=new Engine(data,()=>{},()=>{},factory);
  try{
    await engine.probe();
    const executor=await engine.invoke('executor.save',{executor:{name:'外接程序',command:process.execPath,permissions:{commands:'ask',fileScope:'workspace',network:true}}}) as AcpExecutor;
    const first=await engine.invoke('team.save',{member:{executor:executor.id,name:'独立限制'}}) as MemberProfile;
    const second=await engine.invoke('team.save',{member:{executor:executor.id,name:'继承默认'}}) as MemberProfile;
    await engine.invoke('settings.save',{settings:{memberPermissions:{[first.id]:{commands:'deny',network:false},claude:{fileScope:'workspace'}},permissions:{...engine.settings.permissions,[executor.id]:{commands:'auto',fileScope:'any',network:true}}}});
    await engine.invoke('executor.save',{executor:{id:executor.id,name:'已改名的外接程序',command:executor.command}});
    assert.deepEqual(engine.settings.permissions[executor.id],{commands:'auto',fileScope:'any',network:true},'editing a connection preserves its saved default permissions');
    const before=structuredClone(engine.settings);
    await assert.rejects(engine.invoke('settings.save',{settings:{memberPermissions:{[first.id]:{network:'yes'}}}}),/无效/);
    assert.deepEqual(engine.settings,before);
    const project=await engine.invoke('project.create',{name:'权限隔离',directory:root}) as Project;
    for(const member of [first,second,engine.store.members().find(item=>item.id==='claude')!]){
      const session=engine.createSession(project.id,member.executor,undefined,true,member.id);
      const sent=await engine.invoke('session.send',{sessionId:session.id,text:'核对权限'}) as {runId:string};
      await until(()=>['ended','failed'].includes(engine.store.get<Run>('runs',sent.runId)?.status??''));
      assert.equal(engine.store.get<Run>('runs',sent.runId)?.status,'ended');
    }
    assert.deepEqual(contexts[0].settings.permissions[executor.id],{commands:'deny',fileScope:'any',network:false});
    assert.deepEqual(contexts[1].settings.permissions[executor.id],{commands:'auto',fileScope:'any',network:true});
    assert.equal(contexts[2].settings.permissions.claude.fileScope,'workspace');
    await engine.close();engine=new Engine(data,()=>{},()=>{},factory);
    assert.deepEqual(engine.settings.memberPermissions?.[first.id],{commands:'deny',network:false});
    const history=engine.store.list('sessions').length;
    await engine.invoke('team.delete',{id:first.id});
    assert.equal(engine.settings.memberPermissions?.[first.id],undefined);
    assert.deepEqual(engine.settings.memberPermissions?.claude,{fileScope:'workspace'});
    assert.equal(engine.store.list('sessions').length,history);
  }finally{await engine.close();await rm(root,{recursive:true,force:true,maxRetries:5});}
});

test('connection labels separate adapter, installation source and actual protocol',()=>{
  assert.match(connectionLabel('codex'),/内置适配.*App Server/);
  assert.match(connectionLabel('claude'),/内置适配.*JSON/);
  assert.match(connectionLabel('dsh'),/ACP.*DSH/);
  assert.match(connectionLabel('acp-12345678',{catalogId:'zcode'}),/外接适配.*原生 CLI JSON.*清单/);
  assert.doesNotMatch(connectionLabel('acp-12345678',{catalogId:'zcode'}),/ACP/);
  assert.match(connectionLabel('acp-12345678'),/ACP.*手动/);
});
