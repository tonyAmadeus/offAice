import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Engine } from '../src/backend/engine';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';
import { compatibilityStep, currentIdentity, newCompatibility, observeArguments, observeProgram, observeProtocol, observeVersion, withCompatibility } from '../src/backend/compatibility';
import type { CompatibilityReport } from '../src/shared/compatibility';
import type { Adapter, ProviderInfo, Run, Session } from '../src/shared/types';
import { configureAcp } from '../src/backend/adapters/acp-config';
import { FLOW_CONTRACTS, contractHint } from '../src/shared/flow-contract';
import { payloadObject, flowPrompt } from '../src/shared/project-flow-protocol';

const info=(available=true):ProviderInfo=>({id:'codex',name:'Codex',available,auth:available?'subscription':'unknown',detail:available?'connected':'workspace routing discovery timed out',capabilities:{steer:true,cancel:'native',streaming:true,write:true,history:true}});
async function wait<T>(read:()=>T|undefined|false){for(let i=0;i<500;i++){const result=read();if(result)return result;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('state did not settle');}

test('a recovered probe retains its failed initialization and the deadline without recording request payloads',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM compatibility-'));let calls=0;
  const adapter:Adapter={probe:async()=>{calls++;try{await compatibilityStep('initialize',async()=>{if(calls===1)throw new Error('workspace routing discovery timed out');},'initialize',15);return info();}catch{return info(false);}},start:async()=>({}),stop:async()=>{}};
  const engine=new Engine(root,()=>{},()=>{},()=>adapter);
  try{
    await engine.probe('codex',true);await engine.probe('codex',true);
    const history=await engine.invoke('provider.compatibility',{provider:'codex'}) as CompatibilityReport[];
    assert.equal(history.length,2);assert.ok(history.some(report=>report.outcome==='passed'));
    const failure=history.find(report=>report.outcome==='failed')!;
    assert.equal(failure.stages[0].stage,'initialize');assert.equal(failure.stages[0].timeoutMs,15);assert.match(failure.stages[0].error!,/routing/);
    assert.equal(engine.snapshot().providers[0].auth,'subscription');
    for(let i=0;i<51;i++)await engine.probe('codex',true);
    assert.equal((await engine.invoke('provider.compatibility',{provider:'codex'}) as unknown[]).length,50);
  }finally{await engine.close();await rm(root,{recursive:true,force:true});}
});

test('configuration and connection checks serialize one provider and do not apply the old model effort to discovery',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM compatibility-'));let active=0,peak=0;const models:(string|undefined)[]=[],efforts:(string|undefined)[]=[];
  const adapter:Adapter={probe:async settings=>{peak=Math.max(peak,++active);models.push(settings.models.codex);efforts.push(settings.efforts.codex);await new Promise(resolve=>setTimeout(resolve,15));active--;return info();},start:async()=>({}),stop:async()=>{}};
  const engine=new Engine(root,()=>{},()=>{},()=>adapter);
  try{await Promise.all([engine.probe('codex'),engine.invoke('provider.config',{provider:'codex',model:'another'})]);assert.equal(peak,1);assert.equal(models.at(-1),'another');assert.equal(efforts.at(-1),undefined);}finally{await engine.close();await rm(root,{recursive:true,force:true});}
});

test('native chats retain history while switching programs and deleting an old version directory',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM binding-')),source=path.join(root,'project'),old=path.join(root,'data','members','codex','1.2.3','old.mjs'),next=path.join(root,'next.mjs');
  await mkdir(source);await mkdir(path.dirname(old),{recursive:true});await writeFile(old,'old entry');await writeFile(next,'next entry');const used:string[]=[];
  const adapter:Adapter={probe:async()=>info(),start:async ctx=>{const file=ctx.settings.paths.codex??old;observeProgram(file);used.push(file);ctx.persistNativeSession('native-session','airoom');ctx.markDelivery('confirmed');ctx.emit('message','done',{source:'assistant'},'native');return {};},stop:async()=>{}};
  const engine=new Engine(path.join(root,'data'),()=>{},()=>{},()=>adapter);
  try{
    const project=await engine.invoke('project.create',{directory:source}) as {id:string},session=engine.createSession(project.id,'codex',undefined,false);
    const run=async()=>{const sent=await engine.send(session.id,'do work') as {runId:string};return wait(()=>{const value=engine.store.get<Run>('runs',sent.runId);return value?.completedAt&&engine.store.get<CompatibilityReport>('compatibility_reports',value.compatibilityReportId!)?.completedAt?value:undefined;});};
    assert.equal((await run()).status,'ended');
    const saved=engine.store.get<Session>('sessions',session.id)!;assert.equal(saved.executorIdentity?.path,old);assert.ok(saved.executorIdentity?.digest);
    await engine.invoke('settings.save',{paths:{codex:next}});
    assert.equal((await run()).status,'ended');assert.deepEqual(used,[old,next]);
    // Keep a historical identity reference as it appears in profiles saved by older AIROOM builds.
    engine.store.put('sessions',session.id,{...engine.store.get<Session>('sessions',session.id)!,executorIdentity:saved.executorIdentity});
    await engine.invoke('member.remove',{provider:'codex',version:'1.2.3'});
    await assert.rejects(lstat(path.dirname(old)),/ENOENT/);
    const continued=await run();assert.equal(continued.status,'ended');assert.equal(continued.delivery,'confirmed');assert.deepEqual(used,[old,next,next]);
    assert.equal(engine.store.get<Session>('sessions',session.id)?.nativeId,'native-session');
    assert.equal(engine.store.get<CompatibilityReport>('compatibility_reports',continued.compatibilityReportId!)?.restore,'current-version');
  }finally{await engine.close();await rm(root,{recursive:true,force:true});}
});

