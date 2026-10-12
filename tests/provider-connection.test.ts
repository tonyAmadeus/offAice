import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Engine } from './helpers/seeded-engine';
import type { Adapter, AdapterResult, ProviderInfo, Run } from '../src/shared/types';

const info=(available=false,auth:ProviderInfo['auth']='unknown'):ProviderInfo=>({id:'codex',name:'Codex',available,auth,detail:available?'connected':'workspace routing discovery failed',capabilities:{steer:true,cancel:'native',streaming:true,write:true,history:true}});
async function fixture(probe:()=>Promise<ProviderInfo>|ProviderInfo,result:AdapterResult={},retryMs=15){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM-provider-status-')),source=path.join(directory,'project');await fs.mkdir(source);
  const adapter:Adapter={probe:async()=>probe(),start:async ctx=>{ctx.markDelivery('confirmed');ctx.emit('message','verified native reply',{source:'assistant'});return result;},stop:async()=>{}};
  const engine=new Engine(path.join(directory,'data'),()=>{},()=>{},()=>adapter,{providerRetryMs:retryMs});
  const project=await engine.invoke('project.create',{directory:source}) as {id:string};
  return {engine,project,dispose:async()=>{await engine.close();assert.ok(path.basename(directory).startsWith('AIROOM-provider-status-'));await fs.rm(directory,{recursive:true,force:true});}};
}
const wait=async(check:()=>boolean)=>{for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('provider state did not settle');};

test('a transient discovery failure automatically retries once and recovers',async()=>{
  let calls=0;const f=await fixture(()=>++calls===1?info():info(true,'subscription'));
  try{await f.engine.probe('codex');assert.ok(f.engine.snapshot().providers[0].connectionCheck?.retryAt);await wait(()=>f.engine.snapshot().providers[0].available);assert.equal(calls,2);assert.equal(f.engine.snapshot().providers[0].connectionCheck?.retryAttempt,1);}finally{await f.dispose();}
});
test('a second failed check stops retrying; missing login is not retried',async()=>{
  for(const auth of ['unknown','none'] as const){let calls=0;const f=await fixture(()=>{calls++;return info(false,auth);});try{await f.engine.probe('codex');await new Promise(resolve=>setTimeout(resolve,85));assert.equal(calls,auth==='unknown'?2:1);assert.equal(f.engine.snapshot().providers[0].available,false);}finally{await f.dispose();}}
});
test('a verified reply supersedes a late failed probe without refreshing its old quota',async()=>{
  let calls=0,resolve!:(value:ProviderInfo)=>void;const f=await fixture(()=>++calls===1?{...info(),quota:{rateLimits:{primary:{usedPercent:40,windowDurationMins:300}}}}:new Promise<ProviderInfo>(done=>{resolve=done;}),{},60_000);
  try{
    await f.engine.probe('codex');const checked=f.engine.snapshot().quotas?.codex?.checkedAt;
    const probing=f.engine.probe('codex');await wait(()=>calls===2);
    const session=f.engine.createSession(f.project.id,'codex',undefined,false),sent=await f.engine.send(session.id,'reply') as {runId:string};await wait(()=>f.engine.snapshot().providers[0].connectionCheck?.source==='run');
    resolve(info());await probing;assert.equal(f.engine.snapshot().providers[0].available,true);assert.equal(f.engine.snapshot().providers[0].connectionCheck?.runId,sent.runId);assert.equal(f.engine.snapshot().quotas?.codex?.checkedAt,checked);
  }finally{await f.dispose();}
});
for(const result of [{unknown:true},{stopped:true},{failure:{kind:'rate_limited',message:'limited'}}] as AdapterResult[])test(`an unconfirmed or stopped outcome does not mark the provider connected: ${JSON.stringify(result)}`,async()=>{
  const f=await fixture(()=>info(),result,60_000);try{await f.engine.probe('codex');const session=f.engine.createSession(f.project.id,'codex',undefined,false),sent=await f.engine.send(session.id,'reply') as {runId:string};await wait(()=>Boolean(f.engine.store.get<Run>('runs',sent.runId)?.completedAt));assert.equal(f.engine.snapshot().providers[0].available,false);}finally{await f.dispose();}
});
test('account invalidation and shutdown cancel outstanding retries',async()=>{
  let calls=0;const f=await fixture(()=>{calls++;return info();}, {},35);try{await f.engine.probe('codex');await f.engine.invoke('internal.provider.invalidate',{provider:'codex'});await new Promise(resolve=>setTimeout(resolve,60));assert.equal(calls,1);await f.engine.probe('codex');await f.engine.close();await new Promise(resolve=>setTimeout(resolve,60));assert.equal(calls,2);}finally{await f.dispose();}
});
