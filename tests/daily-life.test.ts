import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/backend/engine';
import { Store } from '../src/backend/store';
import { memberChatPrompt,openingPrompt,yesterdayFacts } from '../src/backend/daily-life';
import { validateDailyLife } from '../src/shared/automation';
import { BUILTIN_MEMBERS,DEFAULT_SETTINGS,personaInstructions } from '../src/shared/defaults';
import type { AdapterContext,AdapterResult,MemberProfile,ProviderId,RoomMessage,Run } from '../src/shared/types';
import type { LifeFeature,TimedOccurrence } from '../src/shared/automation';

const start=Date.parse('2026-10-04T01:00:00Z');
  const wait=async(check:()=>boolean)=>{for(let index=0;index<800;index++){if(check())return;await new Promise(done=>setTimeout(done,10));}assert.fail('daily life state did not settle');};
async function fixture(handler?:(ctx:AdapterContext,index:number)=>Promise<AdapterResult>|AdapterResult){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM-daily-life-'));let clock=start;const calls:AdapterContext[]=[];
  const engine=new Engine(directory,()=>{},()=>{},id=>({
    probe:async()=>({id,name:id,available:true,auth:id==='dsh'?'account':'subscription',detail:'fixture',capabilities:{steer:false,cancel:'native',streaming:true,write:false,history:true}}),
    start:async ctx=>{calls.push(ctx);ctx.markDelivery('confirmed');if(handler)return handler(ctx,calls.length);ctx.emit('message',`已核对的发言 ${ctx.session.memberId??ctx.session.provider}`,{source:'assistant'});return {};},stop:async()=>{},
  }),{automationNow:()=>clock,automationTickMs:5});
  await engine.probe();
  const open=async(visible=true)=>engine.invoke('internal.room.opened',{visible});
  const enable=async(feature:LifeFeature,limit=feature==='daily-opening'?1:4)=>engine.invoke('automation.policy.save',{policies:{[feature]:{enabled:true,dailyLimit:limit}},dailyLife:{memberChatMinutes:5}});
  const job=(feature:LifeFeature)=>engine.snapshot().automation?.jobs.find(job=>job.managed===feature);
  const tick=async(feature:LifeFeature)=>{
    const target=job(feature);assert.ok(target?.nextAt);clock=Date.parse(target.nextAt);
    await wait(()=>engine.store.list<TimedOccurrence>('timed_occurrences').some(item=>item.jobId===target.id&&!item.parentOccurrenceId&&item.dueAt===target.nextAt&&item.status!=='running'));
  };
  return {engine,directory,calls,open,enable,job,tick,setTime:(at:number)=>{clock=at;},cleanup:async()=>{await engine.close();assert.ok(path.basename(directory).startsWith('AIROOM-daily-life-'));await fs.rm(directory,{recursive:true,force:true});}};
}
test('daily life defaults stay closed and enabling later does not replay the first opening',async()=>{
  const f=await fixture();try{
    await f.open();f.setTime(start+600_000);await f.open();assert.equal(f.calls.length,0);assert.equal(f.engine.snapshot().automation!.jobs.length,0);
    await f.enable('daily-opening');await f.open();assert.equal(f.job('daily-opening'),undefined);
    f.setTime(start+86_400_000);await f.open();await f.tick('daily-opening');assert.equal(f.calls.length,1);
    await f.open(false);await f.open();assert.equal(f.calls.length,1);
  }finally{await f.cleanup();}
});
test('daily greetings run once on each Beijing calendar day, rotate and bind every message to its run and receipt',async()=>{
  const f=await fixture();try{
    await f.enable('daily-opening');await f.open();await f.open();await f.tick('daily-opening');
    f.setTime(Date.parse('2026-10-04T16:01:00Z'));await f.open();await f.tick('daily-opening');
    assert.equal(f.calls.length,2);assert.notEqual(f.calls[0].session.memberId??f.calls[0].session.provider,f.calls[1].session.memberId??f.calls[1].session.provider);
    const messages=f.engine.snapshot().room.messages.filter(message=>message.automatic);assert.equal(messages.length,2);
    for(const message of messages){assert.ok(message.runId);const run=f.engine.store.get<Run>('runs',message.runId!)!;assert.equal(run.delivery,'confirmed');assert.equal(run.automatic?.feature,'daily-opening');assert.ok(run.automatic?.reservationId);assert.equal(message.automatic?.occurrenceId,run.automatic?.occurrenceId);assert.ok(f.engine.store.get<TimedOccurrence>('timed_occurrences',run.automatic!.occurrenceId)?.parentOccurrenceId);}
    assert.equal(f.engine.snapshot().automation?.usage?.find(item=>item.feature==='daily-opening')?.used,1);
    f.setTime(start);await f.open();assert.equal(f.calls.length,2);
  }finally{await f.cleanup();}
});
test('opening prompt uses yesterday recorded facts only; disabled memories and proposed candidates never enter persona',()=>{
  const card:MemberProfile={...BUILTIN_MEMBERS[0],memories:[{id:'on',text:'enabled-memory',source:'manual',createdAt:''},{id:'off',text:'disabled-memory',source:'manual',createdAt:'',off:true}],routine:{morning:'routine-fiction'},quirks:['quirk-fiction']};
  const messages=[{id:'yesterday',author:'user',text:'昨天已记录的要求',at:'2026-10-03T06:00:00Z',status:'done'},{id:'today',author:'user',text:'today-only',at:'2026-10-04T00:00:00Z',status:'done'},{id:'unknown',author:'claude',text:'unconfirmed-body',at:'2026-10-03T08:00:00Z',status:'failed'},{id:'stale',author:'claude',text:'stale-body',at:'2026-10-03T08:00:00Z',status:'done',discussionStale:true}] as RoomMessage[];
  assert.equal(yesterdayFacts(messages,start).length,1);const prompt=openingPrompt(card,messages,start);assert.ok(prompt.includes('昨天已记录的要求'));assert.ok(!prompt.includes('today-only'));assert.ok(!prompt.includes('unconfirmed-body'));assert.ok(!prompt.includes('stale-body'));
  const persona=personaInstructions(card,{name:'主人'},[card]);assert.ok(persona.includes('enabled-memory'));for(const text of ['disabled-memory','routine-fiction','quirk-fiction'])assert.ok(!persona.includes(text));assert.ok(openingPrompt(card,[],start).includes('不编造昨天的经历'));
});
test('daily opening watermark survives worker restart and no elapsed opening is replayed',async()=>{
  const f=await fixture();let restarted:Engine|undefined;try{
    await f.enable('daily-opening');await f.open();await f.tick('daily-opening');await f.engine.close();
    restarted=new Engine(f.directory,()=>{},()=>{},()=>({probe:async()=>{throw new Error('not needed');},start:async()=>{assert.fail('Do not replay a greeting on worker restart');},stop:async()=>{}}),{automationNow:()=>start+3600_000,automationTickMs:5});
    await restarted.invoke('internal.room.opened',{visible:true});await new Promise(done=>setTimeout(done,25));assert.equal(restarted.store.get<{day:string}>('daily_life','opening')?.day,'2026-10-04');assert.equal(restarted.snapshot().room.messages.filter(message=>message.automatic).length,1);
  }finally{await restarted?.close();await f.cleanup();}
});
test('member chat is a finite two-member exchange using relations, explicit fictional settings and two separate budget receipts',async()=>{
  const f=await fixture();try{
    const [first,,related]=f.engine.store.members();f.engine.store.put('members',first.id,{...first,relations:[{memberId:related.id,text:'喜欢一起讨论书里的故事'}],routine:{morning:'泡一壶茶'},quirks:['转笔']});
    await f.enable('member-chat');await f.open();await f.tick('member-chat');assert.equal(f.calls.length,2);
    assert.equal(f.calls[0].session.memberId??f.calls[0].session.provider,first.id);assert.equal(f.calls[1].session.memberId??f.calls[1].session.provider,related.id);assert.ok(f.calls[1].run.input.includes('已核对的发言'));assert.ok(f.calls[1].run.input.includes('自然收尾'));
    for(const call of f.calls){assert.equal(call.session.writeMode,false);assert.equal(call.settings.permissions[call.run.provider as 'claude'].commands,'deny');assert.ok(call.run.input.includes('不是真实发生的事'));assert.ok(!call.persona?.includes('泡一壶茶'));assert.ok(!call.persona?.includes('转笔'));}
    assert.equal(f.engine.snapshot().automation?.usage?.find(item=>item.feature==='member-chat')?.used,2);
    const parent=f.engine.store.list<TimedOccurrence>('timed_occurrences').find(item=>item.jobId===f.job('member-chat')?.id&&!item.parentOccurrenceId)!;assert.equal(parent.runIds?.length,2);assert.deepEqual(parent.memberIds,[first.id,related.id]);assert.notEqual(f.calls[0].run.automatic?.reservationId,f.calls[1].run.automatic?.reservationId);
    await f.tick('member-chat');assert.equal(f.calls.length,4);await f.tick('member-chat');assert.equal(f.calls.length,4);
  }finally{await f.cleanup();}
});
test('member chat requires two available members and enough remaining budget for the exchange',async()=>{
  const f=await fixture();try{await f.enable('member-chat',1);await f.open();await f.tick('member-chat');assert.equal(f.calls.length,0);assert.equal(f.engine.snapshot().automation!.usage!.find(item=>item.feature==='member-chat')!.used,0);}finally{await f.cleanup();}
});
for(const condition of ['hidden','busy','paused-discussion','unknown-discussion','paused-automation'])test(`member chat respects ${condition}`,async()=>{
  const f=await fixture();try{
    await f.enable('member-chat');if(condition!=='hidden')await f.open();
    if(condition==='busy')f.engine.store.put('room','state',{active:true,mode:'chat'});
    if(condition==='paused-discussion'||condition==='unknown-discussion')f.engine.store.put('room','state',{active:false,mode:'discuss',discussion:{phase:condition==='paused-discussion'?'paused':'unknown'}});
    if(condition==='paused-automation')await f.engine.invoke('automation.pause');
    await f.tick('member-chat');assert.equal(f.calls.length,0);
  }finally{await f.cleanup();}
});
test('unknown results hide their unconfirmed body, consume one attempt, stop the exchange and pause future triggers',async()=>{
  const f=await fixture(ctx=>{ctx.emit('message','unconfirmed-private-body',{source:'assistant'});return {unknown:true};});try{
    await f.enable('member-chat');await f.open();await f.tick('member-chat');assert.equal(f.calls.length,1);assert.ok(f.job('member-chat')?.pausedReason);
    assert.equal(f.engine.snapshot().room.messages.find(message=>message.automatic)?.text,'');assert.equal(f.engine.snapshot().automation?.usage?.find(item=>item.feature==='member-chat')?.used,1);
    await f.enable('member-chat');assert.ok(f.job('member-chat')?.pausedReason);await f.tick('member-chat');assert.equal(f.calls.length,1);
    await assert.rejects(f.engine.invoke('automation.life.acknowledge',{feature:'member-chat'}));await f.engine.invoke('automation.life.acknowledge',{feature:'member-chat',acknowledgeUnknown:true});assert.equal(f.calls.length,1);
  }finally{await f.cleanup();}
});
test('disabling a feature after the first member replies prevents the second call',async()=>{
  let engine:Engine;const f=await fixture(async ctx=>{ctx.emit('message','第一条已完成',{source:'assistant'});await engine.invoke('automation.policy.save',{policies:{'member-chat':{enabled:false,dailyLimit:4}}});return {};});engine=f.engine;
  try{await f.enable('member-chat');await f.open();await f.tick('member-chat');assert.equal(f.calls.length,1);assert.equal(f.engine.snapshot().automation?.usage?.find(item=>item.feature==='member-chat')?.used,1);}finally{await f.cleanup();}
});
test('a human pause after the first reply prevents the second call and never replays the partial exchange',async()=>{
  let engine:Engine;const f=await fixture(async ctx=>{ctx.emit('message','第一条已完成',{source:'assistant'});await engine.invoke('automation.pause');return {};});engine=f.engine;
  try{await f.enable('member-chat');await f.open();await f.tick('member-chat');assert.equal(f.calls.length,1);await engine.invoke('automation.resume');assert.equal(f.calls.length,1);}finally{await f.cleanup();}
});
test('changing the next member card after the first reply invalidates its queued turn',async()=>{
  let engine:Engine;const f=await fixture(async ctx=>{ctx.emit('message','第一条已完成',{source:'assistant'});const next=engine.store.members()[1];await engine.invoke('team.save',{member:{...next,name:'更新后的成员'}});return {};});engine=f.engine;
  try{await f.enable('member-chat');await f.open();await f.tick('member-chat');assert.equal(f.calls.length,1);const parent=engine.snapshot().automation!.recent.find(item=>!item.parentOccurrenceId&&item.jobId===f.job('member-chat')?.id)!;assert.match(parent.reason!,/成员资料已改变/);}finally{await f.cleanup();}
});
test('startup opening waits for pending read-only provider checks instead of losing the greeting',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM-daily-life-startup-'));let clock=start,release!:()=>void,calls=0;
  const gate=new Promise<void>(done=>{release=done;});
  const engine=new Engine(directory,()=>{},()=>{},id=>({probe:async()=>{await gate;return {id,name:id,available:true,auth:'subscription',detail:'fixture',capabilities:{steer:false,cancel:'native',streaming:true,write:false,history:true}};},start:async ctx=>{calls++;ctx.markDelivery('confirmed');ctx.emit('message','启动问候',{source:'assistant'});return {};},stop:async()=>{}}),{automationNow:()=>clock,automationTickMs:5});
  try{
    await engine.invoke('automation.policy.save',{policies:{'daily-opening':{enabled:true,dailyLimit:1}}});const probing=engine.probe();await engine.invoke('internal.room.opened',{visible:true});clock+=1000;
    await wait(()=>engine.snapshot().automation?.recent.some(item=>item.status==='running')===true);assert.equal(calls,0);release();await probing;await wait(()=>calls===1&&!engine.snapshot().room.state.active);
  }finally{release();await engine.close();assert.ok(path.basename(directory).startsWith('AIROOM-daily-life-startup-'));await fs.rm(directory,{recursive:true,force:true});}
});
test('hiding the window before queued speech is admitted withdraws it without spending the budget',async()=>{
  let release!:(value:AdapterResult)=>void;const f=await fixture(ctx=>{if(ctx.run.automatic)assert.fail('A hidden queued automatic call must not reach the model');return new Promise(done=>{release=done;});});
  try{
    await f.engine.invoke('settings.save',{maxParallel:1});const source=path.join(f.directory,'source');await fs.mkdir(source);const project=await f.engine.invoke('project.create',{directory:source}) as {id:string};const session=f.engine.createSession(project.id,'claude');await f.engine.send(session.id,'manual');await wait(()=>Boolean(release));
    await f.enable('member-chat');await f.open();const ticking=f.tick('member-chat');await wait(()=>f.engine.store.list<Run>('runs').some(run=>run.automatic&&run.status==='queued'));
    await f.open(false);release({});await ticking;assert.equal(f.calls.length,1);assert.equal(f.engine.snapshot().automation?.usage?.find(item=>item.feature==='member-chat')?.used,0);assert.equal(f.engine.store.list<Run>('runs').find(run=>run.automatic)?.delivery,'withdrawn');
  }finally{release?.({stopped:true});await f.cleanup();}
});
test('a worker crash marks both the parent and paid step unknown, preserves its budget and requires review',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM-daily-life-recovery-'));let clock=start;let engine:Engine|undefined;
  try{
    const store=new Store(directory);store.put('settings','main',{...DEFAULT_SETTINGS,automationPolicies:{'member-chat':{enabled:true,dailyLimit:4}},dailyLife:{memberChatMinutes:5}});
    const job={id:'recover-life',managed:'member-chat',name:'成员闲聊',enabled:true,revision:1,schedule:{kind:'interval',minutes:5},action:{kind:'member-chat'},createdAt:new Date(start).toISOString(),updatedAt:new Date(start).toISOString(),nextAt:new Date(start+300_000).toISOString()};store.put('timed_jobs',job.id,job);
    const parent={id:'old-parent',jobId:job.id,jobRevision:1,key:'old',dueAt:new Date(start).toISOString(),startedAt:new Date(start).toISOString(),status:'running'};store.put('timed_occurrences',parent.id,parent);store.put('timed_occurrences','old-step',{...parent,id:'old-step',parentOccurrenceId:parent.id,memberId:'claude',step:0});store.put('automatic_attempts','old-step',{id:'old-step',feature:'member-chat',day:'2026-10-04',runId:'missing-old-run',provider:'claude',at:parent.startedAt,status:'running'});store.put('automatic_usage','2026-10-04:member-chat',{day:'2026-10-04',feature:'member-chat',used:1});store.close();
    engine=new Engine(directory,()=>{},()=>{},()=>({probe:async()=>{throw new Error('unused');},start:async()=>{assert.fail('Do not replay a crashed step');},stop:async()=>{}}),{automationNow:()=>clock,automationTickMs:5});
    assert.equal(engine.store.get<TimedOccurrence>('timed_occurrences','old-parent')?.status,'unknown');assert.equal(engine.store.get<TimedOccurrence>('timed_occurrences','old-step')?.status,'unknown');assert.ok(engine.snapshot().automation?.jobs.find(item=>item.id===job.id)?.pausedReason);assert.equal(engine.snapshot().automation?.usage?.find(item=>item.feature==='member-chat')?.used,1);
    await engine.invoke('internal.room.opened',{visible:true});await engine.invoke('automation.policy.save',{policies:{'member-chat':{enabled:true,dailyLimit:4}}});assert.ok(engine.snapshot().automation?.jobs.find(item=>item.id===job.id)?.pausedReason);clock+=300_000;await wait(()=>engine!.snapshot().automation?.recent.some(item=>item.jobId===job.id&&item.status==='skipped')===true);
  }finally{await engine?.close();assert.ok(path.basename(directory).startsWith('AIROOM-daily-life-recovery-'));await fs.rm(directory,{recursive:true,force:true});}
});
test('all exhausted accounts pause member chat without a model call',async()=>{
  const f=await fixture();try{
    await f.enable('member-chat');await f.open();
    for(const id of ['claude','codex','dsh'] as ProviderId[]){const base={provider:id,checkedAt:new Date().toISOString(),source:'event',accountStamp:(f.engine as any).quotaAccountStamp(id)};f.engine.store.put('quotas',id,id==='dsh'?{...base,windows:[],balance:{status:'ready',wallets:[{currency:'CNY',balance:'0.004'}],bonusWallets:[],checkedAt:base.checkedAt}}:{...base,windows:[{id:'five_hour',label:'5 小时',usedPercent:100,exhausted:true,checkedAt:base.checkedAt}]});}
    await f.tick('member-chat');assert.equal(f.calls.length,0);assert.match(f.job('member-chat')!.pausedReason!,/所有可用成员/);await f.tick('member-chat');assert.equal(f.calls.length,0);
  }finally{await f.cleanup();}
});
test('an already blocked room session is never automatically redirected',async()=>{
  const f=await fixture();try{
    await f.enable('daily-opening');const member=f.engine.store.members()[0],project={id:'lounge',kind:'lounge',name:'room',directory:f.directory,createdAt:'',collaborationPaused:false};f.engine.store.put('projects','lounge',project);
    const session=f.engine.createSession('lounge',member.executor,'room',false,member.id);f.engine.store.put('blocked_sessions',session.id,{reason:'unknown'});await f.open();await f.tick('daily-opening');assert.notEqual(f.calls[0]?.session.memberId??f.calls[0]?.session.provider,member.id);assert.ok(f.engine.store.get('blocked_sessions',session.id));
  }finally{await f.cleanup();}
});
test('routine and quirks are explicit settings, and invalid intervals cannot become unbounded timers',()=>{
  const [member,other]=BUILTIN_MEMBERS;const prompt=memberChatPrompt({...member,routine:{morning:'喝茶'},quirks:['转笔']},other,start);assert.ok(prompt.includes('喝茶'));assert.ok(prompt.includes('转笔'));assert.ok(prompt.includes('角色设定，不是真实发生的事'));
  for(const minutes of [0,4,1441,Infinity,5.5,'5'])assert.throws(()=>validateDailyLife({memberChatMinutes:minutes}));assert.equal(validateDailyLife({memberChatMinutes:5}).memberChatMinutes,5);
});
