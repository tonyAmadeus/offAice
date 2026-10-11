import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/backend/store';
import { Engine } from '../src/backend/engine';
import { AutomationScheduler } from '../src/backend/automation-scheduler';
import { localParts, nextOccurrence, validateSchedule, type TimedJob, type TimedOccurrence } from '../src/shared/automation';

async function fixture(){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM-timed-jobs-')),store=new Store(directory);let at=Date.parse('2026-10-04T00:59:00Z'),calls=0;
  const scheduler=new AutomationScheduler(store,{changed:()=>{},run:async()=>{calls++;return {status:'done'};}},{now:()=>at});
  const job=(enabled=true)=>scheduler.save({name:'本地提醒',enabled,schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Shanghai'},action:{kind:'notice',text:'检查待办'}});
  return {directory,store,scheduler,job,clock:(value:string|number)=>{at=typeof value==='number'?value:Date.parse(value);},calls:()=>calls,cleanup:async()=>{await scheduler.close();store.close();assert.ok(path.basename(directory).startsWith('AIROOM-timed-jobs-'));await fs.rm(directory,{recursive:true,force:true});}};
}
test('daily times follow local calendar dates and invalid schedules are rejected',()=>{
  assert.deepEqual(localParts(Date.parse('2026-10-03T16:01:00Z')),{day:'2026-10-04',time:'00:01'});
  assert.equal(nextOccurrence({kind:'daily',time:'09:00',timeZone:'Asia/Shanghai'},Date.parse('2026-10-04T01:00:00Z')),'2026-10-05T01:00:00.000Z');
  assert.throws(()=>validateSchedule({kind:'daily',time:'24:00',timeZone:'Asia/Shanghai'}));assert.throws(()=>validateSchedule({kind:'interval',minutes:0}));assert.throws(()=>validateSchedule({kind:'once',at:'invalid'}));
});
test('a due task is claimed once, including concurrent ticks and clock rollback after diagnostic pruning',async()=>{
  const f=await fixture();try{
    const job=f.job();f.clock('2026-10-04T01:00:00Z');await Promise.all([f.scheduler.tick(),f.scheduler.tick()]);assert.equal(f.calls(),1);
    const completed=f.store.get<TimedJob>('timed_jobs',job.id)!;f.store.deleteEntitiesWhere('timed_occurrences',()=>true);
    f.clock('2026-10-04T00:59:00Z');f.store.put('timed_jobs',job.id,{...completed,nextAt:'2026-10-04T01:00:00Z'});f.clock('2026-10-04T01:00:00Z');await f.scheduler.tick();assert.equal(f.calls(),1);
    assert.equal(f.store.get<TimedJob>('timed_jobs',job.id)?.nextAt,'2026-10-05T01:00:00.000Z');
  }finally{await f.cleanup();}
});
test('disabled, human-paused and sleep-missed triggers never run or catch up',async()=>{
  const f=await fixture();try{f.job(false);f.clock('2026-10-04T01:00:00Z');await f.scheduler.tick();assert.equal(f.calls(),0);f.job();f.scheduler.pause();f.clock('2026-10-05T01:00:00Z');await f.scheduler.tick();assert.equal(f.calls(),0);f.clock('2026-10-05T10:00:00Z');f.scheduler.resume();await f.scheduler.tick();assert.equal(f.calls(),0);assert.ok(f.scheduler.snapshot().recent.every(item=>item.status==='skipped'));}finally{await f.cleanup();}
});
test('a six-hour wake skips missed time and schedules just the next future occurrence',async()=>{
  const f=await fixture();try{const job=f.job();f.clock('2026-10-04T07:00:00Z');await f.scheduler.tick();assert.equal(f.calls(),0);assert.match(f.scheduler.snapshot().recent[0].reason!,/错过/);assert.equal(f.store.get<TimedJob>('timed_jobs',job.id)?.nextAt,'2026-10-05T01:00:00.000Z');}finally{await f.cleanup();}
});
test('restart marks an interrupted trigger unknown, and re-enabling it requires explicit acknowledgement',async()=>{
  const f=await fixture();let restarted:AutomationScheduler|undefined;try{
    const job=f.job(),item:TimedOccurrence={id:'interrupted',jobId:job.id,jobRevision:job.revision,key:'2026-10-04',dueAt:job.nextAt!,startedAt:'2026-10-04T01:00:00Z',status:'running'};f.store.put('timed_occurrences',item.id,item);
    await f.scheduler.close();f.clock('2026-10-04T02:00:00Z');restarted=new AutomationScheduler(f.store,{changed:()=>{},run:async()=>{assert.fail('interrupted task must not replay');}},{now:()=>Date.parse('2026-10-04T02:00:00Z')});
    assert.equal(f.store.get<TimedOccurrence>('timed_occurrences',item.id)?.status,'unknown');const saved=f.store.get<TimedJob>('timed_jobs',job.id)!;assert.ok(saved.pausedReason);assert.throws(()=>restarted!.save({...saved,enabled:true}),/核对/);restarted.save({...saved,enabled:true,acknowledgeUnknown:true});assert.equal(restarted.snapshot().jobs[0].pausedReason,undefined);
  }finally{await restarted?.close();await f.cleanup();}
});
test('changing or deleting a job invalidates an already claimed action',async()=>{
  const f=await fixture();try{const job=f.job(),item:TimedOccurrence={id:'claimed',jobId:job.id,jobRevision:job.revision,key:'x',dueAt:job.nextAt!,startedAt:'',status:'running'};assert.equal(f.scheduler.current(item),true);f.scheduler.save({...job,name:'new settings'});assert.equal(f.scheduler.current(item),false);f.scheduler.remove(job.id);assert.equal(f.scheduler.current(item),false);}finally{await f.cleanup();}
});
test('local maintenance is allowed during a user pause and its history stays bounded',async()=>{
  const f=await fixture();try{f.scheduler.system('maintenance',1,{kind:'local-event',event:'runtime-reap'});f.scheduler.pause();for(let minute=1;minute<30;minute++){f.clock(Date.parse('2026-10-04T00:59:00Z')+minute*60_000);await f.scheduler.tick();}assert.equal(f.calls(),29);assert.equal(f.store.list('timed_occurrences').length,20);assert.deepEqual(f.scheduler.snapshot().recent,[]);}finally{await f.cleanup();}
});
test('the real engine delivers a local reminder without any model calls; all-stop pauses future triggers',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM-timed-engine-'));let at=Date.parse('2026-10-04T00:00:00Z'),calls=0;
  const engine=new Engine(directory,()=>{},()=>{},()=>({probe:async()=>{throw new Error('not expected');},start:async()=>{calls++;return {};},stop:async()=>{}}),{automationNow:()=>at,automationTickMs:5});
  try{
    await engine.invoke('automation.save',{name:'提醒',enabled:true,schedule:{kind:'interval',minutes:1},action:{kind:'notice',text:'检查进度'}});at+=60_000;
    for(let i=0;i<100&&!engine.snapshot().room.messages.some(message=>message.scheduled);i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(calls,0);assert.match(engine.snapshot().room.messages.find(message=>message.scheduled)!.text,/检查进度/);await engine.invoke('all.stop');at+=60_000;await new Promise(resolve=>setTimeout(resolve,30));assert.equal(engine.snapshot().automation?.paused,true);assert.equal(engine.snapshot().room.messages.filter(message=>message.scheduled).length,1);
  }finally{await engine.close();assert.ok(path.basename(directory).startsWith('AIROOM-timed-engine-'));await fs.rm(directory,{recursive:true,force:true});}
});
