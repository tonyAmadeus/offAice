import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { Engine } from '../src/backend/engine';
import { CATALOG_REVISION, EXECUTOR_CATALOG, catalogEntry, catalogProvider, type CatalogId } from '../src/shared/executor-catalog';
import { catalogCandidate, managedCatalogEnvironment, assertCatalogVersionUnused } from '../src/backend/executor-catalog';
import { DEFAULT_SETTINGS, isAcpId, normalizeExecutor } from '../src/shared/defaults';
import { installVersion, installedVersions, npmViewValue, type NpmRunner } from '../src/backend/member-versions';
import { claudeEnvironment, requireClaudeAuthentication, setClaudeApiKey, setClaudeOAuthToken } from '../src/backend/adapters/claude';
import { buildEnvironment, redact } from '../src/backend/security';
import type { Adapter, Session } from '../src/shared/types';
import {createHash} from 'node:crypto';
import {cursorPackage} from './fixtures/cursor-package';

const root=path.resolve('.test-cache/catalog-tests');
async function directory(){await mkdir(root,{recursive:true});return mkdtemp(path.join(root,'run-'));}
async function clean(data:string){assert.equal(path.dirname(data),root);await rm(data,{recursive:true,force:true});}
async function program(data:string,id:CatalogId,version:string){
  if(id==='cursor')return cursorPackage(path.join(data,'members',id,version),version);
  if(id==='qoder'||id==='qodercn'){
    const prefix=path.join(data,'members',id,version),entry=path.join(prefix,(id==='qodercn'?'qoderclicn.exe':'qodercli.exe')),contents=Buffer.from('fixture');await mkdir(prefix,{recursive:true});await writeFile(entry,contents);await writeFile(path.join(prefix,'.airoom-install.json'),JSON.stringify({schema:1,member:id,version,entry:(id==='qodercn'?'qoderclicn.exe':'qodercli.exe'),entrySize:contents.length,entrySha256:createHash('sha256').update(contents).digest('hex')}));return {entry,version};
  }
  if(id==='zcode'){
    const prefix=path.join(data,'members',id,version),entry=path.join(prefix,'resources/glm/zcode.cjs'),contents=Buffer.from("console.log('fixture')");
    await mkdir(path.dirname(entry),{recursive:true});await writeFile(entry,contents);const config=path.join(prefix,'resources/glm/provider/zcode-builtin.json');await mkdir(path.dirname(config),{recursive:true});await writeFile(config,'{}');
    await writeFile(path.join(prefix,'.airoom-install.json'),JSON.stringify({schema:3,member:id,version,entry:'resources/glm/zcode.cjs',entrySha256:createHash('sha256').update(contents).digest('hex'),files:[{path:'resources/glm/zcode.cjs',size:contents.length},{path:'resources/glm/provider/zcode-builtin.json',size:2,sha256:createHash('sha256').update('{}').digest('hex')}]}));return {entry,version};
  }
  const entry=catalogEntry(id),prefix=path.join(data,'members',id,version),folder=path.join(prefix,'node_modules',...entry.packageName.split('/'));
  await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'package.json'),JSON.stringify({name:entry.packageName,version,bin:{[entry.bin]:'cli.cjs'}}));
  await writeFile(path.join(folder,'cli.cjs'),`console.log('${version}')`);
  await writeFile(path.join(prefix,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{['node_modules/'+entry.packageName]:{version,integrity:'sha512-Zml4dHVyZQ=='}}}));
  return {entry:path.join(folder,'cli.cjs'),version};
}
const factory=(id:any):Adapter=>({probe:async()=>({id,name:id,available:false,runtimeReady:true,auth:'none',detail:'需要登录',capabilities:{streaming:true,write:true,history:false,cancel:'native',steer:false}}),start:async()=>{assert.fail('catalog acceptance must not prompt a model');},stop:async()=>{}});
const download=async(data:string,id:CatalogId,version:string,_env:any,options:any)=>{assert.equal(options.requireIntegrity,true);options.progress({phase:'installing',writtenBytes:2048,lastProgressAt:new Date().toISOString()});return program(data,id,version);};

