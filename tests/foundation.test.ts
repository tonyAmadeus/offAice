import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/backend/store';
import { redact, resolveSafePath, buildEnvironment, registerSecret } from '../src/backend/security';
import { prepareWorkspace, readArtifact, diffWorkspace } from '../src/backend/workspace';
import { spawnOwned, stopOwned, getOwnership } from '../src/backend/process-supervisor';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';
import type { Run, Approval, Project, Session, TimelineEvent, RoomMessage } from '../src/shared/types';

const exec=promisify(execFile);
async function temporary() { return fs.mkdtemp(path.join(os.tmpdir(),'AIROOM 中文 测试-')); }
async function removeTemp(directory:string) {
  const resolved=path.resolve(directory), temporaryRoot=path.resolve(os.tmpdir());
  assert.ok(path.relative(temporaryRoot,resolved).startsWith('AIROOM 中文 测试-'));
  await fs.rm(resolved,{recursive:true,force:true});
}

test('SQLite reopening marks uncertain delivery, expires approvals and does not replay',async()=>{
  const directory=await temporary();
  let store=new Store(directory);
  try {
    const now=new Date().toISOString();
    const base:Run={id:'delivered',sessionId:'s',projectId:'p',provider:'claude',revision:1,status:'running',input:'task',createdAt:now,updatedAt:now,bootId:'old',delivery:'sent'};
    store.put('runs',base.id,base);store.put('runs','unsent',{...base,id:'unsent',status:'queued',delivery:'prepared'});
    const approval:Approval={id:'a',runId:'delivered',sessionId:'s',provider:'claude',type:'approval',title:'approve',detail:'detail',options:[],state:'pending',createdAt:now};
    store.put('approvals','a',approval);
    const event:TimelineEvent={id:'e',runId:'delivered',sessionId:'s',provider:'claude',at:now,kind:'output',text:'Authorization: Bearer secretcredential',data:{api_key:'secretcredential'},fidelity:'native'};
    store.appendEvent(event);store.appendEvent(event);store.close();
    store=new Store(directory);store.recover('new');
    assert.equal(store.get<Run>('runs','delivered')?.status,'unknown');
    assert.equal(store.get<Run>('runs','delivered')?.delivery,'unknown');
    assert.equal(store.get<Run>('runs','unsent')?.delivery,'withdrawn');
    assert.equal(store.get<Approval>('approvals','a')?.state,'expired');
    assert.equal(store.listEvents().length,1);
    const log=await fs.readFile(path.join(directory,'logs',now.slice(0,10)+'.jsonl'),'utf8');
    assert.ok(!log.includes('secretcredential'));
    assert.equal(store.listEvents()[0].data && (store.listEvents()[0].data as Record<string,string>).api_key,'[credential redacted]');
    store.recover('new');assert.equal(store.listEvents().length,1);
  } finally { store.close();await removeTemp(directory); }
});

test('room recovery after SQLite reopen preserves a completed reply and settles an orphan without inventing success',async()=>{
  const directory=await temporary();let store=new Store(directory);
  try {
    const at=new Date().toISOString();
    const run:Run={id:'room-finished',sessionId:'s',projectId:'lounge',provider:'codex',revision:1,status:'ended',input:'room',createdAt:at,updatedAt:at,completedAt:at,bootId:'old',delivery:'confirmed'};
    store.put('runs',run.id,run);
    store.appendEvent({id:'received',runId:run.id,sessionId:run.sessionId,provider:run.provider,at,kind:'delta',text:'已完成的回复',fidelity:'native'});
    store.put('room_messages','finished',{id:'finished',author:'codex',text:'',at,status:'speaking',runId:run.id} satisfies RoomMessage);
    store.put('room_messages','orphan',{id:'orphan',author:'claude',text:'最后已显示的内容',at,status:'speaking'} satisfies RoomMessage);
    store.put('room','state',{active:true,mode:'chat',speaking:'claude'});
    store.close();store=new Store(directory);store.recover('new');
    const messages=store.roomMessages();
    assert.equal(messages[0].status,'done');assert.equal(messages[0].text,'已完成的回复');assert.equal(messages[0].error,undefined);
    assert.equal(messages[1].status,'failed');assert.equal(messages[1].text,'最后已显示的内容');assert.match(messages[1].error!,/未自动重发/);
    assert.equal(store.roomState().active,false);assert.equal(store.roomState().speaking,undefined);
    store.close();store=new Store(directory);assert.deepEqual(store.roomMessages(),messages,'the recovery itself persists across another cold start');
  } finally {store.close();await removeTemp(directory);}
});

