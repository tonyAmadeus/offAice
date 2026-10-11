import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/backend/engine';
import { observeProgram, observeVersion } from '../src/backend/compatibility';
import { resolveCliEntry } from '../src/backend/adapters/common';
import type { Adapter, AdapterResult, ProviderInfo, Run } from '../src/shared/types';
import type { MemberVersions, MemberVersionUse } from '../src/shared/member-versions';
import type { CompatibilityReport } from '../src/shared/compatibility';

async function wait<T>(read:()=>T|false|undefined){for(let i=0;i<500;i++){const value=read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('run did not settle');}
async function fixture(version='9.0.0'){
  const root=await mkdtemp(path.join(os.tmpdir(),'airoom-version-status-')),source=path.join(root,'project');await mkdir(source);
  const makeEntry=async(name:string,version:string)=>{const dir=path.join(root,name);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'package.json'),JSON.stringify({version}));const entry=path.join(dir,'agent.mjs');await writeFile(entry,'fixture entry');return entry;};
  const entry=await makeEntry('first',version);let probeAvailable=true,mode='success',used:string[]=[];
  const adapter:Adapter={probe:async(settings,env)=>{
    const file=resolveCliEntry('codex',settings,env).path;observeProgram(file);
    return {id:'codex',name:'Codex',path:file,version,available:probeAvailable,auth:probeAvailable?'subscription':'unknown',detail:probeAvailable?'connected':'workspace routing discovery timed out',capabilities:{steer:true,cancel:'native',streaming:true,write:true,history:true}} as ProviderInfo;
  },start:async ctx=>{
    const file=ctx.settings.paths.codex!;observeProgram(file);observeVersion('codex-cli '+version);used.push(file);ctx.persistNativeSession('native-'+ctx.session.id,'airoom');
    if(mode!=='unconfirmed')ctx.markDelivery('confirmed');
    if(mode!=='empty')ctx.emit('message','native answer',{source:'assistant'},mode==='derived'?'derived':'native');
    ctx.recordConfig!({model:'observed-model',modelStatus:'reported',effort:'low',effortStatus:'reported',source:'fixture'});
    return mode==='unknown'?{unknown:true}:mode==='failed'?{failure:{kind:'failed',message:'native rejection'}}:mode==='stopped'?{stopped:true}:{} as AdapterResult;
  },stop:async()=>{}};
  const data=path.join(root,'data');let engine=new Engine(data,()=>{},()=>{},()=>adapter);
  await engine.invoke('settings.save',{paths:{codex:entry}});await engine.probe('codex',true);
  const project=await engine.invoke('project.create',{directory:source}) as {id:string};
  const session=()=>engine.createSession(project.id,'codex',undefined,false);
  const run=async(sessionId=session().id)=>{
    const {runId}=await engine.send(sessionId,'do the task') as {runId:string};
    return wait(()=>{const run=engine.store.get<Run>('runs',runId);return run?.completedAt&&engine.store.get<CompatibilityReport>('compatibility_reports',run.compatibilityReportId!)?.completedAt?run:undefined;});
  };
  return {root,entry,data,makeEntry,session,run,used,get engine(){return engine;},setProbeAvailable:(value:boolean)=>{probeAvailable=value;},setMode:(value:string)=>{mode=value;},versions:()=>engine.invoke('member.versions',{provider:'codex'}) as Promise<MemberVersions>,restart:async()=>{await engine.close();engine=new Engine(data,()=>{},()=>{},()=>adapter);},close:async()=>{await engine.close();assert.ok(path.basename(root).startsWith('airoom-version-status-'));await rm(root,{recursive:true,force:true});}};
}

test('a connection check does not claim successful use; a completed native task persists evidence across restart',async()=>{
  const f=await fixture();try{
    let state=await f.versions();assert.equal(state.connection.state,'connected');assert.equal(state.current,'9.0.0');assert.equal(state.successfulUse,undefined);assert.ok(!state.baselineVersions.includes('9.0.0'));
    const run=await f.run();assert.equal(run.status,'ended');state=await f.versions();assert.equal(state.successfulUse?.runId,run.id);assert.equal(state.successfulUse?.effectiveConfig?.model,'observed-model');assert.equal(state.connection.state,'connected');
    await f.restart();state=await f.versions();assert.equal(state.successfulUse?.runId,run.id);assert.equal(state.connection.state,'stale');
    await f.engine.probe('codex',true);assert.equal((await f.versions()).connection.state,'connected');
    f.setMode('failed');const failed=await f.run();state=await f.versions();assert.equal(failed.status,'failed');assert.equal(state.lastRun?.outcome,'failed');assert.equal(state.lastRun?.error,'native rejection');assert.equal(state.successfulUse?.runId,run.id,'a previous successful task remains history, not the verdict of the new run');
    f.setProbeAvailable(false);await f.engine.probe('codex',true);state=await f.versions();assert.equal(state.connection.state,'failed');assert.match(state.connection.detail,/routing/);assert.equal(state.successfulUse?.runId,run.id,'history does not hide a new check failure');
  }finally{await f.close();}
});

for(const mode of ['unknown','failed','stopped','empty','derived','unconfirmed'])test(`${mode} runs never create successful version evidence`,async()=>{
  const f=await fixture();try{f.setMode(mode);const run=await f.run();assert.equal(run.status,['empty','derived','unconfirmed'].includes(mode)?'ended':mode);assert.equal((await f.versions()).successfulUse,undefined);assert.equal(f.engine.store.list<MemberVersionUse>('member_version_uses').length,0);}finally{await f.close();}
});

test('a diagnostic baseline alone does not claim that this installation has been used successfully',async()=>{
  const f=await fixture('0.160.0');try{const state=await f.versions();assert.ok(state.baselineVersions.includes(state.current!));assert.equal(state.successfulUse,undefined);}finally{await f.close();}
});

test('existing native chats follow the current program while success records retain the actual version used',async()=>{
  const f=await fixture();try{
    const session=f.session(),first=await f.run(session.id),next=await f.makeEntry('second','9.0.0');
    await f.engine.invoke('settings.save',{paths:{codex:next}});await f.engine.probe('codex',true);
    assert.equal((await f.versions()).successfulUse,undefined,'same version at a different entry needs its own observed task');
    f.setProbeAvailable(false);await f.engine.probe('codex',true);const continued=await f.run(session.id);assert.equal(continued.status,'ended');assert.equal(continued.executorIdentity?.path,next);
    assert.equal(f.engine.store.get<any>('sessions',session.id).nativeId,'native-'+session.id);
    assert.equal(f.engine.store.get<any>('sessions',session.id).executorIdentity.path,next);
    let state=await f.versions();assert.equal(state.connection.state,'connected');assert.equal(state.successfulUse?.runId,continued.id);
    assert.equal(f.engine.store.list<MemberVersionUse>('member_version_uses').length,2);
    assert.equal(f.engine.store.get<Run>('runs',first.id)?.executorIdentity?.path,f.entry);
    await f.engine.invoke('settings.save',{paths:{codex:f.entry}});await f.engine.probe('codex',true);state=await f.versions();assert.equal(state.successfulUse?.runId,first.id);
    await writeFile(f.entry,'different bytes');state=await f.versions();assert.equal(state.successfulUse,undefined);assert.equal(state.connection.state,'unchecked');
    await writeFile(path.join(path.dirname(f.entry),'package.json'),JSON.stringify({version:'9.0.1'}));state=await f.versions();assert.equal(state.current,'9.0.1');assert.equal(state.successfulUse,undefined);
  }finally{await f.close();}
});