test('catalog accepts only reviewed npm packages and generates valid external IDs; manual metadata cannot impersonate a catalog entry',()=>{
  assert.equal(EXECUTOR_CATALOG.length,9);
  for(const item of EXECUTOR_CATALOG){assert.match(item.packageName,/^(?:@[-a-z0-9]+\/)?[-a-z0-9]+$/);assert.ok(item.sources.length);assert.ok(item.licenseUrl.startsWith('https://'));if(!['codex','claude','dsh'].includes(item.id))assert.ok(isAcpId(catalogProvider(item.id)));}
  for(const id of ['../claude','https://example.com/pkg','unreviewed'])assert.throws(()=>catalogEntry(id));
  const manual=normalizeExecutor({name:'Manual',command:'agent',catalogId:'gemini',authentication:'fake'},undefined,'acp-12345678');assert.equal(manual.catalogId,undefined);
  const managed=catalogCandidate('gemini','C:/managed/gemini.js');assert.equal(normalizeExecutor(managed,managed).catalogId,'gemini');assert.throws(()=>normalizeExecutor({...managed,command:'C:/other/agent.js'},managed),/版本管理/);
});

test('all catalog signed-out candidates create their configuration and diagnostic without sending a task',async()=>{
  const data=await directory(),engine=new Engine(data,()=>{},()=>{},factory,undefined,download);
  try{
    for(const entry of EXECUTOR_CATALOG){
      const item=await engine.invoke('catalog.install',{id:entry.id,version:entry.recommendedVersion,agree:true,revision:CATALOG_REVISION}) as {selectedVersion:string;consented:boolean};
      assert.equal(item.selectedVersion,entry.recommendedVersion);assert.equal(item.consented,true);
      const info=engine.snapshot().providers.find(item=>item.id===catalogProvider(entry.id))!;assert.equal(info.auth,'none');assert.equal(info.runtimeReady,true);assert.equal(info.compatibility?.outcome,'needs-auth');assert.equal(info.compatibility?.error,undefined);
    }
    assert.equal(engine.store.executors().length,6);assert.equal(engine.store.list('runs').length,0);
  }finally{await engine.close();await clean(data);}
});

test('missing consent, source failure and failed ACP initialize preserve the previous configuration',async()=>{
  const data=await directory();let mode='good';
  const engine=new Engine(data,()=>{},()=>{},id=>mode==='initialize'?{...factory(id),probe:async()=>({...await factory(id).probe(DEFAULT_SETTINGS,{}),runtimeReady:false,auth:'unknown',detail:'initialize failed'})}:factory(id),undefined,async(...args)=>{if(mode==='source')throw new Error('source unavailable');return download(...args);});
  try{
    const params={id:'opencode',version:'1.18.35',agree:true,revision:CATALOG_REVISION};
    await assert.rejects(engine.invoke('catalog.install',{...params,agree:false}),/条款/);assert.equal(engine.store.executors().length,0);
    await engine.invoke('catalog.install',params);const saved=engine.store.executors()[0];
    for(const failure of ['source','initialize']){mode=failure;await assert.rejects(engine.invoke('catalog.install',{...params,version:'1.18.36'}));assert.deepEqual(engine.store.executors()[0],saved);assert.deepEqual(installedVersions(data,'opencode').map(item=>item.version),['1.18.35']);}
    assert.equal(await engine.invoke('catalog.installation',{id:'opencode'}),undefined);
  }finally{await engine.close();await clean(data);}
});