test('paths reject traversal and escaping junctions; child environment does not alter host',async()=>{
  const directory=await temporary(), root=path.join(directory,'root'),outside=path.join(directory,'outside');
  await fs.mkdir(root);await fs.mkdir(outside);await fs.writeFile(path.join(outside,'private.txt'),'private');
  try {
    assert.throws(()=>resolveSafePath(root,'../outside/private.txt'));
    assert.throws(()=>resolveSafePath(root,'C:\\private.txt'));
    await fs.symlink(outside,path.join(root,'escape'),process.platform==='win32'?'junction':'dir');
    assert.throws(()=>resolveSafePath(root,'escape/private.txt'));
    const previousProxy=process.env.HTTPS_PROXY,previousApi=process.env.ANTHROPIC_API_KEY;
    process.env.HTTPS_PROXY='http://127.0.0.1:7897';process.env.ANTHROPIC_API_KEY='billing-danger';
    try {
      const tun=buildEnvironment(DEFAULT_SETTINGS);assert.equal(tun.HTTPS_PROXY,undefined);assert.equal(tun.ANTHROPIC_API_KEY,undefined);
      assert.equal(process.env.HTTPS_PROXY,'http://127.0.0.1:7897');
      const proxy=buildEnvironment({...DEFAULT_SETTINGS,networkMode:'proxy',proxyUrl:'http://127.0.0.1:7897'});
      assert.equal(proxy.HTTPS_PROXY,'http://127.0.0.1:7897/');assert.ok(proxy.NO_PROXY?.includes('127.0.0.1'));
      assert.throws(()=>buildEnvironment({...DEFAULT_SETTINGS,networkMode:'proxy',proxyUrl:'file:///secret'}));
    } finally { if(previousProxy===undefined)delete process.env.HTTPS_PROXY;else process.env.HTTPS_PROXY=previousProxy;if(previousApi===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=previousApi; }
    const safe=redact({access_token:'abcdefghijk',note:'Bearer abcdefghijk',url:'https://person:password@example.com'});
    assert.ok(!JSON.stringify(safe).includes('abcdefghijk'));assert.ok(!JSON.stringify(safe).includes('person:password'));
    const runtimeSecret='b87aa7c07a79b7d9e81ea1573e819080';registerSecret(runtimeSecret);
    assert.equal(redact(`工具错误：${runtimeSecret}`),'工具错误：[credential redacted]');
  } finally { await removeTemp(directory); }
});

test('Git worktree preserves user dirty files and deletions without changing source',async()=>{
  const directory=await temporary(),source=path.join(directory,'原始 项目'),data=path.join(directory,'data');
  await fs.mkdir(source);
  const git=async(args:string[])=>(await exec('git',args,{cwd:source,windowsHide:true})).stdout;
  try {
    await git(['init']);await git(['config','user.email','test@example.invalid']);await git(['config','user.name','AIROOM test']);
    await fs.writeFile(path.join(source,'existing.txt'),'base');await fs.writeFile(path.join(source,'deleted.txt'),'base');await fs.mkdir(path.join(source,'nested'));await fs.writeFile(path.join(source,'nested','file.txt'),'nested base');
    await git(['add','.']);await git(['commit','-m','fixture']);
    await fs.writeFile(path.join(source,'existing.txt'),'user dirty');await fs.unlink(path.join(source,'deleted.txt'));await fs.writeFile(path.join(source,'用户 文件.txt'),'untracked user');
    const before=await git(['status','--porcelain']);
    const now=new Date().toISOString(),project:Project={id:'p',name:'project',directory:source,createdAt:now,collaborationPaused:false};
    const session:Session={id:'s',projectId:'p',provider:'claude',title:'task',createdAt:now,updatedAt:now,revision:1,writeMode:true};
    const workspace=await prepareWorkspace(project,session,true,data);assert.equal(workspace.kind,'worktree');
    assert.equal((await readArtifact(workspace.directory,'existing.txt')).content,'user dirty');
    assert.equal((await readArtifact(workspace.directory,'用户 文件.txt')).content,'untracked user');
    await assert.rejects(fs.stat(path.join(workspace.directory,'deleted.txt')));
    assert.match((await diffWorkspace(workspace.directory)).text,/尚无文件改动/);
    await fs.writeFile(path.join(workspace.directory,'existing.txt'),'AI modification');
    assert.match((await diffWorkspace(workspace.directory)).text,/修改 existing.txt/);
    assert.equal(await fs.readFile(path.join(source,'existing.txt'),'utf8'),'user dirty');assert.equal(await git(['status','--porcelain']),before);
    await git(['worktree','remove','--force',workspace.directory]);
  } finally { await removeTemp(directory); }
});

test('non-Git and unborn Git copies separate source changes and exclude dependencies',async()=>{
  const directory=await temporary(),source=path.join(directory,'project');await fs.mkdir(source);await fs.mkdir(path.join(source,'node_modules'));await fs.writeFile(path.join(source,'node_modules','hidden.txt'),'skip');await fs.writeFile(path.join(source,'file.txt'),'base');
  try {
    const now=new Date().toISOString(),project:Project={id:'p',name:'p',directory:source,createdAt:now,collaborationPaused:false},session:Session={id:'s',projectId:'p',provider:'codex',title:'s',createdAt:now,updatedAt:now,revision:1,writeMode:true};
    const workspace=await prepareWorkspace(project,session,true,path.join(directory,'data'));assert.equal(workspace.kind,'copy');
    await assert.rejects(fs.stat(path.join(workspace.directory,'node_modules')));
    await fs.writeFile(path.join(workspace.directory,'file.txt'),'change');assert.equal(await fs.readFile(path.join(source,'file.txt'),'utf8'),'base');
    await exec('git',['init'],{cwd:source,windowsHide:true});
    const unborn=await prepareWorkspace(project,{...session,id:'new-empty-repository'},true,path.join(directory,'data'));assert.equal(unborn.kind,'copy');
    assert.equal((await readArtifact(unborn.directory,'file.txt')).content,'base');
  } finally { await removeTemp(directory); }
});

async function outputLine(child:ChildProcess,timeout=20000):Promise<string> {
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='';const timer=setTimeout(()=>{cleanup();reject(new Error(`Timed out: ${stderr}`));},timeout);
    const data=(chunk:Buffer)=>{stdout+=chunk.toString('utf8');if(stdout.includes('\n')){cleanup();resolve(stdout.split('\n')[0]);}};
    const errorData=(chunk:Buffer)=>{stderr+=chunk.toString('utf8');};
    const exited=(code:number|null)=>{cleanup();reject(new Error(`Exited ${code}: ${stderr}`));};
    function cleanup() {clearTimeout(timer);child.stdout?.off('data',data);child.stderr?.off('data',errorData);child.off('exit',exited);}
    child.stdout?.on('data',data);child.stderr?.on('data',errorData);child.once('exit',exited);
  });
}
async function assertDead(pid:number) {
  for(let attempt=0;attempt<30;attempt++) {
    try { process.kill(pid,0); } catch(error) { if((error as NodeJS.ErrnoException).code==='ESRCH')return;throw error; }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.fail(`Owned process ${pid} remained alive`);
}

test('owned Windows process preserves Unicode stdio and kills grandchildren', {timeout:30000},async()=>{
  const script=`const {spawn}=require('node:child_process');const grand=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdin.once('data',data=>console.log(JSON.stringify({pid:process.pid,grand:grand.pid,arg:process.argv[1],input:data.toString('utf8')})));setInterval(()=>{},1000);`;
  const argument='中文 空格 "quote" \\';
  const child=spawnOwned(process.execPath,['-e',script,argument],{cwd:process.cwd(),env:{...process.env}});
  try {
    const line=outputLine(child);child.stdin?.write('输入消息');
    const received=JSON.parse(await line) as {pid:number;grand:number;arg:string;input:string};
    assert.equal(received.arg,argument);assert.equal(received.input,'输入消息');assert.ok(getOwnership(child)?.pid);
    await stopOwned(child,10000);await assertDead(received.pid);await assertDead(received.grand);
  } finally { await stopOwned(child); }
});

test('unexpected supervisor parent exit cleans the complete Job tree',{timeout:30000},async()=>{
  const supervisor=fileURLToPath(new URL('../src/backend/process-supervisor.ts',import.meta.url));
  const fixture=`import {spawnOwned} from ${JSON.stringify(new URL('file:///'+supervisor.replaceAll('\\','/')).href)};const program="const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(JSON.stringify({pid:process.pid,grand:child.pid}));setInterval(()=>{},1000);";const child=spawnOwned(process.execPath,['-e',program],{cwd:process.cwd(),env:{...process.env}});child.stdout.once('data',data=>{process.stdout.write(data);setTimeout(()=>process.exit(0),100);});child.stderr.pipe(process.stderr);`;
  const parent=spawn(process.execPath,['--import','tsx','--input-type=module','-e',fixture],{cwd:process.cwd(),env:{...process.env},stdio:['ignore','pipe','pipe'],windowsHide:true});
  try {
    const received=JSON.parse(await outputLine(parent)) as {pid:number;grand:number};
    await new Promise<void>((resolve,reject)=>{if(parent.exitCode!==null)return resolve();parent.once('exit',code=>code===0?resolve():reject(new Error(`Parent fixture exited ${code}`)));});
    await assertDead(received.pid);await assertDead(received.grand);
  } finally { if(parent.exitCode===null)parent.kill(); }
});

test('redact keeps objects shared between siblings and only marks real cycles', async () => {
  const { redact } = await import('../src/backend/security');
  const shared = ['low', 'high'];
  assert.deepEqual(redact({ a: { efforts: shared }, b: { efforts: shared } }), { a: { efforts: ['low', 'high'] }, b: { efforts: ['low', 'high'] } });
  const cyclic: Record<string, unknown> = { name: 'x' }; cyclic.self = cyclic;
  assert.deepEqual(redact(cyclic), { name: 'x', self: '[circular]' });
});
