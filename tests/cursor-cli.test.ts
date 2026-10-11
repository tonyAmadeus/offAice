import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,mkdtemp,readFile,rm,writeFile,rename,symlink,lstat} from 'node:fs/promises';
import {cursorPackage} from './fixtures/cursor-package';
import {cursorArchiveFiles,cursorInstallerRelease,cursorRelease,completeCursorEntry} from '../src/backend/cursor-install';
import {isVersion,isCatalogVersion,installedVersions,removeVersion} from '../src/backend/member-versions';
import {catalogCandidate,managedCatalogEnvironment,assertCatalogVersionUnused} from '../src/backend/executor-catalog';
import {catalogEntry} from '../src/shared/executor-catalog';
import {prepareCliLaunch} from '../src/backend/adapters/common';
import {cursorClientRequest} from '../src/backend/adapters/cursor-acp';
import {AcpAdapter} from '../src/backend/adapters/acp';
import {officialExecutorLoginUrl} from '../src/backend/official-login';
import {DEFAULT_SETTINGS} from '../src/shared/defaults';
import {Store} from '../src/backend/store';
import type {AdapterContext,Session} from '../src/shared/types';

const root=path.resolve('.test-cache/cursor-tests'),version='2026.10.01-e373342';
async function fixture(){await mkdir(root,{recursive:true});return mkdtemp(path.join(root,'run-'));}
async function clean(directory:string){assert.equal(path.dirname(directory),root);await rm(directory,{recursive:true,force:true});}
const required=['dist-package/index.js','dist-package/node.exe','dist-package/package.json','dist-package/node_sqlite3.node'];
function zip(names:string[],symbolic?:string){
  const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
  for(const name of names){const bytes=Buffer.from(name),head=Buffer.alloc(30),entry=Buffer.alloc(46);head.writeUInt32LE(0x04034b50);head.writeUInt16LE(bytes.length,26);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(bytes.length,28);entry.writeUInt32LE(offset,42);if(name===symbolic)entry.writeUInt32LE(0xa1ff0000,38);local.push(head,bytes);central.push(entry,bytes);offset+=head.length+bytes.length;}
  const end=Buffer.alloc(22),directory=Buffer.concat(central);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(names.length,8);end.writeUInt16LE(names.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,directory,end]);
}

test('Cursor uses official date/hash versions without relaxing npm package version validation',()=>{
  const script=`$downloadUrl = 'https://downloads.cursor.com/lab/${version}/'\n$version = '${version}'\nRemove-Item SHOULD-NEVER-EXECUTE`;
  assert.equal(cursorInstallerRelease(script).url,cursorRelease(version).url);assert.equal(isVersion(version),false);assert.equal(isCatalogVersion('cursor',version),true);assert.equal(isCatalogVersion('kimi',version),false);assert.equal(isCatalogVersion('cursor','2026.10.01-12-34-56-e373342'),true);
  for(const value of ['../x','2026.00.01-e373342','2026.10.32-e373342','1.0.0','2026.10.01-e373342?x'])assert.throws(()=>cursorRelease(value));
  assert.throws(()=>cursorInstallerRelease(script.replace('https://downloads.cursor.com','https://evil.example')));assert.throws(()=>cursorInstallerRelease(script+`\n$version = '${version}'`));
  assert.deepEqual(catalogEntry('cursor').args,['--disable-auto-update','acp']);assert.equal(catalogEntry('cursor').authentication[0].billing,'subscription');assert.equal(officialExecutorLoginUrl('cursor','https://cursor.com/loginDeepControl?fixture=1'),'https://cursor.com/loginDeepControl?fixture=1');assert.equal(officialExecutorLoginUrl('cursor','https://cursor.com.evil.example/login'),undefined);
});

test('Cursor ZIP validation rejects traversal, local/central mismatches, Windows aliases and symlinks before extraction',()=>{
  assert.deepEqual(cursorArchiveFiles(zip(required)),[...required].sort());
  for(const name of ['../escape','dist-package/../escape','C:/escape','dist-package/a:stream','dist-package/NUL.txt','dist-package/a.','dist-package/escape\\x','dist-package/node.EXE'])assert.throws(()=>cursorArchiveFiles(zip([...required,name])));
  assert.throws(()=>cursorArchiveFiles(zip(required,'dist-package/node.exe')));assert.throws(()=>cursorArchiveFiles(zip(required.slice(0,-1))));
  const changed=zip(required);changed[30]^=1;assert.throws(()=>cursorArchiveFiles(changed));
});

