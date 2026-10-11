import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {productionPackages,verifyRuntimeDependencies} from '../scripts/runtime-dependencies.mjs';

test('dependency selection includes production peers and nested versions while excluding development and other platforms',()=>{
  const lock={packages:{'':{},'node_modules/a':{version:'1'},'node_modules/a/node_modules/peer':{version:'2',peer:true},'node_modules/dev':{dev:true},'node_modules/linux':{os:['linux']},'node_modules/no-windows':{os:['!win32']}}};
  assert.deepEqual(productionPackages(lock).map(([name])=>name),['node_modules/a','node_modules/a/node_modules/peer']);
});

test('both build and deployment checks reject missing or wrong nested production packages',async()=>{
  const cache=path.resolve('.test-cache');await mkdir(cache,{recursive:true});const root=await mkdtemp(path.join(cache,'dependency-check-'));
  const name='node_modules/a/node_modules/peer';const pkg=Buffer.from(JSON.stringify({name:'peer',version:'2'}));const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
  const lock=Buffer.from(JSON.stringify({packages:{[name]:{version:'2',peer:true}}}));
  const check=()=>spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/verify-runtime-dependencies.ps1'),'-AppRoot',root],{encoding:'utf8',timeout:15000});
  try{
    await mkdir(path.join(root,name),{recursive:true});await mkdir(path.join(root,'dist'));
    await writeFile(path.join(root,'package-lock.json'),lock);await writeFile(path.join(root,name,'package.json'),pkg);
    await writeFile(path.join(root,'dist/runtime-dependencies.json'),JSON.stringify({platform:'win32',arch:'x64',lockSha256:hash(lock),packages:[{path:name,version:'2',peer:true,packageJsonSha256:hash(pkg)}],excluded:[],equivalentFiles:[]}));
    assert.equal((await verifyRuntimeDependencies(root)).packages,1);const initial=check();assert.equal(initial.status,0,initial.stderr);
    await writeFile(path.join(root,name,'package.json'),JSON.stringify({version:'3'}));await assert.rejects(verifyRuntimeDependencies(root),/wrong version/);assert.notEqual(check().status,0);
    const target=path.join(root,name);assert.ok(target.startsWith(cache+path.sep));await rm(target,{recursive:true});
    await assert.rejects(verifyRuntimeDependencies(root),/Production dependencies incomplete/);assert.notEqual(check().status,0);
  }finally{assert.ok(root.startsWith(cache+path.sep));await rm(root,{recursive:true,force:true});}
});