test('bound protocol and invocation changes stop restoration while unknown legacy identity is not invented',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM identity-')),file=path.join(root,'agent.mjs');await writeFile(file,'entry');
  try{
    const first=newCompatibility('codex','run',DEFAULT_SETTINGS);
    const identity=await withCompatibility(first,async()=>{observeProgram(file);observeVersion('agent 1.2.3');observeProtocol('1');observeArguments(['--acp']);return currentIdentity()!;});
    await assert.rejects(withCompatibility(newCompatibility('codex','run',DEFAULT_SETTINGS),async()=>{observeProgram(file);observeProtocol('2');},identity),/协议版本/);
    await assert.rejects(withCompatibility(newCompatibility('codex','run',DEFAULT_SETTINGS),async()=>{observeProgram(file);observeArguments(['--other']);},identity),/启动参数/);
    await assert.rejects(withCompatibility(newCompatibility('codex','run',DEFAULT_SETTINGS),async()=>{observeProgram(file);observeVersion('agent 1.2.4');},identity),/原生执行端版本/);
    assert.equal(currentIdentity(),undefined);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('ACP rejects a reported configuration mismatch and never treats an accepted request as a reported value',async()=>{
  const state={configOptions:[{id:'vendor-model',type:'select',category:'model',currentValue:'a',options:[{value:'a'},{value:'b'}]}]};const reports:any[]=[];
  await assert.rejects(configureAcp({state,sessionId:'s',model:'b',request:async()=>state,record:r=>reports.push(r)}),/实际配置与选择不同/);
  assert.equal(reports.at(-1).modelStatus,'rejected');reports.length=0;
  await configureAcp({state,sessionId:'s',model:'b',request:async()=>({}),record:r=>reports.push(r)});
  assert.equal(reports.at(-1).modelStatus,'accepted');assert.equal(reports.at(-1).model,undefined);
});

test('all advertised top-level flow fields come from the same strict contract used by validation',()=>{
  for(const [kind,contract] of Object.entries(FLOW_CONTRACTS)){
    const required=Object.fromEntries(contract.required.map(key=>[key,null]));assert.doesNotThrow(()=>payloadObject(required,kind));
    assert.throws(()=>payloadObject({...required,unsupported:true},kind),/字段/);
    assert.ok(flowPrompt(kind,required,{}).includes(contractHint(kind)));
    assert.equal(contract.allowed.includes('userSummary'),['submission','joint-independent','joint-peer','joint-summary'].includes(kind));
  }
});


test('candidate configuration incompatibility preserves selection and records the failed switch',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM candidate-'));
  const adapter:Adapter={probe:async()=>({...info(),modelOptions:[{id:'supported',label:'Supported',efforts:['low']}]}),start:async()=>({}),stop:async()=>{}};
  const engine=new Engine(root,()=>{},()=>{},()=>adapter);
  try{
    await engine.invoke('settings.save',{models:{codex:'missing'}});
    const prior=engine.settings.paths.codex;
    await assert.rejects((engine as any).useMemberPath('codex',path.join(root,'candidate.mjs')),/不支持所选模型/);
    assert.equal(engine.settings.paths.codex,prior);
    const reports=await engine.invoke('provider.compatibility',{provider:'codex'}) as CompatibilityReport[];
    assert.ok(reports.some(report=>report.trigger==='candidate'&&report.outcome==='failed'&&report.error?.includes('不支持所选模型')));
  }finally{await engine.close();await rm(root,{recursive:true,force:true});}
});
