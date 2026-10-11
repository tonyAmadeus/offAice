import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, readFile, mkdtemp, symlink, writeFile, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
import {DEFAULT_SETTINGS} from '../src/shared/defaults';
import {DshAdapter, buildDshEnvironment, buildDshPatch, dshPermissionDenial, dshSessionPolicy, dshTerminalEvent, DSH_GUARD_SOURCE} from '../src/backend/adapters/dsh';
import type {MemberPermissions} from '../src/shared/types';
// These boundary regressions exercise the optional workspace preset, independently of personal defaults.
const policy=(writeMode:boolean,overrides:Partial<MemberPermissions>={})=>dshSessionPolicy({...DEFAULT_SETTINGS.permissions.dsh,fileScope:'workspace',...overrides},writeMode);

test('DSH isolates home and credential sources while preserving the selected proxy', () => {
  const home=path.resolve('tests/results/dsh-policy');
  const env=buildDshEnvironment({DSH_HOME:'desktop-home',DSH_PERMISSION_MODE:'danger-full-access',DSH_UNKNOWN_PLUGIN:'desktop',DEEPSEEK_API_KEY:'inherited-secret',deepseek_api_key:'lowercase-inherited-secret',HTTPS_PROXY:'http://127.0.0.1:7897',NO_PROXY:'localhost'},home,false,'airoom-test-key');
  assert.equal(env.DSH_HOME,home);
  assert.equal(env.DSH_PERMISSION_MODE,'read-only');
  assert.equal(env.DSH_UNKNOWN_PLUGIN,undefined);
  assert.equal(env.DEEPSEEK_API_KEY,undefined);
  assert.equal(env.deepseek_api_key,undefined);
  assert.equal(env.HTTPS_PROXY,'http://127.0.0.1:7897');
  assert.equal(env.DSH_TELEMETRY_DISABLED,'1');
  assert.equal(buildDshEnvironment(env,home,false).DEEPSEEK_API_KEY,undefined);
});

test('DSH permission checks cannot allow writes or commands in readonly sessions', async () => {
  const cwd=path.resolve('tests/results/dsh-policy');await mkdir(cwd,{recursive:true});
  assert.match(dshPermissionDenial('write',{file_path:'result.txt'},policy(false),cwd)!,/禁止/);
  assert.equal(dshPermissionDenial('pwsh',{command:'Get-ChildItem'},policy(false),cwd),undefined); // standard mode: commands go to approval
  assert.match(dshPermissionDenial('pwsh',{command:'Remove-Item a'},policy(true,{commands:'deny'}),cwd)!,/禁止/);
  assert.match(dshPermissionDenial('web_fetch',{url:'https://x'},policy(true,{network:false}),cwd)!,/禁止/);
  assert.match(dshPermissionDenial('ask_user_question',{questions:[]},policy(true),cwd)!,/禁止/);
  assert.equal(dshPermissionDenial('write',{file_path:path.resolve(cwd,'../outside.txt')},policy(true,{fileScope:'any'}),cwd),undefined);
  assert.match(dshPermissionDenial('read',{file_path:'a',sandbox_permissions:'danger-full-access'},policy(false),cwd)!,/沙箱/);
  assert.match(dshPermissionDenial('write',{file_path:path.resolve(cwd,'../outside.txt')},policy(true),cwd)!,/超出/);
  assert.equal(dshPermissionDenial('read',{file_path:'a'},policy(false),cwd),undefined);
  assert.equal(dshPermissionDenial('write',{file_path:'result.txt'},policy(true),cwd),undefined);
});

