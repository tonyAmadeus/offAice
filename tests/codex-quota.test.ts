import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodexAdapter } from '../src/backend/adapters/codex';
import { Engine } from '../src/backend/engine';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';
import { quotaReport, mergeQuota } from '../src/shared/quota';
import type { Adapter, ProviderInfo } from '../src/shared/types';

const sample={rateLimits:{primary:{usedPercent:31,windowDurationMins:300},secondary:{usedPercent:7,windowDurationMins:10080}}};
const provider:ProviderInfo={id:'codex',name:'Codex',available:true,auth:'subscription',detail:'synthetic account',capabilities:{steer:false,cancel:'native',streaming:true,write:true,history:true}};
const fakeServer=`const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const m=JSON.parse(line);if(!m.method)return;
fs.appendFileSync(path.join(__dirname,'requests.jsonl'),JSON.stringify({method:m.method,params:m.params})+'\\n');
const reply=result=>process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
if(m.method==='initialize')reply({userAgent:'fixture'});
else if(m.method==='account/read')reply({account:{type:'chatgpt',planType:'pro'}});
else if(m.method==='config/read')reply({config:{model_provider:'openai'}});
else if(m.method==='account/rateLimits/read'){
if(process.env.FAKE_QUOTA==='offline'||process.env.FAKE_QUOTA==='signed-out')process.stdout.write(JSON.stringify({id:m.id,error:{code:process.env.FAKE_QUOTA==='signed-out'?401:503,message:process.env.FAKE_QUOTA==='signed-out'?'Unauthorized':'Service unavailable'}})+'\\n');
else reply(${JSON.stringify(sample)});
}else if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,error:{code:-32601,message:'Unexpected account operation'}})+'\\n');
});`;

for(const state of ['ready','offline','signed-out'])test(`Codex manual quota query is read-only and reports ${state} truthfully`,async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM codex-quota-'));
  try{
    const command=path.join(directory,'codex.cjs');await writeFile(command,fakeServer);
    const env={...process.env,AIROOM_APP_ROOT:directory,AIROOM_CODEX_HOME:path.join(directory,'home'),FAKE_QUOTA:state};
    const result=await new CodexAdapter().accountQuota({...DEFAULT_SETTINGS,paths:{codex:command}},env);
    const report=quotaReport('codex',result.payload,result.checkedAt,'probe')!;
    assert.equal(report.queryStatus,state==='ready'?'ready':'unavailable');
    assert.deepEqual(report.windows.map(item=>item.usedPercent),state==='ready'?[31,7]:[]);
    assert.equal(Boolean(result.signedOut),state==='signed-out');
    const requests=(await readFile(path.join(directory,'requests.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(requests.every(item=>['initialize','initialized','account/read','config/read','account/rateLimits/read'].includes(item.method)));
    assert.ok(requests.filter(item=>item.method==='account/read').every(item=>item.params.refreshToken===false));
    assert.equal(requests.filter(item=>item.method==='account/rateLimits/read').length,1);
  }finally{assert.ok(path.basename(directory).startsWith('AIROOM codex-quota-'));await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('Codex unavailable full samples clear stale percentages without turning unknown values into zero',()=>{
  const at=new Date().toISOString(),previous=quotaReport('codex',sample,at,'event')!;
  const unavailable=quotaReport('codex',{accountRateLimits:null},at,'probe')!;
  assert.equal(unavailable.queryStatus,'unavailable');assert.deepEqual(mergeQuota(previous,unavailable).windows,[]);
});

test('Codex quota refresh deduplicates, preserves connectivity and drops an invalidated late reply',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM codex-quota-engine-'));let reads=0,probes=0,resolve!:(value:any)=>void;
  const adapter:Adapter={probe:async()=>{probes++;return provider;},accountQuota:async()=>{reads++;return new Promise(done=>{resolve=done;});},start:async()=>{assert.fail('quota refresh must never call a model');},stop:async()=>{}};
  const engine=new Engine(directory,()=>{},()=>{},()=>adapter);
  try{
    await engine.probe('codex');
    const first=engine.invoke('provider.quota',{provider:'codex'}),second=engine.invoke('provider.quota',{provider:'codex'});assert.equal(reads,1);
    resolve({payload:{accountRateLimits:sample},checkedAt:new Date().toISOString()});await Promise.all([first,second]);assert.equal(engine.snapshot().quotas?.codex?.windows[0].usedPercent,31);assert.equal(probes,1);
    const late=engine.invoke('provider.quota',{provider:'codex'});await engine.invoke('internal.provider.invalidate',{provider:'codex'});
    resolve({payload:{accountRateLimits:sample},checkedAt:new Date().toISOString()});await late;
    assert.deepEqual(engine.snapshot().quotas?.codex?.windows,[]);assert.equal(reads,2);assert.equal(probes,1);
  }finally{await engine.close();await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('an account file changed during a Codex refresh cannot receive the old account sample',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM codex-quota-switch-')),home=process.env.AIROOM_CODEX_HOME!;
  assert.ok(home,'test bootstrap must isolate the Codex account');await mkdir(home,{recursive:true});const auth=path.join(home,'auth.json');await writeFile(auth,'synthetic prior account');
  let resolve!:(value:any)=>void;
  const adapter:Adapter={probe:async()=>provider,accountQuota:async()=>new Promise(done=>{resolve=done;}),start:async()=>{assert.fail('no model turn');},stop:async()=>{}};
  const engine=new Engine(directory,()=>{},()=>{},()=>adapter);
  try{
    const pending=engine.invoke('provider.quota',{provider:'codex'});await writeFile(auth,'synthetic replacement account with different content');
    resolve({payload:{accountRateLimits:sample},checkedAt:new Date().toISOString()});await pending;
    assert.equal(engine.snapshot().quotas?.codex,undefined);
  }finally{await engine.close();await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});await rm(auth,{force:true});}
});
