import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {AcpAdapter} from '../src/backend/adapters/acp';
import {Engine} from '../src/backend/engine';
import {catalogCandidate,catalogAuthentication,managedCatalogEnvironment} from '../src/backend/executor-catalog';
import {EXECUTOR_CATALOG,catalogEntry,type CatalogLoginState} from '../src/shared/executor-catalog';
import {officialExecutorLoginOutput,officialExecutorLoginUrl} from '../src/backend/official-login';
import {qoderRelease,completeQoderEntry} from '../src/backend/qoder-install';
import {DEFAULT_SETTINGS} from '../src/shared/defaults';
import type {Session} from '../src/shared/types';
import {cursorPackage} from './fixtures/cursor-package';
const root=path.resolve('.test-cache/catalog-login-tests'),agent=path.resolve('tests/fixtures/fake-catalog-login.mjs');
async function fixture(){await mkdir(root,{recursive:true});return mkdtemp(path.join(root,'run-'));}
async function clean(dir:string){assert.equal(path.dirname(dir),root);await rm(dir,{recursive:true,force:true});}

test('Gemini and Qwen disappear from downloads while legacy configuration remains readable',async()=>{
  assert.deepEqual(EXECUTOR_CATALOG.map(entry=>entry.id).sort(),['claude','codex','cursor','dsh','kimi','opencode','qoder','qodercn','zcode']);
  const dir=await fixture(),engine=new Engine(dir,()=>{},()=>{});
  try{for(const id of ['gemini','qwen']as const){assert.equal(catalogEntry(id).downloadable,false);const executor=catalogCandidate(id,agent);engine.store.put('executors',executor.id,executor);await assert.rejects(engine.invoke('catalog.install',{id,version:'1.0.0',agree:true}),/下载清单移除/);assert.deepEqual(engine.store.get('executors',executor.id),executor);}assert.equal(engine.store.list('runs').length,0);}
  finally{await engine.close();await clean(dir);}
});
test('Kimi, Qoder and Cursor run native login before ACP authentication in the same isolated home',async()=>{
  const dir=await fixture();try{for(const id of ['kimi','qoder','qodercn','cursor']as const){const calls=path.join(dir,id+'.jsonl'),command=id==='cursor'?(await cursorPackage(path.join(dir,'cursor-package'),'2026.10.01-e373342',{script:await readFile(agent,'utf8'),host:true})).entry:agent,executor=catalogCandidate(id,command),adapter=new AcpAdapter(executor),states:CatalogLoginState[]=[];
    const env={...process.env,AIROOM_ACP_HOME:path.join(dir,'homes'),FIXTURE_CALLS:calls,OPENAI_API_KEY:'must-not-inherit',GEMINI_API_KEY:'must-not-inherit',QODER_PERSONAL_ACCESS_TOKEN:'must-not-inherit',QODERCN_PERSONAL_ACCESS_TOKEN:'must-not-inherit',CURSOR_API_KEY:'must-not-inherit',CURSOR_AUTH_TOKEN:'must-not-inherit'};
    assert.equal((await adapter.probe(DEFAULT_SETTINGS,env)).auth,'none');
    await adapter.authenticate(env,executor.authentication,state=>states.push(state));assert.ok(states.some(state=>state.phase==='waiting'&&state.url));assert.equal((await adapter.probe(DEFAULT_SETTINGS,env)).available,true);
    const packets=(await readFile(calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.ok(packets.some(p=>p.args.join(' ')===(id==='kimi'?'acp --login':id==='cursor'?'--disable-auto-update login':'login')));assert.equal(new Set(packets.map(p=>p.home)).size,1);assert.ok(packets.every(p=>!p.leaked));
  }}finally{await clean(dir);}
});
test('pending official login can be cancelled and blocks replacing credentials',async()=>{
  const dir=await fixture(),engine=new Engine(dir,()=>{},()=>{}),old=process.env.AIROOM_ACP_HOME;process.env.AIROOM_ACP_HOME=path.join(dir,'homes');
  try{const executor=catalogCandidate('kimi',agent);executor.env.FIXTURE_WAIT='1';engine.store.put('executors',executor.id,executor);
    const login=engine.invoke('executor.authenticate',{id:executor.id,methodId:'kimi-code'});const rejected=assert.rejects(login,/登录/);
    let state:CatalogLoginState|undefined;const until=Date.now()+8000;while(Date.now()<until){state=await engine.invoke('executor.loginStatus',{id:executor.id}) as CatalogLoginState;if(state?.phase==='waiting')break;await new Promise(resolve=>setTimeout(resolve,20));}assert.equal(state?.phase,'waiting');
    await assert.rejects(engine.invoke('catalog.credentials',{id:'kimi',authentication:'kimi-code'}),/正在登录/);
    engine.store.put('sessions','login-session',{id:'login-session',provider:executor.id,projectId:'fixture',revision:1} as Session);
    await assert.rejects(engine.send('login-session','must not send during login'),/正在登录/);
    assert.deepEqual(await engine.invoke('executor.cancelLogin',{id:executor.id}),{cancelled:true});await rejected;
    const final=await engine.invoke('executor.loginStatus',{id:executor.id}) as CatalogLoginState;assert.equal(final.phase,'cancelled');assert.equal(final.url,undefined);assert.equal(final.code,undefined);assert.equal(engine.store.list('runs').length,0);
  }finally{if(old===undefined)delete process.env.AIROOM_ACP_HOME;else process.env.AIROOM_ACP_HOME=old;await engine.close();await clean(dir);}
});
test('official login parser accepts split UTF-8 and allowlisted HTTPS links without exposing logs or secrets',()=>{
  const states:CatalogLoginState[]=[],parser=officialExecutorLoginOutput('kimi',state=>states.push(state));
  parser.write(Buffer.from('secret-token=do-not-expose\nhttps://evil.example/\nhttps://auth.ki'));parser.write(Buffer.from('mi.com/verify?user_code=ABCD-1234\nenter code: ABCD-1234\n'));parser.end();
  assert.ok(states.some(state=>state.url?.startsWith('https://auth.kimi.com/')));assert.equal(states.at(-1)?.code,'ABCD-1234');assert.ok(!JSON.stringify(states).includes('do-not-expose'));
  for(const value of ['http://auth.kimi.com/','https://kimi.com.evil.example/','https://evil@kimi.com/','https://kimi.com:123/'])assert.equal(officialExecutorLoginUrl('kimi',value),undefined);
});
test('OpenCode subscription providers are isolated from metered providers and reject a mismatched model',()=>{
  const entry=catalogEntry('opencode');for(const auth of entry.authentication.filter(auth=>auth.billing==='subscription')){const executor=catalogCandidate('opencode',agent),result=catalogAuthentication(executor,{authentication:auth.id,secrets:{[auth.secretKeys![0]]:'fixture-key'},model:auth.id+'/fixture'});
    const env=managedCatalogEnvironment({...result.executor,env:{...result.executor.env,...result.secrets}},{OPENAI_API_KEY:'other-account'},'C:/fixture/home'),config=JSON.parse(env.OPENCODE_CONFIG_CONTENT!);assert.deepEqual(config.enabled_providers,[auth.id]);assert.equal(config.provider[auth.id].options.apiKey,`{env:${auth.secretKeys![0]}}`);assert.equal(env.OPENAI_API_KEY,undefined);assert.throws(()=>catalogAuthentication(executor,{authentication:auth.id,model:'openai/wrong'}),/当前登录方式/);
  }assert.equal(entry.authentication.find(auth=>auth.id==='opencode')?.billing,'metered');
});
test('Qoder official manifest and native inventory reject changed artifacts and path substitutions',async()=>{
  const version='1.1.66',url='https://qoder-ide.oss-accelerate.aliyuncs.com/qodercli/releases/1.1.66/qodercli-windows-x64.zip',file={os:'windows',arch:'amd64',variant:'standard',url,sha256:'a'.repeat(64)};
  assert.equal(qoderRelease(version,{latest:version,files:[file]}).url,url);assert.throws(()=>qoderRelease(version,{latest:version,files:[{...file,url:'https://evil.example/qoder.zip'}]}));assert.throws(()=>qoderRelease('../x',{}));
  const dir=await fixture(),entry=path.join(dir,'qodercli.exe'),bytes=Buffer.from('fixture');try{await writeFile(entry,bytes);await writeFile(path.join(dir,'.airoom-install.json'),JSON.stringify({schema:1,member:'qoder',version,entry:'qodercli.exe',entrySize:bytes.length,entrySha256:createHash('sha256').update(bytes).digest('hex')}));assert.equal(completeQoderEntry(dir,version),entry);await writeFile(entry,'changed');assert.equal(completeQoderEntry(dir,version),undefined);}finally{await clean(dir);}
});
test('Qoder CN uses a separate official manifest, executable, login domain and account directory',async()=>{
  const version='1.1.67',url=`https://static.qoder.com.cn/qoder-cli-cn/releases/${version}/qoderclicn-windows-x64.zip`,file={os:'windows',arch:'amd64',variant:'standard',url,sha256:'b'.repeat(64)};
  assert.equal(qoderRelease(version,{latest:version,files:[file]},'qodercn').url,url);assert.throws(()=>qoderRelease(version,{latest:version,files:[file]},'qoder'));
  assert.equal(officialExecutorLoginUrl('qodercn','https://qoder.cn/login'),'https://qoder.cn/login');assert.equal(officialExecutorLoginUrl('qodercn','https://qoder.com/login'),undefined);
  const executor=catalogCandidate('qodercn',agent),env=managedCatalogEnvironment(executor,{QODER_PERSONAL_ACCESS_TOKEN:'international-secret',QODER_CONFIG_DIR:'international-home',QODERCN_PERSONAL_ACCESS_TOKEN:'inherited-secret'},'C:/fixture/cn');
  assert.equal(env.QODER_CONFIG_DIR,undefined);assert.equal(env.QODER_PERSONAL_ACCESS_TOKEN,undefined);assert.equal(env.QODERCN_PERSONAL_ACCESS_TOKEN,undefined);assert.equal(env.QODERCN_CONFIG_DIR,path.join('C:/fixture/cn','qoder-cn'));
});
