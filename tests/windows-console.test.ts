import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {collectCommand} from '../src/backend/adapters/common';

test('CLI checks hide asynchronous, synchronous and nested Windows helpers without losing output or exit status',{skip:process.platform!=='win32',timeout:60000},async()=>{
  const parent=path.resolve('.test-cache/windows-console');await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(path.join(parent,'run-'));
  const shell=path.join(process.env.SystemRoot!,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const probe=`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class ConsoleProbe{[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();}'
[ConsoleProbe]::GetConsoleWindow().ToInt64()`;
  const args=['-NoLogo','-NoProfile','-NonInteractive','-Command',probe];
  const shellCommand='"'+shell+'" -NoLogo -NoProfile -NonInteractive -EncodedCommand '+Buffer.from(probe,'utf16le').toString('base64');
  const script=path.join(directory,'checks.mjs'),nested=path.join(directory,'nested.mjs');
  await writeFile(nested,`import cp from 'node:child_process';const r=cp.spawnSync(${JSON.stringify(shell)},${JSON.stringify(args)},{encoding:'utf8',windowsHide:false});if(r.status!==0)throw new Error(r.stderr);console.log('nested:'+r.stdout.trim());`);
  await writeFile(script,`import cp from 'node:child_process';import {promisify} from 'node:util';
const file=${JSON.stringify(shell)},args=${JSON.stringify(args)};
const sync=cp.spawnSync(file,args,{encoding:'utf8',windowsHide:false});if(sync.status!==0)throw new Error(sync.stderr);console.log('spawnSync:'+sync.stdout.trim());
console.log('execFileSync:'+cp.execFileSync(file,args,{encoding:'utf8',windowsHide:false}).trim());
const asyncResult=await promisify(cp.execFile)(file,args,{windowsHide:false});console.log('execFile:'+asyncResult.stdout.trim());
console.log('execSync:'+cp.execSync(${JSON.stringify(shellCommand)},{encoding:'utf8',windowsHide:false}).trim());
const executed=await promisify(cp.exec)(${JSON.stringify(shellCommand)},{windowsHide:false});console.log('exec:'+executed.stdout.trim());
const child=cp.spawn(file,args,{windowsHide:false});let output='';child.stdout.on('data',data=>output+=data);if(await new Promise(resolve=>child.once('close',resolve))!==0)throw new Error('spawn failed');console.log('spawn:'+output.trim());
const nested=await promisify(cp.execFile)(process.execPath,[${JSON.stringify(nested)}],{env:{...process.env},windowsHide:false});console.log(nested.stdout.trim());
const fork=cp.fork(${JSON.stringify(nested)},[],{silent:true,windowsHide:false});let forkOutput='';fork.stdout.on('data',data=>forkOutput+=data);if(await new Promise(resolve=>fork.once('close',resolve))!==0)throw new Error('fork failed');console.log('fork:'+forkOutput.trim());
const failed=cp.spawnSync(process.execPath,['-e','process.exit(7)'],{windowsHide:false});console.log('exit:'+failed.status);
`);
  try{
    const result=await collectCommand({command:process.execPath,path:script,prefix:[script]},[],process.env,directory,55000);
    assert.equal(result.code,0,result.stderr);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/),['spawnSync:0','execFileSync:0','execFile:0','execSync:0','exec:0','spawn:0','nested:0','fork:nested:0','exit:7']);
  }finally{assert.equal(path.dirname(directory),parent);await rm(directory,{recursive:true,force:true});}
});