test('DSH policy plugin guards execution and hides unsupported tools before prompt assembly', async () => {
  const cwd=path.resolve('tests/results/dsh-policy');await mkdir(cwd,{recursive:true});
  const plugin=await import('data:text/javascript;base64,'+Buffer.from(DSH_GUARD_SOURCE).toString('base64'));
  const load=(config:Record<string,unknown>)=>{
    let guard:((call:any)=>string|undefined)|undefined;let created:((data:any)=>void)|undefined;let preExecute:((exec:any,next:()=>Promise<any>)=>Promise<any>)|undefined;let restricted:any;
    const ctx={tools:{guard:(value:any)=>{guard=value;},schemas:()=>[{name:'read'},{name:'write'},{name:'pwsh'},{name:'web_fetch'},{name:'subagent'},{name:'ask_user_question'}]},
      on:(event:string,value:any)=>{if(event==='agent/created')created=value;else if(event==='tools/pre-execute')preExecute=value;else if(event!=='session/event')assert.fail('unexpected event '+event);}};
    plugin.apply(ctx,{...config,workspaceRoot:cwd});
    created!({agent:{ctx:{tools:{restrict:(value:any)=>{restricted=value;}}}}});
    return {guard:guard!,deny:restricted.deny as string[],preExecute};
  };
  // Standard mode, read-only session: commands stay (sandboxed, approved), writes and question tools are hidden.
  const readOnly=load({...policy(false,{commands:'ask'})});
  assert.deepEqual(readOnly.deny,['write','ask_user_question']);
  assert.equal(readOnly.guard({name:'read',arguments:{file_path:'inside.txt'},agent:{session:{header:{cwd}}}}),undefined);
  assert.match(readOnly.guard({name:'read',arguments:{},agent:{session:{header:{cwd}}}})!,/路径/);
  assert.match(readOnly.guard({name:'write',arguments:{}})!,/unavailable/);
  assert.match(readOnly.guard({name:'read',arguments:{sandbox_permissions:'danger-full-access'}})!,/widening/);
  // commands: ask turns every allowed command into an approval request; other tools pass through.
  assert.deepEqual(await readOnly.preExecute!({name:'pwsh'},async()=>({kind:'allow'})),{kind:'ask',reason:'AIROOM: every command needs approval',displayReason:{en:'Run this command?','zh-CN':'执行这条命令需要你确认'}});
  assert.deepEqual(await readOnly.preExecute!({name:'read'},async()=>({kind:'allow'})),{kind:'allow'});
  assert.deepEqual(await readOnly.preExecute!({name:'pwsh'},async()=>({kind:'deny',reason:'x'})),{kind:'deny',reason:'x'});
  // Default standard mode: commands run in the DSH sandbox, which asks only to leave it.
  assert.equal(load({...policy(false)}).preExecute,undefined);
  // Adjusted permissions: no commands, no network, no extra approval step.
  const locked=load({...policy(true,{commands:'deny',network:false})});
  assert.deepEqual(locked.deny,['pwsh','web_fetch','ask_user_question']);
  assert.equal(locked.preExecute,undefined);
  const automatic=load({...policy(true,{commands:'auto'})});
  assert.equal(automatic.preExecute,undefined);
  const offline=load({...policy(true,{commands:'auto',network:false})});
  assert.ok(offline.deny.includes('pwsh'));
  assert.match(offline.guard({name:'pwsh',arguments:{command:'Invoke-WebRequest https://example.com'}})!,/unavailable/);
  // fileScope any lifts AIROOM's path boundary; a missing scope keeps it.
  const open=load({...policy(true,{fileScope:'any'})});
  assert.equal(open.guard({name:'read',arguments:{file_path:path.resolve(cwd,'../elsewhere.txt')},agent:{session:{header:{cwd}}}}),undefined);
  assert.match(load({writeMode:true}).guard({name:'read',arguments:{file_path:path.resolve(cwd,'../elsewhere.txt')},agent:{session:{header:{cwd}}}})!,/超出/);
});

