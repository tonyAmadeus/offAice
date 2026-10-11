import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcess} from 'node:child_process';
import path from 'node:path';
import { installVersion, installedVersions, isVerified, isVersion, versionOfPath, removeVersion, MEMBER_PACKAGES, runNpm, waitForNpmOutput, type NpmRunner, type InstallProgress } from '../src/backend/member-versions';
import type { PermissionMember } from '../src/shared/types';

async function fakeInstall(data: string, member: 'codex' | 'dsh', version: string, pkg: string, bin: Record<string, string>) {
  const dir = path.join(data, 'members', member, version, 'node_modules', ...pkg.split('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: pkg, version, bin }));
  for (const file of Object.values(bin)) { await mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await writeFile(path.join(dir, file), `console.log('${version}')`); }
  await writeFile(path.join(data,'members',member,version,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{['node_modules/'+pkg]:{version}}}));
  return path.join(dir, Object.values(bin)[0]);
}

test('version strings and diagnostic baseline membership are exact', () => {
  assert.ok(isVersion('0.160.0')); assert.ok(isVersion('0.2.0-rc.2'));
  assert.ok(!isVersion('latest')); assert.ok(!isVersion('1.2; rm -rf /'));
  assert.ok(isVerified('claude', '2.1.288 (Claude Code)'));
  assert.ok(isVerified('codex', 'codex-cli 0.160.0'));
  assert.ok(!isVerified('dsh', '0.3.0'));
  assert.ok(!isVerified('codex', undefined));
  assert.ok(!isVerified('codex','0.160.0-beta.1'));assert.ok(!isVerified('claude','2.1.288-beta.1'));assert.ok(!isVerified('dsh','0.2.0-rc.20'));
});

test('installed versions are discovered per member and map back from their entry path', async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'airoom-members-'));
  try {
  const codexEntry = await fakeInstall(data, 'codex', '0.161.0', '@openai/codex', { codex: 'bin/codex.js' });
  await fakeInstall(data, 'codex', '0.160.0', '@openai/codex', { codex: 'bin/codex.js' });
  await mkdir(path.join(data, 'members', 'codex', '0.162.0'), { recursive: true }); // half-finished install: ignored
  await fakeInstall(data, 'dsh', '0.2.0-rc.3', '@deepseek-ai/dsh', { dsh: 'lib/bin.js' });
  assert.deepEqual(installedVersions(data, 'codex').map(item => item.version), ['0.160.0', '0.161.0']);
  assert.deepEqual(installedVersions(data, 'dsh').map(item => item.version), ['0.2.0-rc.3']);
  assert.equal(versionOfPath(data, 'codex', codexEntry), '0.161.0');
  assert.equal(versionOfPath(data, 'codex', 'C:/elsewhere/codex.js'), undefined);
  } finally { await cleanup(data); }
});

async function cleanup(data:string){
  const target=path.resolve(data),relative=path.relative(path.resolve(os.tmpdir()),target);
  assert.ok(relative.startsWith('airoom-members-')&&!relative.includes(path.sep),'checked test directory');
  await rm(target,{recursive:true,force:true});
}
async function tree(prefix:string,member:'codex'|'claude'|'dsh',version:string,dependency=true){
  const pkg=MEMBER_PACKAGES[member],directory=path.join(prefix,'node_modules',...pkg.split('/'));
  await mkdir(directory,{recursive:true});
  await writeFile(path.join(directory,'package.json'),JSON.stringify({name:pkg,version,bin:{[member]:'cli.cjs'}}));
  await writeFile(path.join(directory,'cli.cjs'),`console.log('${version}')`);
  await writeFile(path.join(prefix,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{['node_modules/'+pkg]:{version},'node_modules/required-peer':{version:'1.0.0'}}}));
  if(dependency){await mkdir(path.join(prefix,'node_modules/required-peer'),{recursive:true});await writeFile(path.join(prefix,'node_modules/required-peer/package.json'),JSON.stringify({name:'required-peer',version:'1.0.0'}));}
  return path.join(directory,'cli.cjs');
}
const env={...process.env,AIROOM_NODE_EXE:process.execPath};
const runner=(action:(prefix:string)=>Promise<void>):NpmRunner=>async(args)=>{await action(args[args.indexOf('--prefix')+1]);return {code:0,stdout:'',stderr:''};};