test('Cursor inventory protects the entire native runtime and detects modified files and junctions',async()=>{
  const directory=await fixture(),prefix=path.join(directory,version);try{
    const item=await cursorPackage(prefix,version);assert.equal(completeCursorEntry(prefix,version),item.entry);assert.equal(completeCursorEntry(prefix,'2026.10.02-a373342'),undefined);
    const addon=path.join(prefix,'dist-package/node_sqlite3.node');await writeFile(addon,'fixture-Addon');assert.equal(completeCursorEntry(prefix),undefined);await writeFile(addon,'fixture-addon');assert.equal(completeCursorEntry(prefix),item.entry);
    const outside=path.join(directory,'outside');await rename(path.join(prefix,'dist-package'),outside);await symlink(outside,path.join(prefix,'dist-package'),process.platform==='win32'?'junction':'dir');assert.equal(completeCursorEntry(prefix),undefined);await rm(path.join(prefix,'dist-package'),{force:true});
  }finally{await clean(directory);}
});

test('Cursor uses its own Node ABI and isolated config without inheriting host login or update settings',async()=>{
  const directory=await fixture();try{
    const item=await cursorPackage(path.join(directory,version),version),executor=catalogCandidate('cursor',item.entry),home=path.join(directory,'home'),env=managedCatalogEnvironment(executor,{CURSOR_API_KEY:'host-key',CURSOR_AUTH_TOKEN:'host-token',CURSOR_CONFIG_DIR:'host-profile',CURSOR_DATA_DIR:'host-data',CURSOR_API_URL:'host-endpoint',AIROOM_NODE_EXE:'wrong-host',AIROOM_NODE_VERSION:'1.0.0',NODE_COMPILE_CACHE:'host-cache'},home);
    assert.equal(env.CURSOR_API_KEY,undefined);assert.equal(env.CURSOR_AUTH_TOKEN,undefined);assert.equal(env.CURSOR_API_URL,undefined);assert.equal(env.CURSOR_CONFIG_DIR,path.join(home,'cursor'));assert.equal(env.CURSOR_DATA_DIR,path.join(home,'data/cursor'));assert.equal(env.NODE_COMPILE_CACHE,path.join(home,'cache/node'));
    const launch=prepareCliLaunch({command:process.execPath,path:item.entry,prefix:[item.entry]},executor.args,env);assert.equal(launch.command,path.join(path.dirname(item.entry),'node.exe'));assert.equal(launch.env.ELECTRON_RUN_AS_NODE,undefined);assert.deepEqual(launch.args,[item.entry,'--disable-auto-update','acp']);
    const adapter=new AcpAdapter(executor),context={cwd:directory,env:{...env,AIROOM_ACP_HOME:path.join(directory,'native')},settings:DEFAULT_SETTINGS,run:{provider:executor.id},session:{writeMode:false}} as unknown as AdapterContext,stamp=adapter.runtimeFingerprint(context);
    await writeFile(launch.command,'updated-fixture-host');assert.notEqual(adapter.runtimeFingerprint(context),stamp,'replacing the native Node host invalidates a cached ACP runtime');
  }finally{await clean(directory);}
});

test('Cursor date/hash installations remain discoverable and deleting an old version preserves history',async()=>{
  const directory=await fixture(),store=new Store(directory);try{
    const prefix=path.join(directory,'members/cursor',version),item=await cursorPackage(prefix,version);assert.deepEqual(installedVersions(directory,'cursor'),[item]);
    store.put('sessions','old',{id:'old',provider:'acp-catalogcursor',projectId:'fixture',title:'old',nativeId:'cursor-native-history',revision:1,writeMode:false,createdAt:'',updatedAt:'',executorIdentity:{path:item.entry,adapterVersion:'fixture',protocol:'acp'}} as Session);
    await removeVersion(directory,'cursor',version,()=>assertCatalogVersionUnused(store,DEFAULT_SETTINGS,'cursor',version));assert.deepEqual(installedVersions(directory,'cursor'),[]);await assert.rejects(lstat(prefix),/ENOENT/);assert.equal(store.get<Session>('sessions','old')?.nativeId,'cursor-native-history');await assert.rejects(removeVersion(directory,'cursor','../outside'),/版本号/);
  }finally{store.close();await clean(directory);}
});