test('DSH guard and approval reject escaped reads and search paths, including native directory links', async t => {
  await mkdir(path.resolve('tests/results'),{recursive:true});
  const base=await mkdtemp(path.resolve('tests/results/dsh-boundary-'));
  t.after(async()=>{await rm(base,{recursive:true,force:true});});
  const cwd=path.join(base,'workspace');const outside=path.join(base,'outside');
  await mkdir(cwd);await mkdir(outside);
  await writeFile(path.join(cwd,'inside.txt'),'inside');
  await writeFile(path.join(outside,'private.txt'),'SHOULD_NEVER_LEAVE_WORKSPACE');
  await symlink(outside,path.join(cwd,'external-link'),'junction');
  await symlink(path.join(base,'missing'),path.join(cwd,'broken-link'),'junction');
  const plugin=await import('data:text/javascript;base64,'+Buffer.from(DSH_GUARD_SOURCE).toString('base64'));
  let guard:((call:any)=>string|undefined)|undefined;
  plugin.apply({tools:{guard:(fn:any)=>{guard=fn;}},on:()=>{}},{writeMode:false,workspaceRoot:cwd});
  const invoke=(name:string,args:Record<string,unknown>,actual=cwd)=>guard!({name:name,arguments:args,agent:{session:{header:{cwd:actual}}}});
  const rejected=[path.join(outside,'private.txt'),'../outside/private.txt','external-link/private.txt','external-link/not-yet-created.txt','broken-link/private.txt','private.txt:alternate-stream','C:relative.txt','\\\\?\\C:\\outside.txt'];
  for (const name of ['read','read_image']) {
    for (const file_path of rejected) {
      assert.ok(invoke(name,{file_path}),`${name} must reject ${file_path} before executing`);
      assert.ok(dshPermissionDenial(name,{file_path},policy(false),cwd),`${name} approval must also reject ${file_path}`);
    }
    assert.equal(invoke(name,{file_path:'inside.txt'}),undefined);
    assert.equal(invoke(name,{file_path:path.join(cwd,'inside.txt')}),undefined);
  }
  for (const name of ['glob','grep']) {
    for (const target of [outside,'../outside','external-link','broken-link',null,42,'']) {
      const args={pattern:'private',path:target};
      assert.ok(invoke(name,args),`${name} must reject ${target} before executing`);
      assert.ok(dshPermissionDenial(name,args,policy(false),cwd));
    }
    assert.equal(invoke(name,{pattern:'inside'}),undefined);
    assert.equal(invoke(name,{pattern:'inside',path:cwd}),undefined);
  }
  assert.ok(invoke('read',{file_path:'private.txt'},outside),'a tool cannot change the approved session cwd');
  // The actual native search helper uses a fixed argv and --no-config, without --follow.
  // Verify its bundled ripgrep skips nested junctions rather than exposing their contents.
  const {rgPath}=await import('@vscode/ripgrep');
  const searchEnv={...process.env,RIPGREP_CONFIG_PATH:undefined};
  const files=spawnSync(rgPath,['--no-config','--files','--glob=*','--no-ignore','--hidden'],{cwd,env:searchEnv,encoding:'utf8'});
  assert.equal(files.status,0,files.stderr);
  assert.ok(files.stdout.includes('inside.txt'));
  assert.ok(!files.stdout.includes('private.txt'),files.stdout);
  const contents=spawnSync(rgPath,['--no-config','--json','--regexp=SHOULD_NEVER_LEAVE_WORKSPACE'],{cwd,env:searchEnv,encoding:'utf8'});
  assert.equal(contents.status,1,contents.stderr);
  assert.ok(!contents.stdout.includes('SHOULD_NEVER_LEAVE_WORKSPACE'));
});

test('DSH patch carries no credential values and uses the separate public Messages endpoint', () => {
  const patch=buildDshPatch(DEFAULT_SETTINGS,path.resolve('.'),false,path.resolve('guard.mjs'));
  const carded=JSON.stringify(buildDshPatch(DEFAULT_SETTINGS,path.resolve('.'),false,path.resolve('guard.mjs'),'你在 AIROOM 团队里的名字是「DS」。口头禅 {{cwd}}'));
  assert.match(carded,/「DS」/);assert.match(carded,/口头禅 \{ \{cwd\} \}/,'card text cannot inject template slots');
  const text=JSON.stringify(patch);
  assert.ok(text.includes('https://api.deepseek.com/anthropic'));
  assert.ok(!text.includes('DEEPSEEK_API_KEY'));
  assert.equal((patch.find(row=>row.id==='acp') as any).config.provider,'deepseek-account');
  assert.ok(!text.includes('airoom-test-key'));
  assert.deepEqual((patch.find((row:any)=>row.id==='permission') as any).config.presets,{'read-only':{sandbox:'read-only',approval:'ask'}});
  assert.equal((patch.find((row:any)=>row.insert) as any).insert[0].config.workspaceRoot,path.resolve('.'));
  assert.throws(()=>buildDshPatch({...DEFAULT_SETTINGS,deepseekBaseUrl:'https://unapproved.example/'},path.resolve('.'),false,path.resolve('guard.mjs')),/官方/);
});

