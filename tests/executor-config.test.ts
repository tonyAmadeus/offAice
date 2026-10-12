import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from './helpers/seeded-engine';
import type { AcpExecutor, MemberProfile, Project, Run } from '../src/shared/types';
import { requestedConfig, effectiveConfigText } from '../src/shared/executor-config';
import { DEFAULT_SETTINGS, BUILTIN_MEMBERS } from '../src/shared/defaults';
import { createBackup } from '../src/backend/backup';
import { BackupRestorer } from '../src/backend/backup-restore';
import { Store } from '../src/backend/store';

const terminal = new Set(['ended', 'completed', 'failed', 'stopped', 'unknown', 'interrupted', 'rate_limited']);
async function wait<T>(read: () => T | undefined | false, label: string): Promise<T> {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 15)); }
  assert.fail('Timed out: ' + label);
}
async function fixture(env: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'AIROOM config-')), state = path.join(root, 'state');
  await mkdir(state); await writeFile(path.join(state, 'signed-in'), 'fixture');
  const previous = { home: process.env.AIROOM_ACP_HOME, node: process.env.AIROOM_NODE_EXE };
  process.env.AIROOM_ACP_HOME = path.join(root, 'home'); process.env.AIROOM_NODE_EXE = process.execPath;
  const engine = new Engine(path.join(root, 'data'), () => {}, () => {});
  await engine.invoke('settings.save', { settings: { defaultAutoApprove: false } });
  const executor = await engine.invoke('executor.save', { executor: { name: '配置测试', command: path.resolve('tests/fixtures/fake-acp-agent.mjs'), env: { FAKE_ACP_STATE: state, ...env } } }) as AcpExecutor;
  await wait(() => engine.snapshot().providers.find(item => item.id === executor.id)?.available, 'probe');
  const member = await engine.invoke('team.save', { member: { name: '配置成员', executor: executor.id } }) as MemberProfile;
  const source = path.join(root, 'source'); await mkdir(source);
  const project = await engine.invoke('project.create', { directory: source }) as Project;
  const session = engine.createSession(project.id, executor.id, undefined, true, member.id);
  const log = async () => (await readFile(path.join(state, 'log.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const send = async (text: string) => { const result = await engine.invoke('session.send', { sessionId: session.id, text }) as { runId: string }; return result.runId; };
  const finished = (id: string) => wait(() => { const run = engine.store.get<Run>('runs', id); return run && terminal.has(run.status) && run; }, 'run');
  return { engine, executor, member, project, session, log, send, finished, dispose: async () => { await engine.close(); if (previous.home === undefined) delete process.env.AIROOM_ACP_HOME; else process.env.AIROOM_ACP_HOME = previous.home; if (previous.node === undefined) delete process.env.AIROOM_NODE_EXE; else process.env.AIROOM_NODE_EXE = previous.node; await rm(root, { recursive: true, force: true }); } };
}

test('ACP uses native config IDs, and a model change refreshes grouped thinking choices before the prompt', async () => {
  const h = await fixture({ FAKE_ACP_CONFIG: '1' });
  try {
    await h.engine.invoke('session.update', { sessionId: h.session.id, model: 'deep', effort: 'high' });
    assert.equal((await h.finished(await h.send('配置完成'))).status, 'ended');
    const calls = await h.log(), setters = calls.filter(call => call.method === 'session/set_config_option');
    assert.deepEqual(setters.map(call => [call.params.configId, call.params.value]), [['vendor-model', 'deep'], ['vendor-thinking', 'high']]);
    assert.ok(!calls.some(call => call.method === 'session/set_model'));
    assert.ok(calls.findIndex(call => call.method === 'session/prompt') > calls.findIndex(call => call.params?.configId === 'vendor-thinking'));
  } finally { await h.dispose(); }
});

test('configuration resolves each field through project, card and executor, and explicit default does not fall through',()=>{
  const member={...BUILTIN_MEMBERS[0],model:'card',effort:'low'},settings={...DEFAULT_SETTINGS,models:{[member.executor]:'executor'},efforts:{[member.executor]:'high'}};
  const project={memberConfigs:{[member.id]:{model:'project'}},memberConfigRevision:4};
  assert.deepEqual({...requestedConfig(project,member,settings),capturedAt:''},{model:'project',effort:'low',modelSource:'project',effortSource:'member',capturedAt:'',projectConfigRevision:4});
  assert.equal(requestedConfig({memberConfigs:{[member.id]:{model:null,effort:null}}},member,settings).model,undefined);
  assert.equal(requestedConfig({}, {...member,model:undefined,effort:undefined},settings).model,'executor');
  const external={...member,executor:'acp-12345678' as const,model:undefined,effort:undefined};
  const legacy:AcpExecutor={id:external.executor,name:'Legacy',command:'agent',args:[],env:{},permissions:DEFAULT_SETTINGS.permissions.codex,createdAt:'',model:'legacy'};
  assert.equal(requestedConfig({},external,{...settings,models:{}},undefined,legacy).model,'legacy');
  assert.equal(requestedConfig({},external,{...settings,models:{[external.executor]:''}},undefined,legacy).model,undefined);
  assert.equal(effectiveConfigText(requestedConfig(project,member,settings),{source:'native',at:'',modelStatus:'accepted'}).includes('实际值未报告'),true);
});

test('project configuration validates atomically, stays project-local, and survives restart and backup restore',async()=>{
  const h=await fixture();try{
    const other=await h.engine.invoke('project.create',{directory:h.project.directory,name:'另一项目'}) as Project;
    const update={projectId:h.project.id,memberConfigs:{[h.member.id]:{model:'deep',effort:'high'}},expectedConfigRevision:0};
    const saved=await h.engine.invoke('project.update',update) as Project;
    assert.equal(saved.memberConfigRevision,1);
    assert.equal(h.engine.store.get<Project>('projects',other.id)?.memberConfigs,undefined);
    assert.equal(h.engine.store.members().find(m=>m.id===h.member.id)?.model,undefined);
    await assert.rejects(h.engine.invoke('project.update',{...update,name:'不可改名'}),/配置.*更新/);
    for(const memberConfigs of [{missing:{model:'deep'}},{[h.member.id]:{extra:'deep'}},{[h.member.id]:{model:42}}]){
      await assert.rejects(h.engine.invoke('project.update',{projectId:h.project.id,memberConfigs,name:'不可改名'}));assert.equal(h.engine.store.get<Project>('projects',h.project.id)?.name,h.project.name);
    }
    await h.engine.close();
    const data=h.engine.store.dataDirectory,backup=await createBackup(data,'manual'),store=new Store(data);
    assert.equal(store.get<Project>('projects',h.project.id)?.memberConfigs?.[h.member.id].effort,'high');
    store.put('projects',h.project.id,{...saved,memberConfigs:{}});store.close();
    const restorer=new BackupRestorer(data),prepared=await restorer.prepare(backup.id),before=await createBackup(data,'before-restore');
    await restorer.apply(prepared.token,before.id);const restored=new Store(data);
    try{assert.deepEqual(restored.get<Project>('projects',h.project.id)?.memberConfigs,saved.memberConfigs);}finally{restored.close();}
  }finally{await h.dispose();}
});

test('an active run freezes project choices, while the next run uses the changed choices and reports native values',async()=>{
  const h=await fixture({FAKE_ACP_CONFIG:'1'});try{
    await h.engine.invoke('project.update',{projectId:h.project.id,memberConfigs:{[h.member.id]:{model:'deep',effort:'high'}}});
    const id=await h.send('NEED_PERMISSION');
    const approval=await wait(()=>h.engine.snapshot().approvals.find(a=>a.runId===id&&a.state==='pending'),'permission');
    await h.engine.invoke('project.update',{projectId:h.project.id,memberConfigs:{[h.member.id]:{model:'fast',effort:'low'}}});
    await h.engine.invoke('approval.answer',{id:approval.id,choice:'yes'});
    const first=await h.finished(id);assert.equal(first.requestedConfig?.model,'deep');assert.equal(first.effectiveConfig?.effort,'high');
    const second=await h.finished(await h.send('使用下一次配置'));assert.equal(second.requestedConfig?.model,'fast');assert.equal(second.effectiveConfig?.model,'fast');assert.equal(second.effectiveConfig?.modelStatus,'reported');
    const log=await h.engine.invoke('projectFlow.log',{projectId:h.project.id,target:{kind:'session',id:h.session.id}}) as any;
    assert.ok(log.runs.some((r:any)=>r.configuration.includes('deep')&&r.configuration.includes('high')));
  }finally{await h.dispose();}
});

test('reading model-dependent options sends no work and does not change saved settings',async()=>{
  const h=await fixture({FAKE_ACP_CONFIG:'1'});try{
    const before=structuredClone(h.engine.settings);
    const result=await h.engine.invoke('provider.config',{provider:h.executor.id,model:'deep'}) as any;
    assert.equal(result.available,true);assert.ok(result.modelOptions.find((m:any)=>m.id==='deep').efforts.includes('high'));
    assert.deepEqual(h.engine.settings,before);assert.equal((await h.log()).filter(c=>c.method==='session/prompt').length,0);
  }finally{await h.dispose();}
});

test('ACP rejected explicit model and unsupported effort stop before sending any work prompt', async () => {
  for (const choice of [{ model: 'deep', effort: undefined }, { model: 'fast', effort: 'high' }]) {
    const h = await fixture({ FAKE_ACP_CONFIG: '1', FAKE_ACP_REJECT_MODEL: 'deep' });
    try {
      await h.engine.invoke('session.update', { sessionId: h.session.id, ...choice });
      const run = await h.finished(await h.send('不能偷偷换默认'));
      assert.equal(run.status, 'failed'); assert.match(run.error ?? '', /任务尚未发送/);
      assert.equal((await h.log()).filter(call => call.method === 'session/prompt').length, 0);
      assert.equal(run.delivery, 'prepared');
    } finally { await h.dispose(); }
  }
});

test('ACP permission labels, kinds and all native choices survive, including an AIROOM-prefixed native ID', async () => {
  for (const variant of ['all', 'always']) {
    const h = await fixture({ FAKE_ACP_PERMISSIONS: variant });
    try {
      const runId = await h.send('NEED_PERMISSION');
      const approval = await wait(() => h.engine.snapshot().approvals.find(item => item.runId === runId && item.state === 'pending'), 'permission');
      assert.ok(approval.options.some(option => option.id === 'always' && option.kind === 'allow_always' && option.label === '本程序：始终允许'));
      assert.equal(approval.options.length, variant === 'all' ? 5 : 2);
      const choice = variant === 'all' ? 'airoom:allow-all' : 'always';
      await h.engine.invoke('approval.answer', { id: approval.id, choice });
      await h.finished(runId);
      assert.equal(h.engine.store.get('sessions', h.session.id) && h.engine.store.get<any>('sessions', h.session.id).autoApprove, false);
      assert.equal(h.engine.store.listEvents(h.session.id).filter(event => event.runId === runId && event.kind === 'delta').map(event => event.text).join(''), 'permission: ' + choice);
    } finally { await h.dispose(); }
  }
});

test('failed native recovery keeps the old work session and sends neither a replacement session nor a task', async () => {
  const h = await fixture({ FAKE_ACP_HISTORY: 'fail' });
  try {
    assert.equal((await h.finished(await h.send('第一轮'))).status, 'ended');
    const old = h.engine.store.get<any>('sessions', h.session.id).nativeId, before = await h.log();
    const result = await h.finished(await h.send('继续原工作'));
    assert.equal(result.status, 'failed'); assert.match(result.error ?? '', /未能恢复原会话/);
    const after = await h.log();
    assert.equal(after.filter(call => call.method === 'session/new').length, before.filter(call => call.method === 'session/new').length);
    assert.equal(after.filter(call => call.method === 'session/prompt').length, before.filter(call => call.method === 'session/prompt').length);
    assert.equal(h.engine.store.get<any>('sessions', h.session.id).nativeId, old);
  } finally { await h.dispose(); }
});