const questions={toolCallId:'tool1',title:'选择方向',questions:[{id:'style',prompt:'选择风格',options:[{id:'a',label:'简洁'},{id:'b',label:'详细'}]},{id:'features',prompt:'选择功能',allowMultiple:true,options:[{id:'x',label:'文档'},{id:'y',label:'测试'}]}]};
function client(approve:AdapterContext['approve']){
  let active=true;const replies:any[]=[],events:any[]=[];
  const context={approve,emit:(...args:any[])=>events.push(args)} as unknown as AdapterContext;
  return {context,sessionId:'session',active:()=>active,reply:(result:unknown,error?:unknown)=>replies.push({result,error}),replies,events,stop:()=>{active=false;}};
}
test('Cursor question answers map UI labels to native option IDs and allow an empty skip',async()=>{
  const c=client(async()=>({choice:'answer',answers:{style:'简洁',features:['文档','测试']}}));assert.equal(await cursorClientRequest({id:1,method:'cursor/ask_question',params:questions},c),true);assert.deepEqual(c.replies[0].result,{outcome:{outcome:'answered',answers:[{questionId:'style',selectedOptionIds:['a']},{questionId:'features',selectedOptionIds:['x','y']}]}});
  for(const answer of [{choice:'skip'},{choice:'answer',answers:{}}]){const c=client(async()=>answer);await cursorClientRequest({id:1,method:'cursor/ask_question',params:questions},c);assert.equal(c.replies[0].result.outcome.outcome,'skipped');}
  const custom=client(async()=>({choice:'answer',answers:{style:'自由回答'}}));await cursorClientRequest({id:1,method:'cursor/ask_question',params:questions},custom);assert.match(custom.replies[0].result.outcome.reason,/自由回答/);assert.equal(custom.replies[0].result.outcome.outcome,'skipped');
});

test('Cursor plan confirmation respects user choice and cancels stale answers',async()=>{
  for(const choice of ['accept','reject']){const c=client(async request=>{assert.equal(request.type,'approval');assert.equal(request.allowChoice,'accept');return {choice};});await cursorClientRequest({id:1,method:'cursor/create_plan',params:{name:'计划',plan:'先检查再修改'}},c);assert.equal(c.replies[0].result.outcome.outcome,choice==='accept'?'accepted':'rejected');}
  let resolve!:(answer:{choice:string})=>void;const c=client(()=>new Promise(done=>resolve=done));const pending=cursorClientRequest({id:2,method:'cursor/create_plan',params:{plan:'pending'}},c);c.stop();resolve({choice:'accept'});await pending;assert.equal(c.replies[0].result.outcome.outcome,'cancelled');
  const idle=client(async()=>assert.fail('an idle request must never ask for approval'));idle.stop();await cursorClientRequest({id:3,method:'cursor/ask_question',params:questions},idle);assert.equal(idle.replies[0].result.outcome.outcome,'cancelled');
});

test('Cursor notifications render activity and malformed or foreign-session requests cannot block the runtime',async()=>{
  const c=client(async()=>assert.fail('notifications cannot request approval'));
  await cursorClientRequest({method:'cursor/update_todos',params:{todos:[{id:'1',content:'检查',status:'in_progress'}]}},c);await cursorClientRequest({method:'cursor/task',params:{description:'检查模块'}},c);await cursorClientRequest({method:'cursor/generate_image',params:{description:'生成图示'}},c);assert.deepEqual(c.events.map(event=>event[0]),['plan','tool','tool']);
  await cursorClientRequest({id:1,method:'cursor/ask_question',params:{}},c);assert.equal(c.replies.at(-1).error.code,-32602);
  await cursorClientRequest({id:2,method:'cursor/create_plan',params:{sessionId:'other',plan:'foreign'}},c);assert.equal(c.replies.at(-1).result.outcome.outcome,'cancelled');assert.equal(await cursorClientRequest({id:3,method:'unreviewed/extension'},c),false);
});