function openPipes(){
  return Object.assign(new EventEmitter(),{exitCode:null as number|null,signalCode:null as NodeJS.Signals|null,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()}) as unknown as ChildProcess;
}
test('npm exit settles with trailing output even when inherited pipes never close',{timeout:5000},async()=>{
  const child=openPipes(),result=waitForNpmOutput(child,500,async()=>assert.fail('an exited process must not be stopped'));
  (child.stdout as PassThrough).write('before ');Object.assign(child,{exitCode:0});child.emit('exit',0,null);(child.stdout as PassThrough).write('after');
  assert.deepEqual(await result,{code:0,stdout:'before after',stderr:''});
});
test('npm timeout settles after a confirmed stop without requiring a pipe close',{timeout:5000},async()=>{
  const child=openPipes();let stops=0;
  const result=waitForNpmOutput(child,20,async()=>{stops++;Object.assign(child,{signalCode:'SIGTERM'});child.emit('exit',null,'SIGTERM');});
  await assert.rejects(result,/npm 操作超时/);assert.equal(stops,1);
});
test('an unconfirmed installer stop preserves its staging directory and the previous version',{timeout:5000},async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'airoom-members-')),child=openPipes();
  try{
    await tree(path.join(data,'members/claude/2.1.288'),'claude','2.1.288');
    const npm:NpmRunner=async args=>{await tree(args[args.indexOf('--prefix')+1],'claude','2.1.292');return waitForNpmOutput(child,20,async()=>{throw new Error('owned process still running');});};
    await assert.rejects(installVersion(data,'claude','2.1.292',env,{npm}),/停止未确认.*临时目录已保留/);
    assert.deepEqual(installedVersions(data,'claude').map(item=>item.version),['2.1.288']);
    assert.ok((await readdir(path.join(data,'members/claude'))).some(item=>item.startsWith('.install-')));
  }finally{child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy();await cleanup(data);}
});
test('installation reports growing staging files, file validation and launch before exposing the candidate',{timeout:15000},async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'airoom-members-'));let release!:()=>void;
  try{
    const progress:InstallProgress[]=[],gate=new Promise<void>(resolve=>release=resolve);
    const installing=installVersion(data,'codex','0.161.0',env,{progress:value=>progress.push(value),npm:runner(async prefix=>{
      await writeFile(path.join(prefix,'download.bin'),Buffer.alloc(2*1024*1024));await gate;await tree(prefix,'codex','0.161.0');
    })});
    const deadline=Date.now()+6000;
    while(!progress.some(value=>(value.writtenBytes??0)>=2*1024*1024)){
      assert.ok(Date.now()<deadline,'download progress should arrive while npm is still running');await new Promise(resolve=>setTimeout(resolve,30));
    }
    assert.deepEqual(installedVersions(data,'codex'),[]);assert.ok(progress.at(-1)?.lastProgressAt);
    release();await installing;
    assert.deepEqual([...new Set(progress.map(value=>value.phase))],['installing','files','launch']);
    assert.deepEqual(installedVersions(data,'codex').map(item=>item.version),['0.161.0']);
    const count=progress.length;await new Promise(resolve=>setTimeout(resolve,2100));assert.equal(progress.length,count,'completed installations stop publishing download progress');
  }finally{release?.();await cleanup(data);}
});

test('installs stay hidden until dependencies and the actual CLI launch are verified, preserving the previous version',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'airoom-members-'));
  try{
    const old=await fakeInstall(data,'codex','0.160.0','@openai/codex',{codex:'bin/codex.js'});
    let reached=false;
    const result=await installVersion(data,'codex','0.161.0',env,{npm:runner(async prefix=>{
      assert.match(path.basename(prefix),/^\.install-/);await tree(prefix,'codex','0.161.0');
      assert.deepEqual(installedVersions(data,'codex').map(x=>x.version),['0.160.0']);reached=true;
    })});
    assert.ok(reached);assert.equal(versionOfPath(data,'codex',old),'0.160.0');
    assert.equal(versionOfPath(data,'codex',result.entry),'0.161.0');
    const marker=JSON.parse(await readFile(path.join(data,'members/codex/0.161.0/.airoom-install.json'),'utf8'));
    assert.equal(marker.version,'0.161.0');assert.match(marker.lockSha256,/^[0-9a-f]{64}$/);
    assert.ok(!(await readdir(path.join(data,'members/codex'))).some(x=>x.startsWith('.install-')));
  }finally{await cleanup(data);}
});

