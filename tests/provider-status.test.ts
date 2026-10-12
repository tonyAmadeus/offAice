import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {Engine} from './helpers/seeded-engine';
import type {Adapter,AdapterContext,ProviderId,ProviderInfo,Run} from '../src/shared/types';
const cache=path.resolve('.test-cache');
function info(id:ProviderId):ProviderInfo{return {id,name:id,available:true,auth:'subscription',detail:'fixture',capabilities:{steer:false,cancel:'process',streaming:true,write:true,history:true}};}

test('model and effort selections preserve the observed connection without launching an account probe',async()=>{
  for(const available of [true,false]){
    await mkdir(cache,{recursive:true});const directory=await mkdtemp(path.join(cache,'provider-model-'));let calls=0;
    const engine=new Engine(directory,()=>{},()=>{},id=>({probe:async()=>{calls++;return {...info(id),available,auth:available?'subscription':'unknown'};},start:async()=>({}),stop:async()=>{}}),{providerRetryMs:60_000});
    try{
      await engine.probe();const before=engine.snapshot().providers,checked=calls;
      await engine.invoke('settings.save',{settings:{models:{codex:'gpt-6-luna'},efforts:{codex:'high'}}});
      await engine.invoke('settings.save',{settings:{efforts:{codex:'low'}}});
      assert.deepEqual(engine.snapshot().providers,before,'neither a confirmed connection nor a failed check is rewritten by selecting a model');
      assert.equal(engine.settings.models.codex,'gpt-6-luna');assert.equal(engine.settings.efforts.codex,'low');assert.equal(calls,checked);
    }finally{await engine.close();assert.ok(directory.startsWith(cache+path.sep));await rm(directory,{recursive:true,force:true});}
  }
});

