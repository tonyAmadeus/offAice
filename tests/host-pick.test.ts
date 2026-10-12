import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Engine} from './helpers/seeded-engine';
import type {Adapter,AdapterContext,ProviderId,Run} from '../src/shared/types';
import {failureMessage} from '../src/backend/adapter-failure';
async function until(check:()=>boolean){for(let i=0;i<600;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('host selection did not settle');}
async function fixture(options:{zero?:boolean;failCount?:number;delivery?:'prepared'|'sent'|'confirmed';error?:string;slowHand?:ProviderId}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'airoom-host-pick-')),speeches:{ctx:AdapterContext;input:any}[]=[],hands:string[]=[],attempts:string[]=[],handGates=new Map<ProviderId,()=>void>();let available=true,failures=0;
  const factory=(id:ProviderId):Adapter=>({probe:async()=>({id,name:id,available,auth:'subscription',detail:'fixture',capabilities:{steer:false,cancel:'native',streaming:true,write:false,history:true}}),stop:async()=>{handGates.get(id)?.();},start:async(ctx,prompt)=>{
    attempts.push(ctx.run.id);
    if(ctx.session.purpose==='room-hand'){hands.push(id);ctx.markDelivery('confirmed');if(options.slowHand===id)await new Promise<void>(resolve=>handGates.set(id,resolve));ctx.emit('delta',JSON.stringify({want:options.zero?0:id==='claude'?3:id==='codex'?1:0,why:'需要说明理由'}));return {};}
    if(failures<(options.failCount??0)){failures++;if(options.delivery&&options.delivery!=='prepared')ctx.markDelivery(options.delivery);throw Error(options.error??'workspace routing discovery timed out');}
    const input=JSON.parse(prompt.split('\nAIROOM_CONTEXT\n')[1]);speeches.push({ctx,input});ctx.markDelivery('confirmed');ctx.emit('delta',JSON.stringify({version:1,turn:input.turn,revision:input.revision,action:'speak',body:'真实模拟发言 '+id}));return {};
  }});
  const engine=new Engine(root,()=>{},()=>{},factory);await engine.probe();
  const state=()=>engine.store.roomState().discussion!;
  const start=(extra:Record<string,unknown>={})=>engine.invoke('room.send',{mode:'discuss',style:'work',text:'讨论',memberIds:['claude','codex','dsh'],maxCalls:7,maxMinutes:0,handRaise:true,...extra});
  const waiting=()=>until(()=>state()?.phase==='awaiting-host'&&!engine.store.roomState().active);
  const choice=(kind:'member'|'auto'|'skip',memberId?:string)=>{const d=state();return {discussionId:d.id,revision:d.revision,handRoundId:d.handRound!.id,choice:kind,memberId};};
  return {engine,root,factory,speeches,hands,attempts,state,start,waiting,choice,setAvailable:async(value:boolean)=>{available=value;await engine.probe();},dispose:async()=>{await engine.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}};
}
test('host picking is the default: wait without calls, then the requested lower-vote member speaks exactly once',async()=>{
  const h=await fixture();try{await h.start();await h.waiting();const d=h.state(),count=h.attempts.length,request=h.choice('member','codex');assert.equal(d.hostPick,true);assert.equal(d.calls,6);await new Promise(r=>setTimeout(r,60));assert.equal(h.attempts.length,count);
    await assert.rejects(h.engine.invoke('room.host',h.choice('member','dsh')),/本轮已举手/);await assert.rejects(h.engine.invoke('room.host',{...request,handRoundId:'old'}),/已改变/);assert.equal(h.attempts.length,count);
    await h.engine.invoke('room.host',request);await until(()=>h.state().phase==='budget'&&!h.engine.store.roomState().active);assert.equal(h.speeches[3].ctx.run.provider,'codex');assert.equal(h.speeches.length,4);await assert.rejects(h.engine.invoke('room.host',request),/已改变/);
  }finally{await h.dispose();}
});