test('npm failure, timeout, missing peer and failed launch clean staging directories and never replace a working version',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'airoom-members-'));
  try{
    await tree(path.join(data,'members/dsh/0.2.0-rc.2'),'dsh','0.2.0-rc.2');
    for(const mode of ['npm','timeout','peer','launch'] as const){
      const npm:NpmRunner=async args=>{
        const prefix=args[args.indexOf('--prefix')+1];await tree(prefix,'dsh','0.2.0-rc.3',mode!=='peer');
        if(mode==='timeout')throw new Error('npm 操作超时');
        if(mode==='launch')await writeFile(path.join(prefix,'node_modules/@deepseek-ai/dsh/cli.cjs'),'process.exit(9)');
        return {code:mode==='npm'?1:0,stdout:'',stderr:'fixture failure'};
      };
      await assert.rejects(installVersion(data,'dsh','0.2.0-rc.3',env,{npm}));
      assert.deepEqual(installedVersions(data,'dsh').map(x=>x.version),['0.2.0-rc.2']);
      assert.deepEqual(await readdir(path.join(data,'members/dsh')),['0.2.0-rc.2']);
    }
  }finally{await cleanup(data);}
});

test('a partial legacy directory is reinstalled and concurrent installers cannot race',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'airoom-members-'));
  try{
    await tree(path.join(data,'members/codex/0.161.0'),'codex','0.161.0',false);
    assert.equal(installedVersions(data,'codex').length,0);
    let release!:()=>void,entered!:()=>void;const begun=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
    const installation=installVersion(data,'codex','0.161.0',env,{npm:runner(async prefix=>{entered();await gate;await tree(prefix,'codex','0.161.0');})});
    await begun;
    await assert.rejects(installVersion(data,'codex','0.162.0',env,{npm:runner(async()=>{})}),/正在安装/);
    release();await installation;assert.equal(installedVersions(data,'codex').length,1);
    await installVersion(data,'codex','0.161.0',env,{npm:runner(async()=>assert.fail('a complete working install should be reused'))});
  }finally{await cleanup(data);}
});

test('version removal refuses a junction leading outside the member directory',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'airoom-members-'));
  try{
    const outside=path.join(data,'outside');await mkdir(outside);await writeFile(path.join(outside,'keep.txt'),'keep');
    await mkdir(path.join(data,'members/codex'),{recursive:true});await symlink(outside,path.join(data,'members/codex/0.161.0'),'junction');
    await assert.rejects(removeVersion(data,'codex','0.161.0'),/目录链接/);
    assert.equal(await readFile(path.join(outside,'keep.txt'),'utf8'),'keep');
  }finally{await cleanup(data);}
});


test('Claude project installs use an exact candidate manifest policy, keep its setup enabled and preserve the previous version',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'airoom-members-'));
  try{
    await tree(path.join(data,'members/claude/2.1.288'),'claude','2.1.288');
    let reached=false;
    const npm:NpmRunner=async(args,_env,cwd)=>{
      assert.ok(!args.some(arg=>arg.startsWith('--allow-scripts')||arg.startsWith('--ignore-scripts')||arg.startsWith('--dangerously-allow-all-scripts')));
      const prefix=args[args.indexOf('--prefix')+1];assert.equal(prefix,cwd);
      const policy=JSON.parse(await readFile(path.join(prefix,'package.json'),'utf8'));
      assert.equal(policy.private,true);assert.deepEqual(policy.allowScripts,{'@anthropic-ai/claude-code@2.1.292':true});
      await tree(prefix,'claude','2.1.292');reached=true;return {code:0,stdout:'',stderr:''};
    };
    const result=await installVersion(data,'claude','2.1.292',env,{npm});
    assert.ok(reached);assert.equal(result.version,'2.1.292');
    assert.deepEqual(installedVersions(data,'claude').map(item=>item.version),['2.1.288','2.1.292']);
  }finally{await cleanup(data);}
});