test('standalone DSH guard remains executable after the desktop worker is bundled', async () => {
  const result=await build({entryPoints:['src/backend/adapters/dsh.ts'],bundle:true,platform:'node',format:'esm',target:'node24',packages:'external',write:false});
  const bundled=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
  const plugin=await import('data:text/javascript;base64,'+Buffer.from(bundled.DSH_GUARD_SOURCE).toString('base64'));
  const cwd=path.resolve('tests/results/dsh-policy');await mkdir(cwd,{recursive:true});
  let guard:((call:any)=>string|undefined)|undefined;
  plugin.apply({tools:{guard:(fn:any)=>{guard=fn;}},on:()=>{}},{writeMode:false,workspaceRoot:cwd});
  const agent={session:{header:{cwd}}};
  assert.equal(guard!({name:'read',arguments:{file_path:'inside.txt'},agent}),undefined);
  assert.ok(guard!({name:'read',arguments:{file_path:'../private.txt'},agent}));
});

test('official independent DSH reports signed-out without a key, desktop credentials or a model prompt', {timeout:90000}, async () => {
  const home=path.resolve('tests/results/DSH 接入验收');
  const env=buildDshEnvironment({...process.env,AIROOM_DSH_HOME:home,AIROOM_APP_ROOT:process.cwd()},home,false);
  const adapter=new DshAdapter();
  const first=await adapter.probe(DEFAULT_SETTINGS,env);
  assert.equal(first.auth,'none');
  assert.equal(first.available,false);
  assert.match(first.detail,/还未登录/);
  const manifest=JSON.parse(await readFile(path.join(home,'profiles',DEFAULT_SETTINGS.dshProfile,'package.json'),'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles,['@deepseek-ai/dsh-base','@deepseek-ai/dsh-acp-app']);
  // A second probe must use an existing profile, without repeating --from-default-profile.
  const second=await new DshAdapter().probe(DEFAULT_SETTINGS,env);
  assert.match(second.detail,/还未登录/);
});


test('DSH probe rechecks the native account after discovery without a model call or credential reads',async()=>{
  const directory=await mkdtemp(path.resolve('.test-cache/dsh-final-auth-'));
  try{
    for(const state of ['signed-out','verification-failed']){
      const adapter:any=new DshAdapter(),modes:string[]=[],requests:string[]=[];
      adapter.command=async()=>path.join(directory,'fake-dsh');adapter.collect=async()=> '0.2.0-rc.2';adapter.launch=async()=>{};adapter.cleanup=async()=>{};
      adapter.accountStatus=async(_s:any,_e:any,mode='probe')=>{modes.push(mode);return mode==='probe'?{authenticated:true,state:'signed-in',balance:{status:'ready',wallets:[{currency:'CNY',balance:'8'}],bonusWallets:[],checkedAt:new Date().toISOString()}}:{authenticated:false,state};};
      adapter.request=async(method:string)=>{requests.push(method);return method==='session/new'?{sessionId:'test-session',configOptions:[]}:{};};
      const info=await adapter.probe(DEFAULT_SETTINGS,{...process.env,AIROOM_DSH_HOME:directory});
      assert.equal(info.available,false);assert.equal(info.auth,state==='signed-out'?'none':'unknown');assert.equal(info.quota.accountBalance.status,'unavailable');assert.deepEqual(modes,['probe','state']);assert.ok(!requests.includes('session/prompt'));
    }
  }finally{assert.ok(path.basename(directory).startsWith('dsh-final-auth-'));await rm(directory,{recursive:true,force:true});}
});
