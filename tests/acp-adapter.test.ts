import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Engine } from './helpers/seeded-engine';
import { acpDenial, resolveAcpProgram } from '../src/backend/adapters/acp';
import { ACP_DEFAULT_PERMISSIONS, PROVIDER_NAMES, SECRET_PLACEHOLDER, normalizeExecutor, parseEnv, splitArgs, splitSecretEnv } from '../src/shared/defaults';
import type { AcpExecutor, Approval, MemberProfile, Project, ProviderInfo, Run, Session, TimelineEvent } from '../src/shared/types';

const agent = path.resolve('tests', 'fixtures', 'fake-acp-agent.mjs');
const done = new Set(['stopped', 'ended', 'completed', 'failed', 'unknown', 'interrupted', 'rate_limited']);
async function waitFor<T>(read: () => T | undefined | false, label: string, timeout = 20000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) { const value = read(); if (value) return value as T; if (Date.now() > deadline) assert.fail(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test('program paths resolve to something AIROOM can start without a shell', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'airoom-acp-path-'));
  try {
    const script = path.join(directory, 'node_modules', '@vendor', 'agent', 'cli.js');
    await fs.mkdir(path.dirname(script), { recursive: true }); await fs.writeFile(script, '');
    const shim = path.join(directory, 'agent.cmd');
    await fs.writeFile(shim, '@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@vendor\\agent\\cli.js" %*\r\n');
    assert.deepEqual(resolveAcpProgram(shim, {}), { file: script, script: true }, 'an npm shim runs the script it names');
    assert.deepEqual(resolveAcpProgram('agent', { PATH: directory }), { file: script, script: true }, 'a bare name is found on PATH');
    await fs.writeFile(path.join(directory, 'other.cmd'), 'echo hi');
    assert.throws(() => resolveAcpProgram(path.join(directory, 'other.cmd'), {}), /不是 npm 生成的启动文件/);
    await fs.writeFile(path.join(directory, 'run.ps1'), '');
    assert.throws(() => resolveAcpProgram(path.join(directory, 'run.ps1'), {}), /不支持/);
    assert.throws(() => resolveAcpProgram('missing-agent', { PATH: directory }), /找不到/);
    assert.throws(() => resolveAcpProgram('sub\\agent', {}), /完整路径/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('connection settings are bounded and permission requests follow the session', () => {
  assert.deepEqual(splitArgs('--acp  --model "gemini 2.5" -v'), ['--acp', '--model', 'gemini 2.5', '-v']);
  assert.deepEqual(parseEnv('# comment\nGEMINI_HOME = C:\\g\n\nX=1'), { GEMINI_HOME: 'C:\\g', X: '1' });
  assert.throws(() => parseEnv('NOVALUE'), /名称=值/);
  assert.deepEqual(splitSecretEnv({ GEMINI_API_KEY: 'k1', ACCESS_TOKEN: SECRET_PLACEHOLDER, OLD_SECRET: SECRET_PLACEHOLDER, HOME_DIR: 'C:\g' }, { ACCESS_TOKEN: 'kept', GONE_PASSWORD: 'removed' }),
    { plain: { HOME_DIR: 'C:\g' }, secrets: { GEMINI_API_KEY: 'k1', ACCESS_TOKEN: 'kept' } }, 'a placeholder keeps the stored value; an unknown placeholder or a removed line drops it');
  const executor = normalizeExecutor({ name: ' 小G ', command: ' gemini ', args: '--experimental-acp', env: 'A=1', permissions: { commands: 'auto', fileScope: 'bad' } }, undefined, 'acp-0123456789ab');
  assert.deepEqual({ ...executor, createdAt: '' }, { id: 'acp-0123456789ab', name: '小G', command: 'gemini', args: ['--experimental-acp'], env: { A: '1' }, permissions: { commands: 'auto', fileScope: 'workspace', network: true }, model: undefined, createdAt: '' });
  assert.throws(() => normalizeExecutor({ name: 'x', command: 'x', env: { PATH: 'C:\\evil' } }), /不能在这里修改 PATH/);
  assert.throws(() => normalizeExecutor({ name: 'x', command: '' }), /程序路径/);
  assert.equal(acpDenial('edit', ACP_DEFAULT_PERMISSIONS, false), '这个会话是只读的，不允许修改文件或执行命令');
  assert.equal(acpDenial(undefined, ACP_DEFAULT_PERMISSIONS, false), '这个会话是只读的，不允许修改文件或执行命令', 'unknown tools count as writes');
  assert.equal(acpDenial('read', ACP_DEFAULT_PERMISSIONS, false), undefined);
  assert.match(acpDenial('execute', { ...ACP_DEFAULT_PERMISSIONS, commands: 'deny' }, true)!, /禁止/);
  assert.match(acpDenial('fetch', { ...ACP_DEFAULT_PERMISSIONS, network: false }, true)!, /联网/);
  assert.equal(acpDenial('edit', ACP_DEFAULT_PERMISSIONS, true), undefined);
});

test('an ACP chat resumes with the selected program after its old installation directory is deleted',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM acp version-')),data=path.join(directory,'data'),state=path.join(directory,'agent-state');
  const old=path.join(data,'members','opencode','1.0.0','agent.mjs'),next=path.join(data,'members','opencode','1.0.1','agent.mjs');
  await fs.mkdir(path.dirname(old),{recursive:true});await fs.mkdir(path.dirname(next),{recursive:true});await fs.mkdir(state);await fs.writeFile(path.join(state,'signed-in'),'fixture');
  const source=await fs.readFile(agent,'utf8');await fs.writeFile(old,source);await fs.writeFile(next,source.replace('我是 Fake。','我是新版。'));
  const engine=new Engine(data,()=>{},()=>{});
  try{
    const executor=await engine.invoke('executor.save',{executor:{name:'版本切换 ACP',command:old,env:{FAKE_ACP_STATE:state}}}) as AcpExecutor;
    await waitFor(()=>engine.snapshot().providers.find(item=>item.id===executor.id)?.available,'old program connected');
    const project=await engine.invoke('project.create',{directory:await fs.mkdtemp(path.join(directory,'project-'))}) as Project;
    const session=engine.createSession(project.id,executor.id,undefined,false);
    const run=async()=>{const {runId}=await engine.invoke('session.send',{sessionId:session.id,text:'你好'}) as {runId:string};return waitFor(()=>{const item=engine.store.get<Run>('runs',runId);return item?.completedAt&&engine.store.get<{completedAt?:string}>('compatibility_reports',item.compatibilityReportId!)?.completedAt?item:undefined;},'ACP turn completed');};
    assert.equal((await run()).status,'ended');const nativeId=engine.store.get<Session>('sessions',session.id)!.nativeId;assert.ok(nativeId);
    await engine.invoke('executor.save',{executor:{...executor,command:next}});
    await waitFor(()=>engine.snapshot().providers.find(item=>item.id===executor.id)?.available&&!engine.snapshot().providers.find(item=>item.id===executor.id)?.stale,'new program connected');
    await engine.invoke('catalog.remove',{id:'opencode',version:'1.0.0'});await assert.rejects(fs.lstat(path.dirname(old)),/ENOENT/);
    const continued=await run();assert.equal(continued.status,'ended');assert.equal(continued.executorIdentity?.path,next);
    assert.equal(engine.store.get<Session>('sessions',session.id)!.nativeId,nativeId);
    const log=(await fs.readFile(path.join(state,'log.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(log.some(entry=>entry.method==='session/load'&&entry.params.sessionId===nativeId));
    assert.equal(engine.store.listEvents(session.id).filter(event=>event.runId===continued.id&&event.kind==='delta').map(event=>event.text).join(''),'你好，我是新版。');
  }finally{await engine.close();await fs.rm(directory,{recursive:true,force:true});}
});

test('a connected ACP program signs in, works as a member with its card, resumes, asks permission and stops', { timeout: 120000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'AIROOM acp 中文-'));
  const state = path.join(directory, 'agent-state');
  const previous = { home: process.env.AIROOM_ACP_HOME, node: process.env.AIROOM_NODE_EXE };
  process.env.AIROOM_ACP_HOME = path.join(directory, 'acp-home'); process.env.AIROOM_NODE_EXE = process.execPath;
  const engine = new Engine(path.join(directory, 'data'), () => {}, () => {});
  const log = () => readFileSync(path.join(state, 'log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const provider = (id: string) => engine.snapshot().providers.find(item => item.id === id);
  try {
    await engine.invoke('settings.save', { settings: { defaultAutoApprove: false } });
    const token = 'tok-xyz-9f8e7d6c5b';
    const executor = await engine.invoke('executor.save', { executor: { name: '小F', command: agent, env: { FAKE_ACP_STATE: state } }, secrets: { ACP_TEST_TOKEN: token } }) as AcpExecutor;
    assert.deepEqual(executor.secretKeys, ['ACP_TEST_TOKEN']); assert.equal(executor.env.ACP_TEST_TOKEN, undefined);
    assert.match(executor.id, /^acp-[a-z0-9]{12}$/);
    assert.equal(PROVIDER_NAMES[executor.id], '小F', 'the program is named like a built-in executor');
    const first = await waitFor(() => provider(executor.id)?.checkedAt && !provider(executor.id)?.stale && provider(executor.id), 'first probe') as ProviderInfo;
    assert.equal(first.available, false); assert.equal(first.auth, 'none'); assert.match(first.detail, /需要先登录（可用方式：浏览器登录）/);
    const signIn = await engine.invoke('executor.authenticate', { id: executor.id }) as { detail: string };
    assert.match(signIn.detail, /已完成登录（浏览器登录）/);
    const ready = await waitFor(() => provider(executor.id)?.available && provider(executor.id), 'probe after login') as ProviderInfo;
    assert.equal(ready.version, '1.2.3'); assert.equal(ready.capabilities.history, true);
    assert.equal(log().find(entry => entry.method === 'initialize').token, token, 'the program receives its secret');
    assert.ok(!JSON.stringify(engine.snapshot()).includes(token), 'secrets never appear in a snapshot');
    for (const file of ['airoom.sqlite', 'airoom.sqlite-wal']) { const target = path.join(directory, 'data', file); assert.ok(!existsSync(target) || !readFileSync(target).includes(Buffer.from(token)), `secrets never reach the database (${file})`); }
    // Saving the form unchanged sends the placeholder; the secret stays.
    await engine.invoke('executor.save', { executor: { ...executor, env: { FAKE_ACP_STATE: state, ACP_TEST_TOKEN: SECRET_PLACEHOLDER } } });
    await waitFor(() => log().filter(entry => entry.method === 'initialize').length >= 4 && log().filter(entry => entry.method === 'initialize').at(-1), 'probe after an unchanged save');
    assert.equal(log().filter(entry => entry.method === 'initialize').at(-1).token, token);
    const diagnostics = await engine.invoke('diagnostics.export') as { path: string };
    assert.ok(!readFileSync(diagnostics.path, 'utf8').includes(token), 'diagnostics redact the secret');
    assert.deepEqual(ready.modelOptions!.map(option => [option.id, option.isDefault]), [['fast', true], ['deep', false]]);

    const member = await engine.invoke('team.save', { member: { executor: executor.id, name: '小F', persona: '说话带个喵', model: 'deep' } }) as MemberProfile;
    const project = await engine.invoke('project.create', { directory: await fs.mkdtemp(path.join(directory, 'project-')) }) as Project;
    const session = engine.createSession(project.id, executor.id, undefined, true, member.id);
    const send = async (text: string) => {
      const { runId } = await engine.invoke('session.send', { sessionId: session.id, text }) as { runId: string };
      return { runId, finished: () => waitFor(() => done.has(engine.store.get<Run>('runs', runId)!.status) && engine.store.get<Run>('runs', runId)!, `run ${text}`) };
    };
    const deltas = (runId: string) => engine.store.listEvents(session.id).filter((event: TimelineEvent) => event.runId === runId && event.kind === 'delta').map(event => event.text).join('');

    const hello = await send('你好');
    assert.equal((await hello.finished()).status, 'ended');
    assert.equal(deltas(hello.runId), '你好，我是 Fake。');
    assert.ok(engine.store.listEvents(session.id).some(event => event.runId === hello.runId && event.kind === 'plan' && event.text.includes('✓ 打个招呼')));
    const firstPrompt = log().find(entry => entry.method === 'session/prompt').params.prompt[0].text as string;
    assert.match(firstPrompt, /^\[AIROOM\]\nYou are a member of AIROOM/); assert.match(firstPrompt, /说话带个喵/);
    assert.ok(log().some(entry => entry.method === 'session/set_model' && entry.params.modelId === 'deep'), 'the member card model is applied');
    assert.equal(engine.store.get<Session>('sessions', session.id)!.nativeId, 's-1');
    assert.equal(engine.store.get<Session>('sessions', session.id)!.nativeContext?.turnsSinceRefresh, 1, 'work tasks acknowledge the same bounded native context as room speech');

    const again = await send('还记得吗');
    assert.equal((await again.finished()).status, 'ended');
    assert.ok(log().some(entry => entry.method === 'session/load' && entry.params.sessionId === 's-1'), 'the next turn loads the native session');
    assert.equal(deltas(again.runId), '你好，我是 Fake。', 'replayed history is not shown again');
    const resumedPrompt = log().filter(entry => entry.method === 'session/prompt').at(-1).params.prompt[0].text as string;
    assert.ok(!resumedPrompt.startsWith('[AIROOM]\n') &&!resumedPrompt.includes('说话带个喵') && resumedPrompt.endsWith('还记得吗'), 'a resumed session does not repeat the card');
    assert.equal(engine.store.get<Session>('sessions', session.id)!.nativeContext?.turnsSinceRefresh, 2);

    const asking = await send('NEED_PERMISSION');
    const approval = await waitFor(() => engine.snapshot().approvals.find((item: Approval) => item.runId === asking.runId && item.state === 'pending'), 'permission request');
    assert.match(approval.title, /小F 请求：写入 a\.txt/); assert.match(approval.detail, /类型：edit/);
    await engine.invoke('approval.answer', { id: approval.id, choice: approval.allowChoice });
    await asking.finished();
    assert.equal(deltas(asking.runId), 'permission: yes');

    // A read-only session refuses writes before asking the user.
    const readOnly = engine.createSession(project.id, executor.id, '只读', false, member.id);
    const { runId: refusedRun } = await engine.invoke('session.send', { sessionId: readOnly.id, text: 'NEED_PERMISSION' }) as { runId: string };
    await waitFor(() => done.has(engine.store.get<Run>('runs', refusedRun)!.status), 'read-only run');
    assert.equal(engine.store.listEvents(readOnly.id).filter(event => event.runId === refusedRun && event.kind === 'delta').map(event => event.text).join(''), 'permission: no');
    assert.ok(engine.store.listEvents(readOnly.id).some(event => event.runId === refusedRun && event.kind === 'warning' && /只读/.test(event.text)));

    const slow = await send('SLOW');
    await waitFor(() => deltas(slow.runId) === '开始…', 'slow turn started');
    await engine.invoke('run.stop', { runId: slow.runId });
    assert.equal((await slow.finished()).status, 'stopped');
    assert.ok(log().some(entry => entry.method === 'session/cancel'), 'stop sends session/cancel');

    await assert.rejects(engine.invoke('executor.delete', { id: executor.id }), /还有成员在使用它：小F/);
    await engine.invoke('team.delete', { id: member.id,folderChoice:'keep' });
    assert.equal(engine.snapshot().executors!.length, 1, 'deleting a card preserves its program connection, even for the last member');
    assert.ok(provider(executor.id));
    await engine.invoke('executor.delete',{id:executor.id});
    assert.equal(engine.snapshot().executors!.length,0,'connections are removed only through their own explicit action');
  } finally {
    await engine.close();
    process.env.AIROOM_ACP_HOME = previous.home; process.env.AIROOM_NODE_EXE = previous.node;
    if (previous.home === undefined) delete process.env.AIROOM_ACP_HOME; if (previous.node === undefined) delete process.env.AIROOM_NODE_EXE;
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});

test('ACP room restores context when native history is unsupported or loading the old session fails',async()=>{
  for(const history of ['none','fail']){
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM acp-replay-')),state=path.join(directory,'agent-state');
    await fs.mkdir(state);await fs.writeFile(path.join(state,'signed-in'),'fixture');
    const previous={home:process.env.AIROOM_ACP_HOME,node:process.env.AIROOM_NODE_EXE};process.env.AIROOM_ACP_HOME=path.join(directory,'home');process.env.AIROOM_NODE_EXE=process.execPath;
    const engine=new Engine(path.join(directory,'data'),()=>{},()=>{},undefined,{roomRuntimeReuse:false});
    try{
      const executor=await engine.invoke('executor.save',{executor:{name:'历史测试程序',command:agent,env:{FAKE_ACP_STATE:state,FAKE_ACP_HISTORY:history,FAKE_ACP_ROOM:'1'}}}) as AcpExecutor;
      await waitFor(()=>engine.snapshot().providers.find(p=>p.id===executor.id)?.available,'fake room provider');
      engine.store.put('members','room-guest',{id:'room-guest',executor:executor.id,name:'历史测试成员'});
      await engine.invoke('room.send',{mode:'discuss',style:'chat',text:'必须保留原始约束',memberIds:['room-guest'],maxCalls:4,maxMinutes:0});await waitFor(()=>!engine.store.roomState().active,'room settles');
      assert.equal(engine.store.roomState().discussion!.phase,'budget');
      const log=readFileSync(path.join(state,'log.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
      const inputs=log.filter(e=>e.method==='session/prompt').map(e=>JSON.parse(e.params.prompt[0].text.split('\nAIROOM_CONTEXT\n').at(-1)));
      assert.equal(inputs.length,4);assert.deepEqual(inputs.map(c=>c.messages.length),[1,2,3,4]);assert.ok(inputs.every(c=>c.messages[0].text==='必须保留原始约束'));
      if(history==='fail')assert.ok(log.some(e=>e.method==='session/load'));
      assert.ok(engine.store.list<Run>('runs').every(run=>run.input.includes('必须保留原始约束')),'durable input reflects the replay actually sent');
    }finally{
      await engine.close();if(previous.home===undefined)delete process.env.AIROOM_ACP_HOME;else process.env.AIROOM_ACP_HOME=previous.home;if(previous.node===undefined)delete process.env.AIROOM_NODE_EXE;else process.env.AIROOM_NODE_EXE=previous.node;
      await fs.rm(directory,{recursive:true,force:true});
    }
  }
});
