import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnOwned,stopOwned} from '../src/backend/process-supervisor';

async function fixture(){
  const directory=await mkdtemp(path.join(os.tmpdir(),'airoom-owned-exit-'));
  const child=spawnOwned(process.execPath,['-e','process.stdout.write("READY\\n");setInterval(()=>{},1000)'],{cwd:directory,env:{...process.env,AIROOM_APP_ROOT:process.cwd()}});
  if(child.pid===undefined)await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  const close=new Promise<void>(resolve=>child.once('close',()=>resolve()));
  await new Promise<void>((resolve,reject)=>{let output='',error='';const fail=()=>reject(new Error('process guard exited before the test child started: '+error));child.once('exit',fail);child.stderr?.on('data',chunk=>{error+=String(chunk);});child.stdout?.on('data',chunk=>{output+=String(chunk);if(output.includes('READY\n')){child.removeListener('exit',fail);resolve();}});});
  return {child,close,cleanup:async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await close;const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('airoom-owned-exit-'));await rm(target,{recursive:true,force:true});}};
}

test('an owned process exit confirms stopping even if redirected streams delay close', {timeout:10000},async()=>{
  const f=await fixture(),emit=f.child.emit;let closeArgs:any[]|undefined;
  f.child.emit=function(event:string|symbol,...args:any[]){if(event==='close'){closeArgs=args;return true;}return emit.call(this,event,...args);};
  try{
    await stopOwned(f.child,300);
    assert.ok(f.child.exitCode!==null||f.child.signalCode!==null,'the actual child emitted exit');
  }finally{
    f.child.emit=emit;if(closeArgs)f.child.emit('close',...closeArgs);await f.cleanup();
  }
});

test('a successful kill request without an exit does not confirm stopping', {timeout:10000,skip:process.platform!=='win32'},async()=>{
  const f=await fixture(),kill=f.child.kill;
  f.child.kill=()=>true;
  try{await assert.rejects(stopOwned(f.child,100),/停止尚未得到确认/);assert.equal(f.child.exitCode,null);assert.equal(f.child.signalCode,null);}
  finally{f.child.kill=kill;await f.cleanup();}
});

test('a delayed forced exit is confirmed before the owned process is reported unknown', {timeout:10000,skip:process.platform!=='win32'},async()=>{
  const f=await fixture(),kill=f.child.kill;let requests=0;
  f.child.kill=(signal)=>{requests++;if(signal==='SIGKILL')setTimeout(()=>kill.call(f.child,signal),150);return true;};
  try{await stopOwned(f.child,100);assert.equal(requests,2);assert.ok(f.child.exitCode!==null||f.child.signalCode!==null,'a real exit arrived after force was requested');}
  finally{f.child.kill=kill;await f.cleanup();}
});