test('a model switch retires only its executor runtime and the next run uses the new model',async()=>{
  await mkdir(cache,{recursive:true});const directory=await mkdtemp(path.join(cache,'provider-runtime-'));const probes:ProviderId[]=[],closed:ProviderId[]=[],starts:{id:ProviderId;adapter:Adapter;model?:string;effort?:string}[]=[];
  const engine=new Engine(directory,()=>{},()=>{},id=>{
    let reusable=false;const adapter:Adapter={supportsRuntimeReuse:true,canReuse:()=>reusable,
      probe:async()=>{probes.push(id);return info(id);},start:async(ctx:AdapterContext)=>{starts.push({id,adapter,model:ctx.settings.models[id],effort:ctx.settings.efforts[id]});reusable=true;ctx.markDelivery('confirmed');ctx.emit('message','verified native reply',{source:'assistant'});return {};},
      stop:async()=>{reusable=false;},dispose:async()=>{closed.push(id);reusable=false;}};return adapter;
  });
  const wait=async(check:()=>boolean)=>{for(let i=0;i<400;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('runtime state did not settle');};
  try{
    await engine.probe();
    const sessions:Record<string,string>={};for(const id of ['codex','claude'])sessions[id]=(await (engine as any).loungeSession(engine.store.members().find(m=>m.id===id))).id;
    const send=async(id:ProviderId)=>{const result=await engine.send(sessions[id],'hello') as {runId:string};await wait(()=>engine.store.get<Run>('runs',result.runId)?.status==='ended'&&(engine as any).active.size===0);};
    await send('codex');await send('claude');const firstCodex=starts.find(s=>s.id==='codex')!,firstClaude=starts.find(s=>s.id==='claude')!,count=probes.length;
    await engine.invoke('settings.save',{settings:{models:{codex:'gpt-6-luna'},efforts:{codex:'high'}}});
    assert.deepEqual(closed,['codex']);assert.equal(probes.length,count);
    await send('codex');await send('claude');
    const lastCodex=starts.filter(s=>s.id==='codex').at(-1)!;assert.notEqual(lastCodex.adapter,firstCodex.adapter);assert.equal(lastCodex.model,'gpt-6-luna');assert.equal(lastCodex.effort,'high');
    assert.equal(starts.filter(s=>s.id==='claude').at(-1)!.adapter,firstClaude.adapter);assert.deepEqual(closed,['codex']);
  }finally{await engine.close();assert.ok(directory.startsWith(cache+path.sep));await rm(directory,{recursive:true,force:true});}
});

test('saving ordinary settings retains results and restart retains last confirmation while refresh is pending',async()=>{
  await mkdir(cache,{recursive:true});const directory=await mkdtemp(path.join(cache,'provider-state-'));let engine:Engine|undefined;
  const factory=(id:ProviderId)=>({probe:async()=>info(id),start:async()=>({}),stop:async()=>{}} as Adapter);
  try{
    engine=new Engine(directory,()=>{},()=>{},factory);await engine.probe();const before=engine.snapshot().providers;
    await engine.invoke('settings.save',{settings:{maxParallel:3}});assert.deepEqual(engine.snapshot().providers,before);
    await engine.close();engine=new Engine(directory,()=>{},()=>{},factory);
    assert.equal(engine.snapshot().providers.length,3,'Codex, Claude and DSH; the DeepSeek API stand-in is retired');assert.ok(engine.snapshot().providers.every(item=>item.stale&&item.checkedAt));
    assert.equal(engine.snapshot().providers[0].checkedAt,before[0].checkedAt);
    await engine.probe();assert.ok(engine.snapshot().providers.every(item=>item.stale===false));
  }finally{await engine?.close();assert.ok(directory.startsWith(cache+path.sep));await rm(directory,{recursive:true,force:true});}
});

test('only affected members refresh and a queued new check supersedes the old settings', {timeout:10000},async()=>{
  await mkdir(cache,{recursive:true});const directory=await mkdtemp(path.join(cache,'provider-race-'));const calls:ProviderId[]=[];let release!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve);let hold=false;
  const engine=new Engine(directory,()=>{},()=>{},id=>({probe:async settings=>{calls.push(id);const file=settings.paths[id];if(hold&&id==='codex'&&!file)await gate;return {...info(id),path:file};},start:async()=>({}),stop:async()=>{}}));
  try{
    await engine.probe();calls.length=0;hold=true;const old=engine.probe('codex');
    await engine.invoke('settings.save',{settings:{paths:{codex:'new-cli'}}});
    const newer=engine.probe('codex');
    assert.equal(calls.length,1,'new settings wait until the previous native-home check finishes');
    release();await Promise.all([old,newer]);
    assert.equal(engine.snapshot().providers.find(item=>item.id==='codex')?.path,'new-cli');assert.ok(calls.every(id=>id==='codex'));
    assert.equal(engine.snapshot().providers.find(item=>item.id==='claude')?.stale,false);
  }finally{release();await engine.close();assert.ok(directory.startsWith(cache+path.sep));await rm(directory,{recursive:true,force:true});}
});

test('overlapping checks of the same configuration share one native probe instead of racing its fresh home',async()=>{
  await mkdir(cache,{recursive:true});const directory=await mkdtemp(path.join(cache,'provider-overlap-'));let release!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve);let calls=0;
  const engine=new Engine(directory,()=>{},()=>{},id=>({probe:async()=>{calls++;await gate;return info(id);},start:async()=>({}),stop:async()=>{}}));
  try{
    const startup=engine.probe('codex'),manual=engine.probe('codex');
    assert.equal(calls,1,'startup and the manual check must not launch two app-servers against the same fresh SQLite/home');
    release();await Promise.all([startup,manual]);
    assert.equal(engine.snapshot().providers.length,1);assert.equal(engine.snapshot().providers[0].auth,'subscription');
    await engine.probe('codex');assert.equal(calls,2,'a later explicit check still refreshes authentication');
  }finally{release();await engine.close();assert.ok(directory.startsWith(cache+path.sep));await rm(directory,{recursive:true,force:true});}
});