test('the host can pick a completed hand while another program is still waiting, without replaying unfinished hands',async()=>{
  const h=await fixture({slowHand:'dsh'});try{
    await h.start();await until(()=>h.state()?.phase==='raising'&&h.state().handRound?.ballots.claude?.status==='done'&&h.hands.includes('dsh'));
    const slow=h.engine.store.list<Run>('runs').find(r=>h.engine.store.get<any>('sessions',r.sessionId)?.purpose==='room-hand'&&r.provider==='dsh')!;
    await h.engine.invoke('room.host',h.choice('member','claude'));await until(()=>h.speeches.length===4&&!h.engine.store.roomState().active);
    assert.equal(h.speeches[3].ctx.run.provider,'claude');assert.equal(h.hands.length,3);assert.equal(h.engine.store.get<Run>('runs',slow.id)?.status,'stopped');assert.equal(h.state().handRound?.selected,'claude');
  }finally{await h.dispose();}
});

test('human input is accepted before repeated whole-workspace publication and its canonical message is published',async()=>{
  const h=await fixture();try{
    let snapshots=0;const snapshot=h.engine.snapshot.bind(h.engine);h.engine.snapshot=()=>{snapshots++;return snapshot();};
    await h.start({handRaise:false,memberIds:['claude'],maxCalls:1,materialContext:true});
    assert.ok(snapshots<=1,'sending must not wait for many complete workspace snapshots');
    await until(()=>snapshots>0&&h.state()?.phase==='waiting_user'&&!h.engine.store.roomState().active);
    assert.ok(h.engine.snapshot().room.messages.some(m=>m.author==='user'&&m.text==='讨论'&&!m.contextOnly),'public input cannot impersonate internal prepared context');
  }finally{await h.dispose();}
});