test('mirror packages must match official integrity, including npm 12 single-field output',async()=>{
  assert.equal(npmViewValue('["0.63.0"]'),'0.63.0');assert.equal(npmViewValue('"0.63.0"'),'0.63.0');
  const data=await directory();let valid=false;
  const npm:NpmRunner=async(args,_env,prefix)=>{
    if(args[0]==='view'){assert.ok(args.includes('--registry=https://registry.npmjs.org/'));return {code:0,stdout:JSON.stringify([valid?'sha512-Zml4dHVyZQ==':'sha512-bWlzbWF0Y2g=']),stderr:''};}
    const own=catalogEntry('gemini'),folder=path.join(prefix,'node_modules',...own.packageName.split('/'));await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'package.json'),JSON.stringify({name:own.packageName,version:'0.63.0',bin:{gemini:'cli.cjs'}}));await writeFile(path.join(folder,'cli.cjs'),"console.log('0.63.0')");await writeFile(path.join(prefix,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{['node_modules/'+own.packageName]:{version:'0.63.0',integrity:'sha512-Zml4dHVyZQ=='}}}));return {code:0,stdout:'',stderr:''};
  };
  try{
    await assert.rejects(installVersion(data,'gemini','0.63.0',buildEnvironment({...DEFAULT_SETTINGS,npmRegistry:'npmmirror'}),{npm,requireIntegrity:true}),/完整性记录/);
    assert.deepEqual(await readdir(path.join(data,'members/gemini')),[]);
    valid=true;await installVersion(data,'gemini','0.63.0',buildEnvironment({...DEFAULT_SETTINGS,npmRegistry:'npmmirror'}),{npm,requireIntegrity:true});assert.equal(installedVersions(data,'gemini').length,1);
  }finally{await clean(data);}
});

test('managed credentials stay out of database, snapshots, diagnostics and exports; homes and keys are isolated',async()=>{
  const data=await directory(),engine=new Engine(data,()=>{},()=>{},factory,undefined,download),secret='catalog-sentinel-api-secret-739106';
  try{
    await engine.invoke('catalog.install',{id:'opencode',version:'1.18.35',agree:true,revision:CATALOG_REVISION});
    await engine.invoke('catalog.credentials',{id:'opencode',authentication:'xai',model:'xai/fixture-model',secrets:{XAI_API_KEY:secret}});
    const executor=engine.store.executors()[0];assert.deepEqual(executor.secretKeys,['XAI_API_KEY']);assert.equal(executor.env.XAI_API_KEY,undefined);
    const snapshot=JSON.stringify(engine.snapshot());assert.ok(!snapshot.includes(secret));assert.ok(!JSON.stringify(engine.store.list('executors')).includes(secret));assert.ok(!JSON.stringify(redact({error:secret})).includes(secret));
    const diagnostic=await engine.invoke('diagnostics.export') as {path:string};assert.ok(!(await readFile(diagnostic.path,'utf8')).includes(secret));
    assert.ok(!(await readFile(path.join(data,'airoom.sqlite'))).includes(Buffer.from(secret)));
    const env=managedCatalogEnvironment(executor,{XAI_API_KEY:'other-account',GEMINI_API_KEY:'another-account',GOOGLE_APPLICATION_CREDENTIALS:'global-token.json',OPENCODE_CONFIG:'global-opencode.json',APPDATA:'global',LOCALAPPDATA:'global',HOME:'global'},path.join(data,'native','opencode'));
    assert.equal(env.XAI_API_KEY,undefined);assert.equal(env.GEMINI_API_KEY,undefined);assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS,undefined);assert.equal(env.OPENCODE_CONFIG,undefined);assert.ok(env.HOME?.startsWith(data));assert.ok(env.APPDATA?.startsWith(data));assert.ok(env.LOCALAPPDATA?.startsWith(data));
    await engine.invoke('catalog.credentials',{id:'opencode',authentication:'xai',secrets:{}});assert.deepEqual(engine.store.executors()[0].secretKeys,[]);
  }finally{await engine.close();await clean(data);}
});