test('real npm accepts a project-scoped script policy and honors an explicit setup denial', {timeout:90000,skip:!existsSync(path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'))},async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'airoom-members-'));let registry:ReturnType<typeof createServer>|undefined;
  try{
    const fixture=path.join(data,'fixture'),archives=path.join(data,'archives');await mkdir(fixture);await mkdir(archives);
    const pkg={name:MEMBER_PACKAGES.claude,version:'99.0.0',bin:{claude:'cli.cjs'},scripts:{postinstall:'node setup.cjs'}};
    await writeFile(path.join(fixture,'package.json'),JSON.stringify(pkg));
    await writeFile(path.join(fixture,'cli.cjs'),"console.log('99.0.0')");
    await writeFile(path.join(fixture,'setup.cjs'),"require('node:fs').writeFileSync('setup-ran.txt','candidate only')");
    const config=path.join(data,'test.npmrc'),globalConfig=path.join(data,'global.npmrc');await writeFile(config,'');await writeFile(globalConfig,'');
    const localEnv={...env,npm_config_cache:path.join(data,'cache'),npm_config_userconfig:config,npm_config_globalconfig:globalConfig,npm_config_ignore_scripts:'false',npm_config_dangerously_allow_all_scripts:'false',npm_config_noproxy:'127.0.0.1'};
    const packed=await runNpm(['pack',fixture,'--pack-destination',archives,'--ignore-scripts','--json','--offline','--registry=http://127.0.0.1:1'],localEnv,data,60000);
    assert.equal(packed.code,0,packed.stderr);const packedFiles=JSON.parse(packed.stdout);const packedFile=Array.isArray(packedFiles)?packedFiles[0]:packedFiles[pkg.name];assert.ok(packedFile?.filename,'npm pack must report its archive');const archive=await readFile(path.join(archives,packedFile.filename));
    let base='';const archivePath='/@anthropic-ai/claude-code/-/claude-code-99.0.0.tgz';
    registry=createServer((req,res)=>{
      if(decodeURIComponent(req.url??'')===archivePath){res.setHeader('Content-Type','application/octet-stream');res.end(archive);return;}
      if(decodeURIComponent(req.url??'')==='/@anthropic-ai/claude-code'){
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({name:pkg.name,'dist-tags':{latest:pkg.version},versions:{[pkg.version]:{...pkg,dist:{tarball:base+archivePath,integrity:'sha512-'+createHash('sha512').update(archive).digest('base64')}}}}));return;
      }
      res.statusCode=404;res.end();
    });
    await new Promise<void>(resolve=>registry!.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+(registry.address() as {port:number}).port;
    const localRegistry=['--registry='+base,'--fetch-retries=0'];
    const npm:NpmRunner=(args,currentEnv,cwd,timeout)=>runNpm(args.concat(localRegistry),currentEnv,cwd,timeout);
    const installed=await installVersion(data,'claude','99.0.0',localEnv,{npm});
    assert.equal(await readFile(path.join(path.dirname(installed.entry),'setup-ran.txt'),'utf8'),'candidate only');
    const denied=path.join(data,'denied');await mkdir(denied);
    await writeFile(path.join(denied,'package.json'),JSON.stringify({name:'airoom-policy-fixture',private:true,allowScripts:{'@anthropic-ai/claude-code@99.0.0':false}}));
    const result=await runNpm(['install','@anthropic-ai/claude-code@99.0.0','--prefix',denied,'--no-audit','--no-fund',...localRegistry],localEnv,denied,60000);
    assert.equal(result.code,0,result.stderr);assert.equal(existsSync(path.join(denied,'node_modules/@anthropic-ai/claude-code/setup-ran.txt')),false,'npm reads and applies the manifest policy');
  }finally{if(registry)await new Promise<void>(resolve=>registry!.close(()=>resolve()));await cleanup(data);}
});