test('member status bursts publish one current workspace snapshot without delaying their persisted facts',async()=>{
  const h=await fixture();try{
    await new Promise<void>(resolve=>setImmediate(resolve));
    let snapshots=0;const snapshot=h.engine.snapshot.bind(h.engine);h.engine.snapshot=()=>{snapshots++;return snapshot();};
    for(let i=0;i<9;i++){h.engine.store.put('settings','publication-probe',{revision:i});h.engine.broadcast();}
    assert.equal(snapshots,0);assert.equal(h.engine.store.get<any>('settings','publication-probe')?.revision,8);
    await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(snapshots,1);
  }finally{await h.dispose();}
});
for(const choice of ['auto','skip'] as const)test('host can '+choice+' without another ballot',async()=>{
  const h=await fixture();try{await h.start();await h.waiting();await h.engine.invoke('room.host',h.choice(choice));await until(()=>h.state().phase===(choice==='skip'?'waiting_user':'budget')&&!h.engine.store.roomState().active);assert.equal(h.hands.length,3);assert.equal(h.speeches.length,choice==='skip'?3:4);if(choice==='auto')assert.equal(h.speeches[3].ctx.run.provider,'claude');assert.equal(h.state().handRound?.fallback,choice==='skip');}finally{await h.dispose();}
});
test('interjection invalidates host revision and honors an explicit mention without replaying hands',async()=>{
  const h=await fixture();try{await h.start();await h.waiting();const request=h.choice('member','claude');await h.engine.invoke('room.send',{mode:'discuss',text:'@DS 请先回答新要求'});await assert.rejects(h.engine.invoke('room.host',request),/已改变/);await until(()=>h.state().phase==='waiting_user'&&!h.engine.store.roomState().active);assert.equal(h.speeches[3].ctx.run.provider,'dsh');assert.equal(h.hands.length,3);assert.equal(h.state().handRound?.status,'stale');}finally{await h.dispose();}
});
test('waiting supports pause, resume and explicit end without calls; unavailable raised members cannot be selected',async()=>{
  const h=await fixture();try{await h.start();await h.waiting();const request=h.choice('member','claude'),count=h.attempts.length;await h.engine.invoke('room.pause',{});await assert.rejects(h.engine.invoke('room.host',request),/已改变/);await h.engine.invoke('room.resume',{});assert.equal(h.state().phase,'awaiting-host');assert.equal(h.state().handRound?.id,request.handRoundId);await h.setAvailable(false);await assert.rejects(h.engine.invoke('room.host',h.choice('member','claude')),/当前可用/);await h.engine.invoke('room.end',{discussionId:h.state().id});assert.equal(h.state().phase,'idle');assert.equal(h.attempts.length,count);}finally{await h.dispose();}
});
test('host waiting suspends a saved time budget instead of expiring during human deliberation',async()=>{
  const h=await fixture();try{await h.start({maxMinutes:1});await h.waiting();const d=h.state();h.engine.store.put('room','state',{...h.engine.store.roomState(),discussion:{...d,deadline:Date.now()-60000,hostWaitStartedAt:Date.now()-120000}});await h.engine.invoke('room.host',h.choice('member','codex'));await until(()=>h.state().phase==='budget'&&!h.engine.store.roomState().active);assert.ok(h.state().deadline>Date.now());assert.equal(h.speeches[3].ctx.run.provider,'codex');}finally{await h.dispose();}
});
test('saved host ballots survive restart as paused history and resume into waiting without replay',async()=>{
  const h=await fixture();let resumed:Engine|undefined;try{await h.start();await h.waiting();const roundId=h.state().handRound!.id,count=h.attempts.length;await h.engine.close();resumed=new Engine(h.root,()=>{},()=>{},h.factory);assert.equal(resumed.store.roomState().discussion?.phase,'paused');await resumed.invoke('room.resume',{});assert.equal(resumed.store.roomState().discussion?.phase,'awaiting-host');assert.equal(resumed.store.roomState().discussion?.handRound?.id,roundId);await new Promise(r=>setTimeout(r,50));assert.equal(h.attempts.length,count);}finally{await resumed?.close();await h.dispose();}
});
for(const extra of [{hostPick:false},{zero:true}])test(extra.zero?'no raised hands wait without another ordinary round':'unchecked host picking preserves automatic selection',async()=>{
  const h=await fixture(extra);try{await h.start(extra);await until(()=>h.state()?.phase===(extra.zero?'waiting_user':'budget')&&!h.engine.store.roomState().active);assert.equal(h.speeches.length,extra.zero?3:4);assert.equal(h.hands.length,3);assert.equal(h.state().handRound?.status,'done');}finally{await h.dispose();}
});
test('a confirmed unsent connection timeout retries once in a meeting and preserves both actual attempts',async()=>{
  const h=await fixture({failCount:1});try{await h.start({handRaise:false,memberIds:['codex'],maxCalls:2});await until(()=>h.state()?.phase==='waiting_user'&&!h.engine.store.roomState().active);const runs=h.engine.store.list<Run>('runs');assert.equal(runs.length,2);assert.equal(runs[0].delivery,'prepared');assert.equal(runs[0].status,'failed');assert.equal(runs[1].status,'ended');assert.equal(h.state().calls,2);assert.equal(h.speeches.length,1);assert.match(failureMessage(runs[0].error!,undefined,runs[0].delivery),/账号.*初始化超时.*尚未发出.*可以重试/);}finally{await h.dispose();}
});
test('two unsent connection failures skip that seat after the sole retry with an honest receipt',async()=>{
  const h=await fixture({failCount:5});try{await h.start({handRaise:false,memberIds:['codex'],maxCalls:8});await until(()=>h.state()?.phase==='blocked'&&!h.engine.store.roomState().active);assert.equal(h.attempts.length,2);assert.equal(h.state().unknownRunId,undefined);assert.ok(h.state().skippedMembers?.codex);assert.ok(h.engine.snapshot().room.messages.some(m=>/没有发给成员/.test(m.text)));}finally{await h.dispose();}
});
for(const delivery of ['sent','confirmed'] as const)test(delivery+' transport loss is unknown and is never retried',async()=>{
  const h=await fixture({failCount:5,delivery});try{await h.start({handRaise:false,memberIds:['codex'],maxCalls:8});await until(()=>h.state()?.phase==='blocked'&&!h.engine.store.roomState().active);assert.equal(h.attempts.length,1);assert.ok(h.state().unknownRunId);await assert.rejects(h.engine.invoke('room.resume',{}),/结果未知/);}finally{await h.dispose();}
});
test('casual chat and nonconnection preparation errors do not inherit meeting reconnect retries',async()=>{
  for(const extra of [{style:'chat'},{}]){const h=await fixture({failCount:5,error:extra.style?'workspace routing discovery timed out':'invalid local configuration'});try{await h.start({handRaise:false,memberIds:['codex'],maxCalls:8,...extra});await until(()=>h.state()?.phase==='blocked'&&!h.engine.store.roomState().active);assert.equal(h.attempts.length,1);}finally{await h.dispose();}}
});