test('old program directories are deleted despite historical sessions; selected or manually referenced programs are protected',async()=>{
  const data=await directory(),engine=new Engine(data,()=>{},()=>{},factory,undefined,download);
  try{
    await program(data,'gemini','0.63.0');
    await engine.invoke('catalog.use',{id:'gemini',version:'0.63.0',agree:true,revision:CATALOG_REVISION});
    await assert.rejects(engine.invoke('catalog.install',{id:'gemini',version:'0.64.0',agree:true,revision:CATALOG_REVISION}),/下载清单移除/);
    await assert.rejects(engine.invoke('catalog.remove',{id:'gemini',version:'0.63.0'}),/选用/);
    const old=await program(data,'gemini','0.62.0');engine.store.put('sessions','old',{id:'old',provider:catalogProvider('gemini'),executorIdentity:{path:old.entry}} as Session);
    assert.doesNotThrow(()=>assertCatalogVersionUnused(engine.store,engine.settings,'gemini','0.62.0'));
    await engine.invoke('catalog.remove',{id:'gemini',version:'0.62.0'});
    await assert.rejects(lstat(path.join(data,'members/gemini/0.62.0')),/ENOENT/);
    assert.ok(engine.store.get('sessions','old'),'historical chat is preserved');
    const native=await program(data,'claude','2.1.288');
    engine.store.put('sessions','native-old',{id:'native-old',provider:'claude',title:'保留原版本',executorIdentity:{path:native.entry}} as Session);
    await engine.invoke('member.remove',{provider:'claude',version:'2.1.288'});
    await assert.rejects(lstat(path.join(data,'members/claude/2.1.288')),/ENOENT/);
    assert.ok(engine.store.get('sessions','native-old'));
    await program(data,'claude','2.1.288');
    engine.store.put('executors','acp-nativefixture',normalizeExecutor({name:'引用已有程序',command:native.entry},undefined,'acp-nativefixture'));
    await assert.rejects(engine.invoke('member.remove',{provider:'claude',version:'2.1.288'}),/选用/,'a manual connection cannot lose a program through the older version panel');
  }finally{await engine.close();await clean(data);}
});

test('Claude API mode requires the saved API key and never silently replaces subscription authentication',()=>{
  try{
    setClaudeOAuthToken('subscription-token');setClaudeApiKey('claude-api-sentinel');
    const subscription=claudeEnvironment(buildEnvironment(DEFAULT_SETTINGS)),api=claudeEnvironment(buildEnvironment({...DEFAULT_SETTINGS,claudeAuthMode:'api'}));
    assert.equal(subscription.ANTHROPIC_API_KEY,undefined);assert.equal(subscription.CLAUDE_CODE_OAUTH_TOKEN,'subscription-token');
    assert.equal(api.CLAUDE_CODE_OAUTH_TOKEN,undefined);assert.equal(api.ANTHROPIC_API_KEY,'claude-api-sentinel');
    requireClaudeAuthentication({loggedIn:true,authMethod:'api_key',apiProvider:'firstParty'},api);
    assert.throws(()=>requireClaudeAuthentication({loggedIn:true,authMethod:'api_key'},subscription),/订阅/);
    assert.throws(()=>requireClaudeAuthentication({loggedIn:true,authMethod:'claude.ai'},api),/未确认/);
  }finally{setClaudeApiKey();setClaudeOAuthToken();}
});
test('older ZCode installs are recognized for same-version resource repair without rebinding the executor',async()=>{
  const data=await directory(),engine=new Engine(data,()=>{},()=>{},factory,undefined,download);
  try{const item=await program(data,'zcode','3.14.5'),prefix=path.dirname(path.dirname(path.dirname(item.entry))),markerFile=path.join(prefix,'.airoom-install.json'),marker=JSON.parse(await readFile(markerFile,'utf8'));await writeFile(markerFile,JSON.stringify({...marker,schema:2}));
    const executor=catalogCandidate('zcode',item.entry);engine.store.put('executors',executor.id,executor);engine.store.put('catalog_consents','zcode',{revision:CATALOG_REVISION});
    const before=await engine.invoke('catalog.list')as any;assert.equal(before.items.find((item:any)=>item.entry.id==='zcode').needsRepair,true);assert.equal(before.items.find((item:any)=>item.entry.id==='zcode').selectedVersion,'3.14.5');
    const fixed=await engine.invoke('catalog.install',{id:'zcode',version:'3.14.5',revision:CATALOG_REVISION})as any;assert.equal(fixed.needsRepair,false);assert.equal(engine.store.executors()[0].command,executor.command);assert.equal(engine.store.list('runs').length,0);
  }finally{await engine.close();await clean(data);}
});

