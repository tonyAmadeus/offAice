import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {access,mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {renameWithWindowsRetry} from '../src/backend/filesystem';

async function heldFile(file:string,releaseAfter?:number){
  const quoted=file.replaceAll("'","''"),wait=releaseAfter===undefined?'[Console]::ReadLine() | Out-Null':`Start-Sleep -Milliseconds ${releaseAfter}`;
  const child=spawn('powershell.exe',['-NoProfile','-Command',`$file=[IO.File]::Open('${quoted}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);try{[Console]::WriteLine('locked');${wait}}finally{$file.Dispose()}`],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const done=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Lock holder exited '+code)));});
  await new Promise<void>((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Lock holder did not acquire file')),10000);child.stdout.on('data',chunk=>{text+=chunk;if(text.includes('locked')){clearTimeout(timer);resolve();}});done.catch(error=>{clearTimeout(timer);reject(error);});});
  return {release:async()=>{child.stdin.end('\n');await done;},done};
}
async function dispose(root:string){assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('AIROOM-rename-'));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}

test('a real Windows sharing lock can expire without losing a renamed backup directory',{skip:process.platform!=='win32'},async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM-rename-')),source=path.join(root,'partial'),target=path.join(root,'published');let lock:Awaited<ReturnType<typeof heldFile>>|undefined;
  try{await mkdir(source);await writeFile(path.join(source,'payload.txt'),'exact payload');lock=await heldFile(path.join(source,'payload.txt'),350);const start=Date.now();await renameWithWindowsRetry(source,target);await lock.done;assert.ok(Date.now()-start>=250);assert.equal(await readFile(path.join(target,'payload.txt'),'utf8'),'exact payload');await assert.rejects(access(source));}
  finally{await lock?.release();await dispose(root);}
});

test('a persistent real Windows sharing lock stops within its bound and keeps the source',{skip:process.platform!=='win32'},async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM-rename-')),source=path.join(root,'original.txt'),target=path.join(root,'moved.txt');let lock:Awaited<ReturnType<typeof heldFile>>|undefined;
  try{await writeFile(source,'keep original');lock=await heldFile(source);const start=Date.now();await assert.rejects(renameWithWindowsRetry(source,target),error=>['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??''));assert.ok(Date.now()-start<6500);await lock.release();lock=undefined;assert.equal(await readFile(source,'utf8'),'keep original');await assert.rejects(access(target));}
  finally{await lock?.release();await dispose(root);}
});
