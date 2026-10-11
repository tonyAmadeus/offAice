import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Engine } from '../src/backend/engine';
import { Store } from '../src/backend/store';
import { AutomaticBudget } from '../src/backend/automatic-budget';
import { AUTOMATION_PAUSE_FILE } from '../src/shared/automation';
import type { AutomaticOrigin, AutomaticPolicies, TimedJob } from '../src/shared/automation';
import type { Adapter, AdapterResult, ProviderInfo, Run } from '../src/shared/types';

const wait=async(check:()=>boolean)=>{for(let i=0;i<400;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('automatic feature did not settle');};
const origin=(id:string,feature:AutomaticOrigin['feature']='scheduled-message'):AutomaticOrigin=>({feature,jobId:'job',occurrenceId:id});
async function budgetFixture(){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM-daily-budget-')),store=new Store(directory);let at=Date.parse('2026-10-04T15:59:00Z'),policies:AutomaticPolicies={},allows=true;
  const budget=new AutomaticBudget(store,()=>policies,{now:()=>at,quotaAllows:()=>allows});
  return {store,budget,policy:(value:AutomaticPolicies)=>{policies=value;},clock:(value:string)=>{at=Date.parse(value);},quota:(value:boolean)=>{allows=value;},cleanup:async()=>{store.close();assert.ok(path.basename(directory).startsWith('AIROOM-daily-budget-'));await fs.rm(directory,{recursive:true,force:true});}};
}
test('every automatic category starts closed and counts only admitted attempts',async()=>{
  const f=await budgetFixture();try{assert.ok(f.budget.snapshot().every(item=>!item.enabled&&item.used===0));assert.throws(()=>f.budget.admit(origin('off'),'r','claude'),/还没开启/);assert.equal(f.store.list('automatic_attempts').length,0);}finally{await f.cleanup();}
});
test('daily categories are isolated, unknown attempts keep their charge, and toggles never reset usage',async()=>{
  const f=await budgetFixture();try{
    f.policy({'scheduled-message':{enabled:true,dailyLimit:1},'daily-opening':{enabled:true,dailyLimit:1}});f.budget.admit(origin('one'),'r','claude');f.budget.complete('one','unknown');assert.throws(()=>f.budget.admit(origin('two'),'r2','claude'),/每日/);
    f.budget.admit(origin('opening','daily-opening'),'r3','codex');f.policy({'scheduled-message':{enabled:false,dailyLimit:5}});assert.throws(()=>f.budget.admit(origin('off-again'),'r4','claude'),/还没开启/);f.policy({'scheduled-message':{enabled:true,dailyLimit:1}});assert.equal(f.budget.snapshot().find(item=>item.feature==='scheduled-message')?.used,1);assert.throws(()=>f.budget.admit(origin('new'),'r5','claude'),/每日/);
  }finally{await f.cleanup();}
});
test('calendar midnight resets the daily limit, clock rollback cannot reopen an older budget',async()=>{
  const f=await budgetFixture();try{f.policy({'scheduled-message':{enabled:true,dailyLimit:1}});f.budget.admit(origin('day-one'),'r1','claude');f.clock('2026-10-04T16:01:00Z');assert.equal(f.budget.snapshot()[2].day,'2026-10-05');f.budget.admit(origin('day-two'),'r2','claude');f.clock('2026-10-04T15:59:00Z');assert.throws(()=>f.budget.admit(origin('rolled-back'),'r3','claude'),/每日/);}finally{await f.cleanup();}
});
test('quota rejection and duplicate receipts cannot consume a second native call',async()=>{
  const f=await budgetFixture();try{f.policy({'scheduled-message':{enabled:true,dailyLimit:10}});f.quota(false);assert.throws(()=>f.budget.admit(origin('limited'),'r','codex'),/账号额度/);assert.equal(f.budget.snapshot()[2].used,0);f.quota(true);f.budget.admit(origin('receipt'),'r','codex');assert.throws(()=>f.budget.admit(origin('receipt'),'other','codex'),/没有重复发送/);assert.equal(f.budget.snapshot()[2].used,1);new AutomaticBudget(f.store,()=>({'scheduled-message':{enabled:true,dailyLimit:10}}));assert.equal(f.store.get<{status:string}>('automatic_attempts','receipt')?.status,'unknown');assert.equal(f.budget.snapshot()[2].used,1);}finally{await f.cleanup();}
});
test('policy validation rejects unbounded or implicit opt-ins',()=>{
  for(const value of [{future:{enabled:true,dailyLimit:1}},{'scheduled-message':{enabled:'yes',dailyLimit:1}},{'scheduled-message':{enabled:true,dailyLimit:Infinity}},{'scheduled-message':{enabled:true,dailyLimit:-1}},{'scheduled-message':{enabled:true,dailyLimit:1.5}}])assert.throws(()=>AutomaticBudget.validate(value));
});
async function engineFixture(result:AdapterResult={},quota?:unknown){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM-automatic-engine-'));let at=Date.parse('2026-10-04T01:00:00Z'),calls=0;
  const provider:ProviderInfo={id:'claude',name:'Claude',available:true,auth:'subscription',detail:'fixture',quota,capabilities:{steer:false,cancel:'process',streaming:true,write:false,history:true}};
  const adapter:Adapter={probe:async()=>provider,start:async(ctx,prompt)=>{calls++;ctx.markDelivery('confirmed');const input=prompt.includes('\nAIROOM_CONTEXT\n')?JSON.parse(prompt.split('\nAIROOM_CONTEXT\n')[1]):undefined;ctx.emit('message',input?JSON.stringify({version:1,turn:input.turn,revision:input.revision,action:'speak',body:'手动回复'}):'定时回复',{source:'assistant'});return result;},stop:async()=>{}};
  const engine=new Engine(path.join(directory,'data'),()=>{},()=>{},()=>adapter,{automationNow:()=>at,automationTickMs:5});
  const save=async()=>engine.invoke('automation.save',{name:'成员提醒',enabled:true,schedule:{kind:'interval',minutes:1},action:{kind:'member-message',memberId:'claude',threadId:engine.store.currentRoomThread().id,feature:'scheduled-message',text:'提醒我检查待办'}}) as Promise<TimedJob>;
  const tick=async()=>{at+=60_000;await wait(()=>Boolean(engine.snapshot().automation?.recent.some(item=>Date.parse(item.startedAt)===at&&item.status!=='running')));};
  return {engine,directory,save,tick,calls:()=>calls,cleanup:async()=>{await engine.close();assert.ok(path.basename(directory).startsWith('AIROOM-automatic-engine-'));await fs.rm(directory,{recursive:true,force:true});}};
}
test('scheduled speech stays off by default; enabled calls are capped while manual conversation remains usable',async()=>{
  const f=await engineFixture();try{
    await f.save();await f.tick();assert.equal(f.calls(),0);
    await f.engine.invoke('automation.policy.save',{policies:{'scheduled-message':{enabled:true,dailyLimit:1}}});await f.tick();assert.equal(f.calls(),1);const message=f.engine.snapshot().room.messages.find(item=>item.automatic)!;assert.equal(message.text,'定时回复');assert.ok(message.runId);assert.ok(f.engine.store.get<Run>('runs',message.runId)?.automatic?.reservationId);
    await f.tick();assert.equal(f.calls(),1);await f.engine.invoke('room.send',{text:'手动发言',mode:'discuss',style:'chat',memberIds:['claude'],maxCalls:1,maxMinutes:0});await wait(()=>!f.engine.snapshot().room.state.active);assert.equal(f.calls(),2);assert.equal(f.engine.snapshot().automation?.usage?.find(item=>item.feature==='scheduled-message')?.used,1);
  }finally{await f.cleanup();}
});
test('an unknown scheduled result hides its unconfirmed body and pauses only that job without retry',async()=>{
  const f=await engineFixture({unknown:true});try{await f.engine.invoke('automation.policy.save',{policies:{'scheduled-message':{enabled:true,dailyLimit:5}}});const job=await f.save();await f.tick();assert.equal(f.calls(),1);assert.equal(f.engine.snapshot().room.messages.find(item=>item.automatic)?.text,'');assert.ok(f.engine.snapshot().automation?.jobs.find(item=>item.id===job.id)?.pausedReason);await f.tick();assert.equal(f.calls(),1);assert.equal(f.engine.snapshot().automation?.usage?.find(item=>item.feature==='scheduled-message')?.used,1);}finally{await f.cleanup();}
});
test('a real reported exhausted quota prevents every scheduled call even when its policy is enabled',async()=>{
  const f=await engineFixture({}, {rateLimit:{status:'rejected',rateLimitType:'five_hour',unifiedWindows:{five_hour:{utilization:1,resetsAt:Math.floor(Date.now()/1000)+3600}}}});try{await f.engine.probe('claude');await f.engine.invoke('automation.policy.save',{policies:{'scheduled-message':{enabled:true,dailyLimit:5}}});await f.save();await f.tick();assert.equal(f.calls(),0);assert.match(f.engine.snapshot().automation!.recent[0].reason!,/额度/);}finally{await f.cleanup();}
});
test('a paused discussion is not interrupted by a scheduled message',async()=>{
  const f=await engineFixture();try{await f.engine.invoke('automation.policy.save',{policies:{'scheduled-message':{enabled:true,dailyLimit:5}}});await f.save();f.engine.store.put('room','state',{active:false,mode:'discuss',discussion:{phase:'paused'}});await f.tick();assert.equal(f.calls(),0);assert.match(f.engine.snapshot().automation!.recent[0].reason!,/被你暂停/);}finally{await f.cleanup();}
});

test('disabling the policy while a message is queued prevents admission and keeps its budget unspent',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM-automatic-queued-'));let at=Date.parse('2026-10-04T01:00:00Z'),calls=0,release:((result:AdapterResult)=>void)|undefined;
  const engine=new Engine(path.join(directory,'data'),()=>{},()=>{},()=>({probe:async()=>{throw new Error('no probe');},start:async ctx=>{calls++;ctx.markDelivery('confirmed');if(!ctx.run.automatic)return new Promise(resolve=>{release=resolve;});assert.fail('disabled queued automatic call must not reach the adapter');},stop:async()=>release?.({stopped:true})}),{automationNow:()=>at,automationTickMs:5});
  try{
    await engine.invoke('settings.save',{maxParallel:1});const source=path.join(directory,'source');await fs.mkdir(source);const project=await engine.invoke('project.create',{directory:source}) as {id:string};const session=engine.createSession(project.id,'claude');await engine.send(session.id,'manual task');await wait(()=>Boolean(release));
    await engine.invoke('automation.policy.save',{policies:{'scheduled-message':{enabled:true,dailyLimit:1}}});await engine.invoke('automation.save',{name:'queued',enabled:true,schedule:{kind:'interval',minutes:1},action:{kind:'member-message',memberId:'claude',threadId:engine.store.currentRoomThread().id,feature:'scheduled-message',text:'a scheduled reply'}});at+=60_000;
    await wait(()=>engine.store.list<Run>('runs').some(run=>Boolean(run.automatic)&&run.status==='queued'));assert.equal(engine.snapshot().automation?.usage?.[2].used,0);
    await engine.invoke('automation.policy.save',{policies:{'scheduled-message':{enabled:false,dailyLimit:1}}});release!({});await wait(()=>engine.snapshot().automation!.recent.some(item=>item.status==='skipped'));
    assert.equal(calls,1);assert.equal(engine.snapshot().automation?.usage?.[2].used,0);assert.equal(engine.store.list<Run>('runs').find(run=>run.automatic)?.delivery,'withdrawn');
  }finally{release?.({stopped:true});await engine.close();assert.ok(path.basename(directory).startsWith('AIROOM-automatic-queued-'));await fs.rm(directory,{recursive:true,force:true});}
});

test('an emergency-stop marker persists across worker restart until an explicit resume',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM-automatic-stop-'));let engine:Engine|undefined;
  try{
    const seeded=new Store(directory);seeded.put('automation_state','main',{paused:false});seeded.close();await fs.writeFile(path.join(directory,AUTOMATION_PAUSE_FILE),'paused');
    engine=new Engine(directory,()=>{},()=>{});assert.equal(engine.snapshot().automation?.paused,true);await engine.close();engine=undefined;
    engine=new Engine(directory,()=>{},()=>{});assert.equal(engine.snapshot().automation?.paused,true);await engine.invoke('automation.resume');assert.equal(engine.snapshot().automation?.paused,false);await engine.close();engine=undefined;
    engine=new Engine(directory,()=>{},()=>{});assert.equal(engine.snapshot().automation?.paused,false);
  }finally{await engine?.close();assert.ok(path.basename(directory).startsWith('AIROOM-automatic-stop-'));await fs.rm(directory,{recursive:true,force:true});}
});