test('ZCode region changes clear old native routing and model overrides while preserving canonical history',async()=>{
  const data=await directory(),engine=new Engine(data,()=>{},()=>{},factory);
  try{
    const fresh=catalogCandidate('zcode','fixture-zcode.cjs');assert.equal(fresh.authentication,'bigmodel');
    const executor={...fresh,authentication:'zai'};assert.equal(catalogCandidate('zcode','new-version.cjs',executor).authentication,'zai');
    assert.equal(catalogCandidate('zcode','new-version.cjs',{...executor,authentication:undefined}).authentication,'zai');
    engine.store.put('executors',executor.id,executor);
    const session={id:'history',provider:executor.id,projectId:'project',title:'保留对话',nativeId:'old-zai-thread',nativeHome:'airoom',revision:1,writeMode:false,createdAt:'',updatedAt:''} as Session;
    const other={...session,id:'other',provider:'codex',nativeId:'unrelated-thread'} as Session;
    engine.store.put('sessions',session.id,session);engine.store.put('sessions',other.id,other);
    const run={id:'historic-run',sessionId:session.id,status:'ended',nativeSessionId:'old-zai-thread',summary:'历史成果'};
    engine.store.put('runs',run.id,run);
    engine.store.appendEvent({id:'historic-message',sessionId:session.id,runId:run.id,provider:executor.id,kind:'delta',text:'历史对话',fidelity:'native',at:''});
    const events=engine.store.listEvents(session.id);
    engine.settings.models[executor.id]='old-zai-model';engine.settings.efforts[executor.id]='high';engine.settings.models.codex='keep-codex-model';
    await engine.probe(executor.id);
    await engine.invoke('catalog.credentials',{id:'zcode',authentication:'zai'});
    assert.deepEqual(engine.store.get('sessions',session.id),session);assert.equal(engine.settings.models[executor.id],'old-zai-model');
    await assert.rejects(engine.invoke('catalog.credentials',{id:'zcode',authentication:'invalid'}),/支持的登录方式/);assert.deepEqual(engine.store.get('sessions',session.id),session);
    await engine.invoke('catalog.credentials',{id:'zcode',authentication:'bigmodel'});
    assert.equal(engine.store.executors()[0].authentication,'bigmodel');assert.equal(engine.snapshot().providers.find(info=>info.id===executor.id)!.stale,true);
    const {nativeId,nativeHome,...history}=session;assert.deepEqual(engine.store.get('sessions',session.id),history);assert.deepEqual(engine.store.get('sessions',other.id),other);
    assert.deepEqual(engine.store.listEvents(session.id),events);assert.deepEqual(engine.store.get('runs',run.id),run);
    assert.equal(engine.settings.models[executor.id],undefined);assert.equal(engine.settings.efforts[executor.id],undefined);assert.equal(engine.settings.models.codex,'keep-codex-model');
    await engine.invoke('catalog.credentials',{id:'zcode',authentication:'zai'});assert.deepEqual(engine.store.listEvents(session.id),events);assert.deepEqual(engine.store.get('runs',run.id),run);
  }finally{await engine.close();await clean(data);}
});
