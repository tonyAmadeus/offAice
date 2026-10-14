import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Engine } from './helpers/seeded-engine';
import { Store } from '../src/backend/store';
import type { Adapter, AdapterContext, AdapterResult, Approval, Attachment, MemberProfile, Project, ProviderId, ProviderInfo, PushEvent, RoomMessage, RoomSummary, RoomThread, Run, Session, Settings } from '../src/shared/types';
import { installVersion } from '../src/backend/member-versions';
import { NativeResponseError } from '../src/backend/adapter-failure';
import { memoryEntries } from '../src/shared/memory';
import { CATALOG_REVISION } from '../src/shared/executor-catalog';

type Plan={probe?:(settings:Settings)=>ProviderInfo|Promise<ProviderInfo>;start?:(context:AdapterContext,adapter:ControlledAdapter)=>void|Promise<void>;delivery?:Run['delivery'];finishOnStop?:boolean;steer?:boolean|'throw';finish?:AdapterResult};
class ControlledAdapter implements Adapter {
  context?:AdapterContext;prompt='';stopCalls=0;steered:string[]=[];settled=false;
  private resolve!:(value:AdapterResult)=>void;private reject!:(error:Error)=>void;
  private gate=new Promise<AdapterResult>((resolve,reject)=>{this.resolve=resolve;this.reject=reject;});
  steer?: (text:string)=>Promise<boolean>;
  constructor(readonly provider:ProviderId,private plan:Plan={}) {
    if(plan.steer!==undefined)this.steer=async text=>{this.steered.push(text);if(plan.steer==='throw')throw new Error('lost steering receipt');return plan.steer===true;};
  }
  async probe(settings:Settings):Promise<ProviderInfo> { return this.plan.probe?.(settings)??{id:this.provider,name:this.provider,available:true,auth:this.provider==='deepseek'||this.provider==='dsh'?'api':'subscription',detail:'fake',capabilities:{steer:!!this.steer,cancel:'native',streaming:true,write:false,history:true}}; }
  async start(context:AdapterContext,prompt:string) {
    this.prompt=prompt;
    if(context.session.projectId==='lounge'&&prompt.includes('\nAIROOM_CONTEXT\n')){
      const input=JSON.parse(prompt.split('\nAIROOM_CONTEXT\n')[1]);const original=context;
      context={...original,emit:(kind,body,data,fidelity)=>original.emit(kind,kind==='delta'&&!body.trim().startsWith('{')?JSON.stringify({version:1,turn:input.turn,revision:input.revision,action:'speak',body}):body,data,fidelity)};
    }
    this.context=context;
    if(this.plan.delivery)context.markDelivery(this.plan.delivery);
    await this.plan.start?.(context,this);
    if(this.plan.finish)this.finish(this.plan.finish);
    return this.gate;
  }
  async stop() { this.stopCalls++;if(this.plan.finishOnStop!==false)this.finish({stopped:true}); }
  finish(result:AdapterResult={}) { this.settled=true;this.resolve(result); }
  fail(message='provider disconnected') { this.settled=true;this.reject(new Error(message)); }
}
const completed=new Set(['stopped','ended','completed','failed','unknown','interrupted','rate_limited']);
async function waitFor<T>(read:()=>T|undefined|false,label:string,timeout=3000):Promise<T> {
  const deadline=Date.now()+timeout;
  for(;;){const value=read();if(value)return value as T;if(Date.now()>deadline)assert.fail(`Timed out: ${label}`);await new Promise(resolve=>setTimeout(resolve,10));}
}
async function harness(plans:Partial<Record<ProviderId,Plan|Plan[]>>={},timing?:{runBudgetMs:number},installer?:typeof installVersion) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM engine 中文-'));
  const source=path.join(directory,'项目');await fs.mkdir(source);await fs.writeFile(path.join(source,'file.txt'),'source');
  const instances:ControlledAdapter[]=[],events:PushEvent[]=[];
  const queues=new Map<ProviderId,Plan[]>();for(const [id,value] of Object.entries(plans))queues.set(id as ProviderId,Array.isArray(value)?[...value]:[value!]);
  const engine=new Engine(path.join(directory,'data'),event=>events.push(event),()=>{},provider=>{if(provider.startsWith('acp-')&&!queues.has(provider))return undefined as unknown as Adapter;const adapter=new ControlledAdapter(provider,queues.get(provider)?.shift()??{delivery:'confirmed'});instances.push(adapter);return adapter;},timing,installer);
  (engine as any).discussion.host.random=()=>0;
  const project=await engine.invoke('project.create',{directory:source}) as Project;
  const session=(provider:ProviderId='claude')=>engine.createSession(project.id,provider);
  const run=(id:string)=>engine.store.get<Run>('runs',id)!;
  const started=(id:string)=>waitFor(()=>instances.find(adapter=>adapter.context?.run.id===id),'adapter start');
  const send=async(sessionId:string,text='task',intent:'message'|'supplement'|'redirect'='message')=>engine.send(sessionId,text,intent) as Promise<{runId:string;delivery:string}>;
  async function dispose() {
    for(const adapter of instances)adapter.finish({stopped:true});
    await engine.close();
    const target=path.resolve(directory),temporary=path.resolve(os.tmpdir());assert.ok(path.relative(temporary,target).startsWith('AIROOM engine 中文-'));
    await fs.rm(target,{recursive:true,force:true});
  }
  const roomSend=async(params:any)=>{
    const d=engine.store.roomState().discussion;
    const result=await engine.invoke('room.send',{mode:'discuss',style:'chat',maxCalls:params.memberIds?.length??1,maxMinutes:0,...params});
    if(d&&['paused','budget'].includes(engine.store.roomState().discussion?.phase??'')&&params.mode!=='discuss')await engine.invoke('room.resume',{maxCalls:params.maxCalls??params.memberIds?.length??1});
    return result;
  };
  return {engine,instances,events,project,source,directory,session,run,started,send,dispose,roomSend};
}

test('repeated native session announcements do not broadcast snapshots, while a changed home is saved',async()=>{
  const h=await harness({claude:{delivery:'confirmed'}});
  try{
    const session=h.session(),sent=await h.send(session.id),adapter=await h.started(sent.runId),ctx=adapter.context!;
    await new Promise<void>(resolve=>setImmediate(resolve));
    const before=h.events.filter(e=>e.type==='snapshot').length;
    for(let i=0;i<200;i++)ctx.persistNativeSession('same-native-session','shared');
    assert.equal(h.engine.store.get<Session>('sessions',session.id)?.nativeHome,'shared','native identity is persisted before the coalesced publication');
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(h.events.filter(e=>e.type==='snapshot').length-before,1);
    ctx.persistNativeSession('same-native-session','airoom');
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(h.events.filter(e=>e.type==='snapshot').length-before,2);
    assert.equal(h.engine.store.get<Session>('sessions',session.id)?.nativeHome,'airoom');
    await h.engine.stopRun(sent.runId);assert.equal(adapter.stopCalls,1);assert.equal(h.run(sent.runId).status,'stopped');
  }finally{await h.dispose();}
});

test('manual acceptance allows a blank comment but still requires a confirmed finished run',async()=>{
  const h=await harness({claude:{delivery:'confirmed',finish:{},start:ctx=>{ctx.emit('delta','已生成的成果。');}}});
  try{
    const s=h.session(),sent=await h.send(s.id);await waitFor(()=>h.run(sent.runId).status==='ended','finished run');
    await h.engine.invoke('run.validate',{runId:sent.runId});assert.equal(h.run(sent.runId).status,'completed');assert.equal(h.run(sent.runId).validation,'用户确认验收，未补充说明。');
  }finally{await h.dispose();}
});

test('ending the visible discussion stops its native turn and rejects stale control without touching the active turn',async()=>{
  const h=await harness({claude:{delivery:'confirmed'}});
  try{
    await h.roomSend({text:'讨论一个问题',mode:'discuss',memberIds:['claude'],maxCalls:10,maxMinutes:0});const message=await waitFor(()=>h.engine.store.allRoomMessages(h.engine.store.currentRoomThread().id).find(item=>item.runId),'discussion run');const adapter=await h.started(message.runId!);const id=h.engine.store.roomState().discussion!.id;
    await assert.rejects(h.engine.invoke('room.end',{discussionId:'old-topic'}),/讨论已切换/);assert.equal(adapter.stopCalls,0);assert.equal(h.engine.store.roomState().active,true);
    await h.engine.invoke('room.end',{discussionId:id});assert.equal(adapter.stopCalls,1);assert.equal(h.engine.store.roomState().active,false);assert.equal(h.engine.store.roomState().discussion!.endedBy,'user');assert.equal(h.engine.store.roomState().discussion!.proposal,undefined);assert.equal(h.engine.store.roomState().discussion!.phase,'idle');
  }finally{await h.dispose();}
});

test('last-round undo preserves earlier work and RoomLink provenance, blocks shared reviews and invalidates acceptance',async()=>{
  const h=await harness({claude:[{delivery:'confirmed',start:async ctx=>{await fs.writeFile(path.join(ctx.cwd,'earlier.txt'),'round one');ctx.emit('message','第一轮结果',{source:'assistant'});},finish:{}},{delivery:'confirmed',start:async ctx=>{await fs.writeFile(path.join(ctx.cwd,'file.txt'),'round two');await fs.unlink(path.join(ctx.cwd,'earlier.txt'));ctx.emit('message','第二轮结果',{source:'assistant'});},finish:{}}]});
  try{
    const session=h.session(),handoff=async(text:string)=>h.engine.invoke('room.handoff',{projectId:h.project.id,sessionId:session.id,text}) as Promise<{runId:string}>;
    const one=await handoff('first');await waitFor(()=>h.run(one.runId).workspaceUndo?.status==='available','first checkpoint');
    const two=await handoff('second');await waitFor(()=>h.run(two.runId).workspaceUndo?.status==='available','second checkpoint');
    const workspace=h.engine.store.get<Session>('sessions',session.id)!.workspace!;
    assert.equal(h.run(one.runId).workspaceUndo?.status,'superseded');await assert.rejects(h.engine.invoke('workspace.undo',{sessionId:session.id,runId:one.runId}),/最近一轮已经改变/);
    const review=await h.engine.invoke('run.review',{runId:two.runId,memberId:'codex'}) as {runId:string;sessionId:string};
    const reviewer=await h.started(review.runId);assert.equal(reviewer.context?.cwd,workspace);const {fingerprint,...reviewed}=h.run(review.runId).origin!.reviewOf!;assert.deepEqual(reviewed,{sessionId:session.id,runId:two.runId});assert.match(fingerprint!,/^[a-f0-9]{64}$/);
    for(const method of ['workspace.undo','workspace.apply','workspace.discard'])await assert.rejects(h.engine.invoke(method,{sessionId:session.id,runId:two.runId}),/还有任务/);
    reviewer.finish();await waitFor(()=>h.run(review.runId).status==='ended','review completion');await new Promise(resolve=>setTimeout(resolve,20));
    const undo=h.engine.invoke('workspace.undo',{sessionId:session.id,runId:two.runId});await assert.rejects(h.send(session.id,'race with undo'),/正在整理/);const result=await undo as any;assert.equal(result.status,'undone');
    assert.equal(await fs.readFile(path.join(workspace,'earlier.txt'),'utf8'),'round one');assert.equal(await fs.readFile(path.join(workspace,'file.txt'),'utf8'),'source');assert.equal(await fs.readFile(path.join(h.source,'file.txt'),'utf8'),'source');
    const notes=h.engine.store.list<RoomMessage>('room_messages').filter(message=>message.link?.runId===two.runId||message.link?.reviewOf?.runId===two.runId);assert.ok(notes.length>=3);assert.ok(notes.every(note=>note.link?.undoneAt));
    const reviewNote=notes.find(message=>message.link?.reviewOf?.runId===two.runId)!;assert.equal(reviewNote.link?.runId,review.runId);
    await assert.rejects(h.engine.invoke('run.validate',{runId:two.runId,validation:'wrong stale acceptance'}),/已撤销/);
    await assert.rejects(h.engine.invoke('run.verdict',{messageId:reviewNote.id,verdict:'accepted'}),/已撤销/);
    await assert.rejects(h.engine.invoke('run.review',{runId:two.runId,memberId:'codex'}),/已撤销/);
  }finally{await h.dispose();}
});
const reviewRounds=(...writes:string[])=>({claude:writes.map(text=>({delivery:'confirmed' as const,start:async(ctx:any)=>{await fs.writeFile(path.join(ctx.cwd,'file.txt'),text);ctx.emit('message',`写入：${text}`,{source:'assistant'});},finish:{}}))});
async function reviewed(h:Awaited<ReturnType<typeof harness>>){
  const session=h.session(),one=await h.engine.invoke('room.handoff',{projectId:h.project.id,sessionId:session.id,text:'first'}) as {runId:string};
  await waitFor(()=>h.run(one.runId).workspaceUndo?.status==='available','first checkpoint');
  const review=await h.engine.invoke('run.review',{runId:one.runId,memberId:'codex'}) as {runId:string};(await h.started(review.runId)).finish();
  const note=await waitFor(()=>h.engine.store.list<RoomMessage>('room_messages').find(message=>message.link?.reviewOf?.runId===one.runId&&message.link.outcome),'review note');
  return {session,one,note,workspace:h.engine.store.get<Session>('sessions',session.id)!.workspace!};
}
test('a review of unchanged files can still be used to accept the round',async()=>{
  const h=await harness(reviewRounds('reviewed'));
  try{const {one,note}=await reviewed(h);await h.engine.invoke('run.verdict',{messageId:note.id,verdict:'accepted'});assert.equal(h.run(one.runId).status,'completed');}finally{await h.dispose();}
});
test('another round after a review marks it stale, and acceptance through it is refused',async()=>{
  const h=await harness(reviewRounds('reviewed','changed after review'));
  try{
    const {session,one,note}=await reviewed(h);
    const two=await h.engine.invoke('room.handoff',{projectId:h.project.id,sessionId:session.id,text:'second'}) as {runId:string};
    await waitFor(()=>h.engine.store.get<RoomMessage>('room_messages',note.id)?.link?.reviewStale,'stale mark after the next round');
    assert.ok(h.run(two.runId).completedAt);
    await assert.rejects(h.engine.invoke('run.verdict',{messageId:note.id,verdict:'accepted'}),/复核已经过期/);assert.equal(h.run(one.runId).status,'ended');
  }finally{await h.dispose();}
});
test('a file edited outside AIROOM after a review is caught when accepting through the review',async()=>{
  const h=await harness(reviewRounds('reviewed'));
  try{
    const {one,note,workspace}=await reviewed(h);
    await fs.writeFile(path.join(workspace,'file.txt'),'edited by hand');
    await assert.rejects(h.engine.invoke('run.verdict',{messageId:note.id,verdict:'accepted'}),/复核已经过期/);
    assert.ok(h.engine.store.get<RoomMessage>('room_messages',note.id)!.link!.reviewStale);assert.equal(h.run(one.runId).status,'ended');
  }finally{await h.dispose();}
});
test('an uncertain stopped native round still records partial file edits, and undo never marks delivery as successful',async()=>{
  const h=await harness({claude:{delivery:'confirmed',start:async(ctx,adapter)=>{await fs.writeFile(path.join(ctx.cwd,'file.txt'),'partial native write');adapter.fail();}}});
  try{
    const session=h.session(),sent=await h.send(session.id);await waitFor(()=>h.run(sent.runId).workspaceUndo?.status==='available','partial checkpoint');assert.equal(h.run(sent.runId).status,'unknown');
    const result=await h.engine.invoke('workspace.undo',{sessionId:session.id,runId:sent.runId}) as any;assert.equal(result.status,'undone');assert.equal(h.run(sent.runId).status,'unknown');assert.equal(h.run(sent.runId).delivery,'confirmed');
    assert.ok(h.engine.store.get('blocked_sessions',session.id));assert.equal(await fs.readFile(path.join(h.engine.store.get<Session>('sessions',session.id)!.workspace!,'file.txt'),'utf8'),'source');
  }finally{await h.dispose();}
});
test('quotas aggregate across sessions, survive restart, ignore token/tool output and clear after account invalidation',async()=>{
  const h=await harness();let reopened:Engine|undefined;
  try{
    const session=h.engine.createSession(h.project.id,'codex',undefined,false),sent=await h.send(session.id),adapter=await h.started(sent.runId);
    const quota={rateLimitsByLimitId:{codex:{primary:{usedPercent:85,windowDurationMins:300},secondary:{usedPercent:17,windowDurationMins:10080}}}};
    adapter.context!.emit('usage','quota',quota);adapter.context!.emit('usage','tokens',{usage:{input_tokens:500000}});adapter.context!.emit('tool','untrusted file content',{rateLimits:{primary:{usedPercent:0,windowDurationMins:300}}});
    assert.deepEqual(h.engine.snapshot().quotas.codex!.windows.map(window=>window.usedPercent),[85,17]);adapter.finish();await waitFor(()=>h.run(sent.runId).status==='ended','quota run completion');
    await h.engine.close();reopened=new Engine(path.join(h.directory,'data'),()=>{},()=>{},()=>new ControlledAdapter('codex'));
    assert.deepEqual(reopened.snapshot().quotas.codex!.windows.map(window=>window.usedPercent),[85,17]);await reopened.invoke('internal.provider.invalidate',{provider:'codex'});assert.equal(reopened.snapshot().quotas.codex!.windows.length,0);
    await reopened.close();reopened=new Engine(path.join(h.directory,'data'),()=>{},()=>{},()=>new ControlledAdapter('codex'));assert.equal(reopened.snapshot().quotas.codex!.windows.length,0,'old usage events cannot resurrect the previous account');
  }finally{await reopened?.close();await h.dispose();}
});

test('member stop during workspace preparation settles without starting a provider',async()=>{
  const h=await harness();try {
    const session=h.session(),sent=await h.send(session.id);
    await h.engine.stopRun(sent.runId);
    await waitFor(()=>h.run(sent.runId).status==='stopped','startup cancellation');
    assert.equal(h.run(sent.runId).delivery,'withdrawn');assert.ok(!h.instances.some(x=>x.context));
  } finally {await h.dispose();}
});

test('known native failure and rate rejection retain delivery confirmation, stop queues and survive restart',async()=>{
  for(const kind of ['failed','rate_limited','blocked','aborted'] as const){
    const h=await harness({dsh:{delivery:'confirmed'}});try{
      h.engine.setKey('fixture-api-fallback-key');const session=h.session('dsh'),sent=await h.send(session.id),adapter=await h.started(sent.runId);
      const queued=await h.send(session.id,'old automatic followup');adapter.finish({failure:{kind,message:'native '+kind}});
      await waitFor(()=>h.run(sent.runId).completedAt,'known terminal outcome');
      const run=h.run(sent.runId);assert.equal(run.delivery,'confirmed');assert.equal(run.stopReason,kind);
      assert.equal(run.status,kind==='aborted'?'stopped':kind==='rate_limited'?'rate_limited':'failed');
      assert.equal(h.run(queued.runId).delivery,'withdrawn');assert.ok(!h.instances.some(x=>x.provider==='deepseek'));
      h.engine.store.recover('another-boot');assert.equal(h.run(sent.runId).status,run.status);
    }finally{await h.dispose();}
  }
});

test('protocol errors are known rejections while transport failure preserves an existing receipt',async()=>{
  const native=await harness({codex:{delivery:'confirmed',start:()=>{throw new NativeResponseError('429 quota exceeded',429);}}});
  try{const session=native.session('codex'),sent=await native.send(session.id);await waitFor(()=>native.run(sent.runId).completedAt,'native failure');assert.equal(native.run(sent.runId).status,'rate_limited');assert.equal(native.run(sent.runId).delivery,'confirmed');assert.equal(native.run(sent.runId).error,'429 quota exceeded');const event=native.engine.store.listEvents(session.id).find(event=>(event.data as any)?.code===429)!;assert.ok(event);assert.match(event.text,/额度或请求频率/);assert.equal((event.data as any).nativeError,'429 quota exceeded');}finally{await native.dispose();}
  const transport=await harness({codex:{delivery:'confirmed'}});
  try{const sent=await transport.send(transport.session('codex').id),adapter=await transport.started(sent.runId);adapter.fail();await waitFor(()=>transport.run(sent.runId).status==='unknown','transport failure');assert.equal(transport.run(sent.runId).delivery,'confirmed');}finally{await transport.dispose();}
});

test('unknown provider reasons remain visible without retrying the turn or its queued followup',async()=>{
  const h=await harness({codex:{delivery:'sent'}});
  try{
    const session=h.session('codex'),sent=await h.send(session.id),adapter=await h.started(sent.runId),queued=await h.send(session.id,'queued followup');
    const reason='ZCode BigModel 中国区 套餐不可用（1113：余额不足或没有可用资源包）。请核对登录地区、账号套餐和额度。';
    adapter.finish({unknown:true,unknownReason:reason});await waitFor(()=>h.run(sent.runId).completedAt,'unknown result');
    assert.equal(h.run(sent.runId).status,'unknown');assert.equal(h.run(sent.runId).delivery,'unknown');assert.equal(h.run(sent.runId).error,reason);
    assert.equal(h.run(queued.runId).delivery,'withdrawn');assert.equal(h.instances.filter(item=>item.context).length,1);
    h.engine.store.recover('another-boot');assert.equal(h.run(sent.runId).error,reason);assert.equal(h.run(sent.runId).status,'unknown');assert.equal(h.instances.filter(item=>item.context).length,1);
  }finally{await h.dispose();}
});

const memberInfo=(patch:Partial<ProviderInfo>={}):ProviderInfo=>({id:'claude',name:'Claude',available:true,auth:'subscription',detail:'fixture',capabilities:{steer:false,cancel:'process',streaming:true,write:true,history:true},...patch});
test('member switch validates before committing and accepts a working runtime that only needs login',async()=>{
  const h=await harness({claude:[{probe:()=>memberInfo({available:false,auth:'unknown',detail:'incompatible protocol'})},{probe:()=>memberInfo({available:false,auth:'none',runtimeReady:true})}]});
  try{
    h.engine.settings.paths.claude='previous-claude.exe';h.engine.store.put('settings','main',h.engine.settings);
    await assert.rejects(h.engine.invoke('member.use',{provider:'claude',version:null}),/原版本已保留/);
    assert.equal(h.engine.settings.paths.claude,'previous-claude.exe');assert.equal(h.engine.store.get<Settings>('settings','main')?.paths.claude,'previous-claude.exe');
    const result=await h.engine.invoke('member.use',{provider:'claude',version:null}) as any;
    assert.equal(result.selectedPath,null);assert.equal(h.engine.settings.paths.claude,undefined);
  }finally{await h.dispose();}
});

test('overlapping switches are rejected and a concurrent settings save is not overwritten',async()=>{
  let entered!:()=>void,release!:(info:ProviderInfo)=>void;const begun=new Promise<void>(resolve=>entered=resolve),gate=new Promise<ProviderInfo>(resolve=>release=resolve);
  const h=await harness({claude:{probe:()=>{entered();return gate;}}});
  try{
    h.engine.settings.paths.claude='previous-claude.exe';const switching=h.engine.invoke('member.use',{provider:'claude',version:null});await begun;
    await assert.rejects(h.engine.invoke('member.use',{provider:'claude',version:null}),/正在安装或切换/);
    await h.engine.invoke('settings.save',{settings:{maxParallel:2}});release(memberInfo());
    await assert.rejects(switching,/设置已改变/);assert.equal(h.engine.settings.maxParallel,2);assert.equal(h.engine.settings.paths.claude,'previous-claude.exe');
  }finally{release(memberInfo());await h.dispose();}
});

test('an installation that finishes during a newly started task does not switch its runtime',async()=>{
  let entered!:()=>void,release!:()=>void;const begun=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  const installer:typeof installVersion=async(_data,_member,_version,_env,options)=>{options?.progress?.({phase:'launch',writtenBytes:2048,lastProgressAt:new Date().toISOString()});entered();await gate;return {version:'2.1.289',entry:'new-claude.exe'};};
  const h=await harness({},undefined,installer);
  try{
    h.engine.store.put('catalog_consents','claude',{revision:CATALOG_REVISION});
    h.engine.settings.paths.claude='previous-claude.exe';const installing=h.engine.invoke('member.install',{provider:'claude',version:'2.1.289'});await begun;
    const progress=await h.engine.invoke('member.installation',{provider:'claude'}) as any;
    assert.equal(progress.phase,'launch');assert.equal(progress.version,'2.1.289');assert.equal(progress.writtenBytes,2048);
    await assert.rejects(h.engine.invoke('member.use',{provider:'claude',version:null}),/正在安装或切换/);
    const sent=await h.send(h.session().id);await h.started(sent.runId);release();
    const result=await installing as any;assert.equal(result.installedOnly,true);assert.equal(result.selectedPath,'previous-claude.exe');assert.match(result.detail,/空闲/);
    assert.equal(result.installation,undefined);assert.equal(await h.engine.invoke('member.installation',{provider:'claude'}),undefined);
    assert.equal(h.engine.settings.paths.claude,'previous-claude.exe');
  }finally{release();await h.dispose();}
});

test('failed installs clear backend progress and preserve the selected program',async()=>{
  let entered!:()=>void,release!:()=>void;const begun=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  const installer:typeof installVersion=async()=>{entered();await gate;throw new Error('download disconnected');};
  const h=await harness({},undefined,installer);
  try{
    h.engine.store.put('catalog_consents','claude',{revision:CATALOG_REVISION});
    h.engine.settings.paths.claude='previous-claude.exe';const installing=h.engine.invoke('member.install',{provider:'claude',version:'2.1.292'});const rejected=assert.rejects(installing,/download disconnected/);await begun;
    assert.equal((await h.engine.invoke('member.installation',{provider:'claude'}) as any).phase,'installing');
    release();await rejected;
    assert.equal(await h.engine.invoke('member.installation',{provider:'claude'}),undefined);assert.equal(h.engine.settings.paths.claude,'previous-claude.exe');
  }finally{release();await h.dispose();}
});

test('version removal rejects a selected directory even if that installation has become incomplete',async()=>{
  const h=await harness();try{
    const directory=path.join(h.engine.store.dataDirectory,'members/claude/2.1.288');await fs.mkdir(directory,{recursive:true});
    h.engine.settings.paths.claude=path.join(directory,'node_modules/@anthropic-ai/claude-code/cli.js');
    await assert.rejects(h.engine.invoke('member.remove',{provider:'claude',version:'2.1.288'}),/正在使用的版本/);
    assert.ok((await fs.stat(directory)).isDirectory());
    h.engine.settings.paths.claude=undefined;await h.engine.invoke('member.remove',{provider:'claude',version:'2.1.288'});
    await assert.rejects(fs.stat(directory),{code:'ENOENT'});
  }finally{await h.dispose();}
});

test('immediate redirect preserves the new revision through workspace preparation',async()=>{
  const h=await harness();try {
    const session=h.session(),old=await h.send(session.id,'old direction');
    const next=await h.send(session.id,'new direction','redirect');
    const adapter=await h.started(next.runId);
    assert.equal(h.engine.store.get<Session>('sessions',session.id)?.revision,2);
    assert.equal(h.run(old.runId).status,'stopped');assert.equal(h.run(next.runId).revision,2);assert.match(adapter.prompt,/new direction/);assert.doesNotMatch(adapter.prompt,/old direction/);
    adapter.finish({});await waitFor(()=>h.run(next.runId).status==='ended','new result');
  } finally {await h.dispose();}
});

test('member stop withdraws its queued requirements while preserving other sessions',async()=>{
  const h=await harness();try {
    const first=h.session(),second=h.session('codex'),active=await h.send(first.id,'active');await h.started(active.runId);
    const queued=await h.send(first.id,'queued followup'),other=await h.send(second.id,'independent');const independent=await h.started(other.runId);
    assert.equal(queued.delivery,'queued');await h.engine.stopRun(active.runId);
    assert.equal(h.run(active.runId).status,'stopped');assert.equal(h.run(queued.runId).status,'stopped');assert.equal(h.run(queued.runId).delivery,'withdrawn');
    assert.equal(h.run(other.runId).status,'running');assert.equal(independent.stopCalls,0);assert.ok(!h.instances.some(x=>x.context?.run.id===queued.runId));
    const explicit=await h.send(first.id,'new explicitly requested task');const resumed=await h.started(explicit.runId);assert.equal(h.run(explicit.runId).revision,2);resumed.finish({});
  } finally {await h.dispose();}
});

test('accepted steering has one durable receipt; unavailable steering becomes a queued run',async()=>{
  const h=await harness({codex:{delivery:'confirmed',steer:true},claude:{delivery:'confirmed',steer:false}});try {
    const codex=h.session('codex'),sent=await h.send(codex.id);const adapter=await h.started(sent.runId);
    const receipt=await h.send(codex.id,'current constraint','supplement');assert.equal(receipt.delivery,'current');assert.equal(receipt.runId,sent.runId);assert.deepEqual(adapter.steered,['current constraint']);
    assert.equal(h.engine.store.list<Run>('runs').filter(run=>run.sessionId===codex.id).length,1);
    assert.ok(h.engine.store.list<any>('outbox').some(entry=>entry.kind==='steer'&&entry.delivery==='confirmed'));
    // The run receipt points at the run, which holds the task; only supplements carry their own text.
    assert.equal('text' in h.engine.store.get<any>('outbox',sent.runId),false);assert.equal(h.engine.store.list<any>('outbox').find(entry=>entry.kind==='steer')?.text,'current constraint');
    const claude=h.session(),initial=await h.send(claude.id);await h.started(initial.runId);const queued=await h.send(claude.id,'next constraint','supplement');assert.equal(queued.delivery,'queued');assert.equal(h.run(queued.runId).status,'queued');
  } finally {await h.dispose();}
});

test('unknown steering receipt never generates a second automatic request',async()=>{
  const h=await harness({codex:{delivery:'confirmed',steer:'throw'}});try {
    const session=h.session('codex'),sent=await h.send(session.id);const adapter=await h.started(sent.runId);
    await assert.rejects(h.send(session.id,'important constraint','supplement'),/lost steering receipt/);
    assert.equal(adapter.steered.length,1);assert.equal(h.engine.store.list<Run>('runs').length,1);assert.ok(h.engine.store.list<any>('outbox').some(entry=>entry.kind==='steer'&&entry.delivery==='unknown'));
  } finally {await h.dispose();}
});

test('late native completion after stop remains stopped and does not validate',async()=>{
  const h=await harness({claude:{delivery:'confirmed',finishOnStop:false}});try {
    const session=h.session(),sent=await h.send(session.id);const adapter=await h.started(sent.runId);
    const stopping=h.engine.stopRun(sent.runId);await waitFor(()=>adapter.stopCalls===1,'stop receipt');assert.equal(h.run(sent.runId).status,'stopping');
    adapter.context!.emit('delta','partial preserved result');adapter.finish({summary:'provider reported success late'});await stopping;
    assert.equal(h.run(sent.runId).status,'stopped');assert.match(h.engine.store.listEvents(session.id).map(x=>x.text).join(''),/partial preserved result/);
    await assert.rejects(h.engine.invoke('run.validate',{runId:sent.runId,validation:'looks done'}),/不能直接验收/);
  } finally {await h.dispose();}
});

test('stopping expires native approvals and late questions are rejected',async()=>{
  const h=await harness({claude:{delivery:'confirmed',start:async context=>{await context.approve({type:'approval',title:'write',detail:'file',options:[{id:'allow_once',label:'allow once'},{id:'reject_once',label:'deny'}]});}}});try {
    const session=h.session(),sent=await h.send(session.id);const adapter=await h.started(sent.runId);
    const approval=await waitFor(()=>h.engine.store.list<Approval>('approvals').find(x=>x.state==='pending'),'approval');
    await h.engine.stopRun(sent.runId);assert.equal(h.engine.store.get<Approval>('approvals',approval.id)?.state,'expired');
    await assert.rejects(h.engine.invoke('approval.answer',{id:approval.id,choice:'allow_once'}),/失效/);
    await assert.rejects(adapter.context!.approve({type:'question',title:'late',detail:'late',options:[]}),/已停止或结束/);
  } finally {await h.dispose();}
});

test('a DSH start failure fails the turn; the retired DeepSeek API stand-in is never used',async()=>{
  const h=await harness({dsh:{start:()=>{throw new Error('entry unavailable');}}});try {
    const session=h.session('dsh'),sent=await h.send(session.id);
    await waitFor(()=>completed.has(h.run(sent.runId).status),'failed run');
    assert.equal(h.run(sent.runId).provider,'dsh');assert.ok(['failed','unknown'].includes(h.run(sent.runId).status));
    assert.ok(!h.instances.some(x=>x.provider==='deepseek'),'no API fallback');
  } finally {await h.dispose();}
});

test('sent or acknowledged DSH failure blocks queued continuation and never falls back',async()=>{
  for(const delivery of ['sent','confirmed'] as const) {
    const h=await harness({dsh:{delivery}});try {
      h.engine.setKey('runtime-private-key-123456789');const session=h.session('dsh'),sent=await h.send(session.id);const adapter=await h.started(sent.runId);const queued=await h.send(session.id,'queued followup');
      adapter.fail();await waitFor(()=>h.run(sent.runId).status==='unknown','uncertain failure');
      assert.equal(h.run(queued.runId).status,'stopped');assert.equal(h.run(queued.runId).delivery,'withdrawn');assert.ok(!h.instances.some(x=>x.provider==='deepseek'));
      await assert.rejects(h.send(session.id,'retry as supplement','supplement'),/明确发送新的任务/);
      const explicit=await h.send(session.id,'inspect what happened');const next=await h.started(explicit.runId);assert.equal(h.run(explicit.runId).revision,2);next.finish({});
    } finally {await h.dispose();}
  }
});

test('runtime key echoes are redacted in persisted events, UI and artifact previews',async()=>{
  const h=await harness();try {
    const key='06c96465c597685cc07d96ff7db37451b';h.engine.setKey(key);await fs.writeFile(path.join(h.source,'credential.txt'),`raw key ${key}`);
    const session=h.session(),sent=await h.send(session.id);const adapter=await h.started(sent.runId);adapter.context!.emit('output',`tool echoed ${key}`);
    const preview=await h.engine.invoke('artifact.read',{sessionId:session.id,relativePath:'credential.txt'}) as {content:string};
    assert.ok(!preview.content.includes(key));assert.match(preview.content,/敏感凭据已脱敏/);assert.ok(!JSON.stringify(h.engine.snapshot()).includes(key));assert.ok(!JSON.stringify(h.events).includes(key));
    assert.equal(await fs.readFile(path.join(h.source,'credential.txt'),'utf8'),`raw key ${key}`);
  } finally {await h.dispose();}
});

test('restart preserves unknown delivery and expires requests without dispatching adapters',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM engine 中文-'));const data=path.join(directory,'data');const store=new Store(data);const at=new Date().toISOString();
  const run:Run={id:'run',sessionId:'session',projectId:'project',provider:'dsh',revision:1,status:'running',input:'do work',createdAt:at,updatedAt:at,bootId:'previous',delivery:'confirmed'};
  store.put('runs',run.id,run);store.put('outbox',run.id,{runId:run.id,sessionId:run.sessionId,delivery:'confirmed'});store.put('outbox','steer-independent-id',{runId:run.id,kind:'steer',delivery:'prepared'});store.put('approvals','approval',{id:'approval',runId:run.id,state:'pending'});store.close();let created=0;
  const engine=new Engine(data,()=>{},()=>{},provider=>{created++;return new ControlledAdapter(provider);});
  try {
    assert.equal(engine.store.get<Run>('runs','run')?.status,'unknown');assert.equal(engine.store.get<any>('outbox','run')?.delivery,'unknown');assert.equal(engine.store.get<any>('outbox','steer-independent-id')?.delivery,'unknown');assert.equal(engine.store.get<any>('approvals','approval')?.state,'expired');assert.equal(created,0);
  } finally {await engine.close();const resolved=path.resolve(directory);assert.ok(path.relative(os.tmpdir(),resolved).startsWith('AIROOM engine 中文-'));await fs.rm(resolved,{recursive:true,force:true});}
});

test('precise pause phrases block later handoffs while retaining current execution',async()=>{
  const h=await harness();try {
    const session=h.session(),active=await h.send(session.id);const adapter=await h.started(active.runId);const queued=await h.send(session.id,'later instruction');
    const receipt=await h.engine.send(session.id,'这个做完先等我看。') as {delivery:string;activeTaskContinues:boolean};
    assert.equal(receipt.delivery,'paused');assert.equal(receipt.activeTaskContinues,true);assert.equal(adapter.stopCalls,0);assert.equal(h.run(active.runId).status,'running');assert.equal(h.run(queued.runId).status,'stopped');
    adapter.finish({});await waitFor(()=>h.run(active.runId).status==='ended','current finishes');assert.equal(h.engine.store.list<Run>('runs').length,2);
  } finally {await h.dispose();}
});

test('close drains startup and late cancellation before closing SQLite',async()=>{
  const h=await harness();const sent=await h.send(h.session().id);const closing=h.engine.close();await closing;assert.ok(!h.instances.some(x=>x.context));
  const reopened=new Store(path.join(h.directory,'data'));try {assert.equal(reopened.get<Run>('runs',sent.runId)?.status,'stopped');}finally{reopened.close();}
  await assert.rejects(h.engine.send('missing','cannot start'),/正在退出/);
  const resolved=path.resolve(h.directory);assert.ok(path.relative(os.tmpdir(),resolved).startsWith('AIROOM engine 中文-'));await fs.rm(resolved,{recursive:true,force:true});
});

test('run deadline cancels the member and its queue while completed runs clear their timer',async()=>{
  const h=await harness({}, {runBudgetMs:120});try {
    const settings=await h.engine.invoke('settings.save',{maxRunMinutes:0,deepseekMaxRequests:999}) as {maxRunMinutes:number;deepseekMaxRequests:number};assert.equal(settings.maxRunMinutes,1);assert.equal(settings.deepseekMaxRequests,200);
    const session=h.session(),sent=await h.send(session.id);const adapter=await h.started(sent.runId);const queued=await h.send(session.id,'should not restart');
    await waitFor(()=>h.run(sent.runId).status==='stopped','run deadline stops');assert.equal(adapter.stopCalls,1);assert.equal(h.run(queued.runId).status,'stopped');assert.match(h.run(sent.runId).error??'',/运行时限/);
    const completed=await h.send(session.id,'new task within budget');const next=await h.started(completed.runId);next.finish({});await waitFor(()=>h.run(completed.runId).status==='ended','new task ended');
    await new Promise(resolve=>setTimeout(resolve,160));assert.equal(next.stopCalls,0);assert.equal(h.run(completed.runId).status,'ended');
  }finally{await h.dispose();}
});

test('stream batching keeps native item/channel metadata, fidelity and full ordered text',async()=>{
  const h=await harness();try {
    const session=h.session('codex'),sent=await h.send(session.id);const adapter=await h.started(sent.runId),ctx=adapter.context!;
    ctx.emit('delta','甲',{threadId:'thread',itemId:'a',delta:'甲',index:0},'native');
    ctx.emit('delta','乙',{index:0,delta:'乙',itemId:'a',threadId:'thread'},'native');
    ctx.emit('reasoning','思',{itemId:'r',publicKind:'summary',parent_tool_use_id:'tool',index:1},'native');
    ctx.emit('reasoning','考',{itemId:'r',publicKind:'summary',parent_tool_use_id:'tool',index:1},'native');
    ctx.emit('delta','丙',{itemId:'b',parent_tool_use_id:'nested',index:2},'native');
    ctx.emit('delta','丁',{itemId:'b',parent_tool_use_id:'nested',index:2},'native');
    ctx.emit('reasoning','解释',{publicKind:'summary'},'derived');ctx.emit('status','flush test',undefined,'derived');
    const batches=h.engine.store.listEvents(session.id).filter(event=>event.kind==='delta'||event.kind==='reasoning');
    assert.deepEqual(batches.map(event=>event.text),['甲乙','思考','丙丁','解释']);assert.deepEqual(batches.map(event=>event.fidelity),['native','native','native','derived']);
    assert.deepEqual(batches[0].data,{threadId:'thread',itemId:'a',index:0});assert.equal((batches[1].data as any).publicKind,'summary');assert.equal((batches[1].data as any).parent_tool_use_id,'tool');assert.equal((batches[2].data as any).itemId,'b');assert.equal((batches[2].data as any).index,2);
    assert.equal(batches.map(event=>event.text).join(''),'甲乙思考丙丁解释');
    ctx.emit('delta','按时',{itemId:'timer',delta:'按时'});ctx.emit('delta','推送',{itemId:'timer',delta:'推送'});
    await waitFor(()=>h.engine.store.listEvents(session.id).find(event=>event.text==='按时推送'),'100ms batch delivery');
  }finally{await h.dispose();}
});

test('project.create rejects relative and missing directories instead of resolving them against the app folder', async () => {
  const { engine, dispose } = await harness();
  await assert.rejects(() => engine.invoke('project.create', { directory: 'Users/admin/Desktop/x' }), /完整路径/);
  await assert.rejects(() => engine.invoke('project.create', { directory: path.join(os.tmpdir(), 'airoom-missing-' + Date.now()) }), /找不到/);
  await dispose();
});

test('帮我批准: session rules answer later requests with the member allow option and can be revoked', async () => {
  const results:string[]=[];
  const request=(category:string)=>({type:'approval' as const,title:'run '+category,detail:'x',options:[{id:'yes',label:'允许这次'},{id:'no',label:'拒绝'}],allowChoice:'yes',denyChoice:'no',category,categoryLabel:category});
  let ctxRef:AdapterContext|undefined;
  const { engine, session, send, dispose } = await harness({ claude: { delivery: 'confirmed', start: async ctx => { ctxRef = ctx; } } });
  const created = await session();
  await engine.invoke('session.approvals',{sessionId:created.id,autoApprove:false});
  await send(created.id);
  await waitFor(() => ctxRef, 'adapter');
  const pendingAnswer = ctxRef!.approve(request('command')).then(reply => results.push(reply.choice));
  const first = await waitFor(() => engine.store.list<Approval>('approvals').find(item => item.state === 'pending'), 'pending approval');
  await engine.invoke('approval.answer', { id: first.id, choice: 'airoom:allow-category' });
  await pendingAnswer;
  assert.deepEqual(engine.store.get<Session>('sessions', created.id)!.approvalRules, ['command']);
  // Same category: answered by AIROOM immediately and recorded as such.
  results.push((await ctxRef!.approve(request('command'))).choice);
  const auto = engine.store.list<Approval>('approvals').find(item => item.autoApproved);
  assert.match(auto!.autoApproved!, /本会话允许此类/);
  // Other categories still wait for the user; allow-all then covers everything.
  const other = ctxRef!.approve(request('fileChange')).then(reply => results.push(reply.choice));
  const second = await waitFor(() => engine.store.list<Approval>('approvals').find(item => item.state === 'pending'), 'second approval');
  await engine.invoke('approval.answer', { id: second.id, choice: 'airoom:allow-all' });
  await other;
  results.push((await ctxRef!.approve(request('WebFetch'))).choice);
  assert.deepEqual(results, ['yes', 'yes', 'yes', 'yes']);
  // Questions are never auto-answered, and revoking restores prompting.
  await engine.invoke('session.approvals', { sessionId: created.id, autoApprove: false, clearRules: true });
  const revoked = engine.store.get<Session>('sessions', created.id)!;
  assert.equal(revoked.autoApprove, false); assert.deepEqual(revoked.approvalRules, []);
  const asked = ctxRef!.approve(request('command'));
  const third = await waitFor(() => engine.store.list<Approval>('approvals').find(item => item.state === 'pending'), 'prompt after revoke');
  // 拒绝并停止: answers with the deny option, then stops the run.
  await engine.invoke('approval.answer', { id: third.id, choice: 'airoom:deny-stop' });
  assert.equal((await asked).choice, 'no');
  await dispose();
});

test('new automatic work sessions approve operations, retain real questions and keep read-only sessions unchanged',async()=>{
  for(const provider of ['codex','claude','dsh'] as const){
    const h=await harness();try{
      const session=h.session(provider);assert.equal(session.writeMode,true);assert.equal(session.autoApprove,true);
      const sent=await h.send(session.id);const adapter=await h.started(sent.runId);const ctx=adapter.context!;
      assert.match(adapter.prompt,/文件范围不限制/);assert.match(adapter.prompt,/不扩大用户任务范围/);
      assert.notEqual(ctx.cwd,h.source);assert.equal(await fs.readFile(path.join(ctx.cwd,'file.txt'),'utf8'),'source');
      const reply=await ctx.approve({type:'approval',title:'operation',detail:'x',options:[{id:'yes',label:'allow'},{id:'no',label:'deny'}],allowChoice:'yes',denyChoice:'no'});
      assert.equal(reply.choice,'yes');const approval=h.engine.store.list<Approval>('approvals')[0];
      assert.equal(approval.state,'answered');assert.equal(approval.answeredChoice,'yes');assert.ok(approval.autoApproved);
      let answered=false;const question=ctx.approve({type:'question',title:'choose direction',detail:'Which?',options:[{id:'answer',label:'answer'}],allowChoice:'answer'}).then(value=>{answered=true;return value;});void question.catch(()=>{});
      const pending=await waitFor(()=>h.engine.store.list<Approval>('approvals').find(item=>item.type==='question'&&item.state==='pending'),'real question');
      assert.equal(answered,false);assert.equal(pending.autoApproved,undefined);assert.equal(h.run(sent.runId).status,'waiting_user');
      await h.engine.invoke('approval.answer',{id:pending.id,choice:'answer',answers:{direction:'blue'}});
      assert.deepEqual((await question).answers,{direction:'blue'});
      const readonly=h.engine.createSession(h.project.id,provider,'readonly',false);
      assert.equal(readonly.writeMode,false);assert.equal(readonly.autoApprove,false);
    }finally{await h.dispose();}
  }
});

test('legacy settings upgrade once, preserve account/model/network choices and retain a restorable backup',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM automatic migration-'));let engine:Engine|undefined;
  const data=path.join(directory,'data');const seed=new Store(data);
  const legacy={networkMode:'proxy',proxyUrl:'http://127.0.0.1:7897',paths:{claude:'chosen-claude'},models:{codex:'chosen-model'},efforts:{codex:'high'},defaultWriteMode:false,maxParallel:2,permissions:{codex:{commands:'ask',fileScope:'workspace',network:false},claude:{commands:'ask',fileScope:'workspace',network:true},dsh:{commands:'auto',fileScope:'workspace',network:true}}};
  const oldSession={id:'old-readonly',projectId:'p',provider:'codex',title:'old',revision:1,writeMode:false,autoApprove:false,createdAt:'',updatedAt:''};
  seed.put('settings','main',legacy);seed.put('sessions',oldSession.id,oldSession);seed.close();
  try{
    engine=new Engine(data,()=>{},()=>{});
    assert.deepEqual(engine.store.get('settings_backups','before-automatic-work'),legacy);
    assert.equal(engine.settings.defaultAutoApprove,true);assert.equal(engine.settings.defaultWriteMode,true);
    for(const provider of ['codex','claude','dsh'] as const)assert.deepEqual(engine.settings.permissions[provider],{commands:'auto',fileScope:'any',network:true});
    assert.equal(engine.settings.paths.claude,'chosen-claude');assert.equal(engine.settings.models.codex,'chosen-model');assert.equal(engine.settings.efforts.codex,'high');assert.equal(engine.settings.networkMode,'proxy');assert.equal(engine.settings.maxParallel,2);
    assert.deepEqual(engine.store.get('sessions',oldSession.id),oldSession);
    await engine.invoke('settings.save',{settings:{defaultAutoApprove:false,defaultWriteMode:false}});
    await engine.close();engine=new Engine(data,()=>{},()=>{});
    assert.equal(engine.settings.defaultAutoApprove,false);assert.equal(engine.settings.defaultWriteMode,false);
    assert.deepEqual(engine.store.get('settings_backups','before-automatic-work'),legacy);
  }finally{await engine?.close();assert.ok(path.relative(path.resolve(os.tmpdir()),path.resolve(directory)).startsWith('AIROOM automatic migration-'));await fs.rm(directory,{recursive:true,force:true});}
});

test('revoking automatic approval stops an active full-access Codex turn',async()=>{
  const h=await harness();try{
    const session=h.session('codex'),sent=await h.send(session.id),adapter=await h.started(sent.runId);
    await h.engine.invoke('session.approvals',{sessionId:session.id,autoApprove:false,clearRules:true});
    assert.equal(adapter.stopCalls,1);assert.equal(h.run(sent.runId).status,'stopped');
    assert.equal(h.engine.store.get<Session>('sessions',session.id)?.autoApprove,false);
  }finally{await h.dispose();}
});

test('work copy changes apply to the project only when nothing conflicts, and discard removes the copy',async()=>{
  const h=await harness({claude:[
    {delivery:'confirmed',start:async context=>{await fs.writeFile(path.join(context.cwd,'file.txt'),'changed');await fs.writeFile(path.join(context.cwd,'new.txt'),'added');},finish:{summary:'ok'}},
    {delivery:'confirmed',start:async context=>{await fs.writeFile(path.join(context.cwd,'file.txt'),'v2');},finish:{summary:'ok'}},
  ]});
  try {
    const session=h.session();const first=await h.send(session.id);await waitFor(()=>completed.has(h.run(first.runId).status),'first run');
    const copy=h.engine.store.get<Session>('sessions',session.id)!.workspace!;
    assert.notEqual(path.resolve(copy),path.resolve(h.source),'write sessions work in a copy');
    assert.equal(await fs.readFile(path.join(h.source,'file.txt'),'utf8'),'source','the project is untouched until applied');
    const applied=await h.engine.invoke('workspace.apply',{sessionId:session.id}) as any;
    assert.deepEqual(applied.applied.map((item:any)=>`${item.kind}:${item.path}`).sort(),['added:new.txt','modified:file.txt']);
    assert.equal(await fs.readFile(path.join(h.source,'file.txt'),'utf8'),'changed');
    assert.equal(await fs.readFile(path.join(h.source,'new.txt'),'utf8'),'added');
    assert.equal((await h.engine.invoke('workspace.apply',{sessionId:session.id}) as any).unchanged,true,'a second apply has nothing new');
    // The user edits the project while the member edits the copy: the apply must refuse and write nothing.
    const second=await h.send(session.id);await waitFor(()=>completed.has(h.run(second.runId).status),'second run');
    await fs.writeFile(path.join(h.source,'file.txt'),'user edit');
    const conflict=await h.engine.invoke('workspace.apply',{sessionId:session.id}) as any;
    assert.equal(conflict.applied.length,0);assert.equal(conflict.conflicts[0].path,'file.txt');
    assert.equal(await fs.readFile(path.join(h.source,'file.txt'),'utf8'),'user edit');
    await h.engine.invoke('workspace.discard',{sessionId:session.id});
    await assert.rejects(fs.access(copy));
    assert.equal(h.engine.store.get<Session>('sessions',session.id)!.workspace,undefined);
    assert.equal(await fs.readFile(path.join(h.source,'new.txt'),'utf8'),'added','discarding the copy never touches the project');
  } finally { await h.dispose(); }
});

test('sessions can be renamed, pinned, archived and deleted; projects removed without touching their folder',async()=>{
  const h=await harness({claude:[{delivery:'confirmed'},{delivery:'confirmed',finish:{summary:'done'}}]});
  try {
    const busy=h.session();const sent=await h.send(busy.id);const adapter=await h.started(sent.runId);
    await assert.rejects(h.engine.invoke('session.delete',{sessionId:busy.id}),/还有任务在进行/);
    adapter.finish({summary:'ok'});await waitFor(()=>completed.has(h.run(sent.runId).status),'run end');
    const renamed=await h.engine.invoke('session.update',{sessionId:busy.id,title:'  新名字  ',pinned:true,archived:true}) as Session;
    assert.equal(renamed.title,'新名字');assert.equal(renamed.pinned,true);assert.equal(renamed.archived,true);
    await assert.rejects(h.engine.invoke('session.update',{sessionId:busy.id,title:'  '}),/不能为空/);
    const workspace=h.engine.store.get<Session>('sessions',busy.id)!.workspace!;
    await h.engine.invoke('session.delete',{sessionId:busy.id});
    assert.equal(h.engine.store.get('sessions',busy.id),undefined);
    assert.equal(h.engine.store.list<Run>('runs').filter(run=>run.sessionId===busy.id).length,0);
    assert.equal(h.engine.store.listEvents(busy.id).length,0);
    await assert.rejects(fs.access(workspace));
    const other=h.session();const done=await h.send(other.id);await waitFor(()=>completed.has(h.run(done.runId).status),'other run');
    await h.engine.invoke('project.update',{projectId:h.project.id,name:'改名后的项目'});
    assert.equal(h.engine.store.get<Project>('projects',h.project.id)!.name,'改名后的项目');
    await h.engine.invoke('project.remove',{projectId:h.project.id});
    assert.equal(h.engine.store.get('projects',h.project.id),undefined);
    assert.equal(h.engine.store.list<Session>('sessions').length,0);
    assert.equal(await fs.readFile(path.join(h.source,'file.txt'),'utf8'),'source','removing a project never deletes the user\'s folder');
  } finally { await h.dispose(); }
});

test('a session can pin its own model and thinking level without changing the member default',async()=>{
  const h=await harness({claude:[{delivery:'confirmed',finish:{summary:'ok'}},{delivery:'confirmed',finish:{summary:'ok'}}]});
  try {
    await h.engine.invoke('settings.save',{settings:{...h.engine.settings,models:{claude:'sonnet'},efforts:{claude:'low'}}});
    const session=h.session();
    await h.engine.invoke('session.update',{sessionId:session.id,model:'opus',effort:'high'});
    const first=await h.send(session.id);const adapter=await h.started(first.runId);
    assert.equal(adapter.context!.settings.models.claude,'opus');assert.equal(adapter.context!.settings.efforts.claude,'high');
    assert.equal(h.engine.settings.models.claude,'sonnet','the member default is untouched');
    await waitFor(()=>completed.has(h.run(first.runId).status),'first run');
    await h.engine.invoke('session.update',{sessionId:session.id,model:null,effort:null});
    const second=await h.send(session.id);const back=await h.started(second.runId);
    assert.equal(back.context!.settings.models.claude,'sonnet');assert.equal(back.context!.settings.efforts.claude,'low');
  } finally { await h.dispose(); }
});

test('member cards shape persona and model; a custom member runs on its executor and keeps historical ownership when deleted',async()=>{
  const h=await harness({claude:[{delivery:'confirmed',finish:{summary:'ok'}},{delivery:'confirmed',finish:{summary:'ok'}},{delivery:'confirmed',finish:{summary:'ok'}}]});
  try {
    await h.engine.invoke('profile.save',{profile:{name:'阿潘'}});
    await h.engine.invoke('team.save',{member:{id:'claude',name:'克劳迪娅',persona:'说话温柔，喜欢用比喻。',memory:'用户喜欢简洁的结论。'}});
    const builtIn=h.session('claude');const first=await h.send(builtIn.id);const a=await h.started(first.runId);
    assert.match(a.context!.persona!,/克劳迪娅/);assert.match(a.context!.persona!,/称呼用户为「阿潘」/);assert.match(a.context!.persona!,/喜欢用比喻/);assert.match(a.context!.persona!,/简洁的结论/);
    await waitFor(()=>completed.has(h.run(first.runId).status),'first');
    const custom=await h.engine.invoke('team.save',{member:{executor:'claude',name:'审稿人',userTitle:'老板',model:'opus',effort:'high'}}) as any;
    assert.match(custom.id,/^m-/);assert.equal(custom.builtIn,false);
    const session=h.engine.createSession(h.project.id,'codex','',true,custom.id);
    assert.equal(session.provider,'claude','a member always runs on its own executor');assert.equal(session.memberId,custom.id);assert.equal(session.title,'审稿人 对话');
    assert.equal(session.autoTitle,true,'a generated title lets the list show the first task');
    assert.equal((await h.engine.invoke('session.update',{sessionId:session.id,title:'登录页评审'}) as Session).autoTitle,false,'renaming explicitly preserves the user choice');
    // Sessions saved before the flag existed are recognised by their generated title on the next start.
    const legacy=h.engine.createSession(h.project.id,'codex',undefined,true,'codex');assert.equal(legacy.title,'Gptia 对话');const stored={...h.engine.store.get<Session>('sessions',legacy.id)!};delete stored.autoTitle;h.engine.store.put('sessions',legacy.id,stored);
    const reopened=new Engine(path.join(h.directory,'data'),()=>{},()=>{});
    try{assert.equal(reopened.store.get<Session>('sessions',legacy.id)!.autoTitle,true);assert.equal(reopened.store.get<Session>('sessions',session.id)!.autoTitle,false);}finally{await reopened.close();}
    const second=await h.send(session.id);const b=await h.started(second.runId);
    assert.match(b.context!.persona!,/「审稿人」/);assert.match(b.context!.persona!,/称呼用户为「老板」/);
    assert.equal(b.context!.settings.models.claude,'opus');assert.equal(b.context!.settings.efforts.claude,'high');
    await waitFor(()=>completed.has(h.run(second.runId).status),'second');
    await assert.rejects(h.engine.invoke('team.delete',{id:'claude',folderChoice:'delete'}),/保留|人物卡/);
    await h.engine.invoke('team.delete',{id:custom.id,folderChoice:'keep'});
    assert.equal(h.engine.store.get<Session>('sessions',session.id)!.memberId,custom.id);
    await assert.rejects(h.send(session.id),/原成员已删除/);
    await h.engine.invoke('team.reset',{id:'claude'});
    assert.equal(h.engine.snapshot().members.find(member=>member.id==='claude')!.name,'Claudia');
    await assert.rejects(h.engine.invoke('team.save',{member:{executor:'gemini',name:'x'}}),/执行端/);
  } finally { await h.dispose(); }
});

test('avatar crop and portrait size persist through a cold restart, and resetting size retains the source image',async()=>{
  const h=await harness();let reopened:Engine|undefined,store:Store|undefined;
  try{
    const face={x:0.55,y:0.2,zoom:4.2},portrait='abcd1234.webp';
    await h.engine.invoke('team.save',{member:{id:'dsh',name:'DS',portrait,face,portraitScale:0.65,portraitOffset:{x:0.12,y:-3},avatar:'feed5678.png',avatarFace:{x:0.4,y:0.6,zoom:20}}});
    await h.engine.close();
    reopened=new Engine(path.join(h.directory,'data'),()=>{},()=>{});
    const saved=reopened.snapshot().members.find(member=>member.id==='dsh')!;
    assert.deepEqual(saved.face,face);assert.equal(saved.portraitScale,0.65);assert.equal(saved.portrait,portrait);
    assert.deepEqual(saved.portraitOffset,{x:0.12,y:-1},'portrait shifts stay within one frame');assert.deepEqual(saved.avatarFace,{x:0.4,y:0.6,zoom:8},'uploaded avatar zoom is bounded');
    assert.equal(reopened.snapshot().members.find(member=>member.id==='claude')!.portraitScale,undefined,'older cards retain default framing');
    await reopened.invoke('team.save',{member:{...saved,face:undefined,portraitScale:undefined,portraitOffset:undefined,avatarFace:undefined}});
    await reopened.close();store=new Store(path.join(h.directory,'data'));
    const reset=store.members().find(member=>member.id==='dsh')!;
    assert.equal(reset.face,undefined);assert.equal(reset.portraitScale,undefined);assert.equal(reset.portraitOffset,undefined);assert.equal(reset.avatarFace,undefined);assert.equal(reset.portrait,portrait);
  }finally{store?.close();await reopened?.close();await h.dispose();}
});

test('room.stop withdraws a room turn queued behind another project and never starts it later',async()=>{
  const h=await harness({claude:{delivery:'confirmed'},codex:{delivery:'confirmed',finish:{summary:'unexpected'}}});
  try {
    h.engine.settings.maxParallel=1;
    const working=await h.send(h.session().id);const adapter=await h.started(working.runId);
    await h.roomSend({text:'等一下再聊',memberIds:['codex']});
    const queued=await waitFor(()=>h.engine.store.list<Run>('runs').find(run=>run.provider==='codex'&&run.status==='queued'),'queued room run');
    await h.engine.invoke('room.stop');
    assert.equal(h.run(queued.id).status,'stopped');assert.equal(h.run(queued.id).delivery,'withdrawn');
    assert.equal(adapter.stopCalls,0,'stopping the room preserves an unrelated project task');
    adapter.finish({summary:'project done'});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'room idle after withdrawing its queued turn');
    assert.ok(!h.instances.some(instance=>instance.context?.run.id===queued.id),'the withdrawn turn never reaches a provider');
  } finally { await h.dispose(); }
});

test('room.stop during room session preparation cannot dispatch the first speaker',async()=>{
  const h=await harness();
  try {
    await h.roomSend({text:'刚发出就停止',memberIds:['codex','dsh']});
    await h.engine.invoke('room.stop');
    await waitFor(()=>!h.engine.snapshot().room.state.active,'room preparation cancelled');
    assert.equal(h.instances.filter(instance=>instance.context).length,0);
    assert.equal(h.engine.store.list<Run>('runs').length,0);
  } finally { await h.dispose(); }
});

test('all.stop also stops subsequent room speakers and permits an explicit new topic',async()=>{
  const h=await harness({claude:{delivery:'confirmed'},codex:[{delivery:'confirmed',finish:{summary:'new topic'}}]});
  try {
    await h.roomSend({text:'讨论中的旧话题',memberIds:['claude','codex']});
    await waitFor(()=>h.instances.some(instance=>instance.context?.run.provider==='claude'),'first room speaker');
    await h.engine.invoke('all.stop');
    await waitFor(()=>!h.engine.snapshot().room.state.active,'room idle after all.stop');
    assert.ok(!h.instances.some(instance=>instance.context?.run.provider==='codex'),'no later speaker starts after all.stop');
    await h.roomSend({text:'明确的新话题',memberIds:['codex']});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'explicit new topic finishes');
    assert.equal(h.instances.filter(instance=>instance.context?.run.provider==='codex').length,1);
  } finally { await h.dispose(); }
});

test('deleting a custom member never reuses their private room session for the built-in member',async()=>{
  const reply=(text:string):Plan=>({delivery:'confirmed',start:context=>{context.persistNativeSession('private-'+context.session.id,'airoom');context.emit('delta',text);},finish:{}});
  const h=await harness({codex:[reply('我是审稿人。'),reply('我是 Gptia。')]});
  try {
    const member=await h.engine.invoke('team.save',{member:{executor:'codex',name:'审稿人'}}) as MemberProfile;
    const ordinary=h.engine.createSession(h.project.id,'codex','审稿人项目对话',false,member.id);
    await h.roomSend({text:'自我介绍',memberIds:[member.id]});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'custom member finishes');
    const first=h.instances.find(instance=>instance.context)?.context!.session;
    assert.ok(first);
    await h.engine.invoke('team.delete',{id:member.id,folderChoice:'keep'});
    assert.ok(h.engine.store.get<Session>('sessions',ordinary.id),'normal project conversations remain readable');
    assert.equal(h.engine.store.get<Session>('sessions',ordinary.id)?.memberId,member.id);
    await h.engine.invoke('room.end',{discussionId:h.engine.store.roomState().discussion!.id});
    await h.roomSend({text:'请 Gptia 自我介绍',memberIds:['codex']});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'built-in member finishes');
    const second=h.instances.filter(instance=>instance.context)[1].context!.session;
    assert.notEqual(second.id,first.id,'each character keeps its own native context');
    assert.equal(second.nativeId,undefined,'the built-in starts without the deleted character transcript');
    assert.equal(h.engine.snapshot().room.messages.filter(message=>message.author===member.id).length,1,'visible room history survives member deletion');
  } finally { await h.dispose(); }
});

test('rebinding a card retains the original session executor and its explicit model choices',async()=>{
  const h=await harness({codex:{delivery:'confirmed',finish:{summary:'ok'}}});
  try {
    const member=await h.engine.invoke('team.save',{member:{executor:'codex',name:'审稿人',model:'card-model',effort:'high'}}) as MemberProfile;
    const session=h.engine.createSession(h.project.id,'codex','test',false,member.id);
    h.engine.store.put('projects',h.project.id,{...h.project,memberConfigs:{[member.id]:{model:'project-model',effort:'high'}}});
    const saved=await h.engine.invoke('team.save',{member:{...member,executor:'claude',name:'新名字'}}) as MemberProfile;
    assert.equal(saved.executor,'claude');assert.equal(saved.model,undefined);assert.equal(saved.effort,undefined);
    assert.equal(h.engine.store.get<Session>('sessions',session.id)?.model,'project-model');
    assert.equal(h.engine.store.get<Project>('projects',h.project.id)?.memberConfigs?.[member.id],undefined);
    h.engine.store.put('projects',h.project.id,{...h.project,memberConfigs:{[member.id]:{model:'new-claude-model',effort:'medium'}}});
    assert.equal(h.engine.createSession(h.project.id,'codex','new binding',false,member.id).provider,'claude');
    await h.engine.invoke('session.update',{sessionId:session.id,model:'session-model',effort:'low'});
    const sent=await h.send(session.id);const adapter=await h.started(sent.runId);
    assert.equal(adapter.context!.settings.models.codex,'session-model');assert.equal(adapter.context!.settings.efforts.codex,'low');
    assert.equal(adapter.context!.session.writeMode,false);assert.match(adapter.context!.persona!,/新名字/);
  } finally { await h.dispose(); }
});

test('restarting the room settles stale speaking state without replay and retains received text',async()=>{
  const h=await harness();
  try {
    const session=h.session('codex');const at=new Date().toISOString();
    const run:Run={id:'room-inflight',sessionId:session.id,projectId:h.project.id,provider:'codex',revision:1,status:'running',input:'old room topic',createdAt:at,updatedAt:at,bootId:'old',delivery:'confirmed'};
    h.engine.store.put('runs',run.id,run);
    h.engine.store.appendEvent({id:'room-partial',runId:run.id,sessionId:session.id,provider:'codex',at,kind:'delta',text:'已经收到的半句话',fidelity:'native'});
    h.engine.store.put('room_messages','speaking',{id:'speaking',author:'codex',text:'',at,status:'speaking',runId:run.id} satisfies RoomMessage);
    h.engine.store.put('room','state',{active:true,mode:'meeting',speaking:'codex',round:2,rounds:3});
    h.engine.store.recover('new-boot');
    const room=h.engine.snapshot().room;
    assert.equal(room.state.active,false);assert.equal(room.state.speaking,undefined);
    assert.equal(room.messages[0].status,'failed');assert.equal(room.messages[0].text,'已经收到的半句话');
    assert.match(room.messages[0].error!,/未自动重发/);assert.equal(h.instances.length,0);
    assert.equal(h.run(run.id).status,'unknown');assert.equal(h.run(run.id).delivery,'unknown');
    h.engine.store.recover('same-boot-again');assert.equal(h.engine.snapshot().room.messages[0].text,'已经收到的半句话');
  } finally { await h.dispose(); }
});

const roomReply=(text:string):Plan=>({delivery:'confirmed',start:context=>context.emit('delta',text),finish:{}});
test('room mentions are resolved from text on the backend, ordered, deduplicated and require invited unambiguous members',async()=>{
  const h=await harness({codex:roomReply('代码建议'),dsh:roomReply('先说我的想法')});
  try{
    await assert.rejects(h.roomSend({text:'@不存在 请回答',memberIds:['codex']}),/找不到/);
    await assert.rejects(h.roomSend({text:'@DS 请回答',memberIds:['codex']}),/先.*邀请 DS/);
    assert.equal(h.engine.snapshot().room.messages.length,0,'invalid mentions never persist or dispatch');
    await h.roomSend({text:'＠ds @gPTIA @DS 请回答',memberIds:['codex','claude','dsh'],maxCalls:2,mentions:['claude']});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'named speakers finish');
    assert.deepEqual(h.instances.filter(item=>item.context).map(item=>item.context!.session.memberId??item.context!.session.provider),['dsh','codex']);
    assert.ok(h.instances.filter(item=>item.context).every(item=>JSON.parse(item.prompt.split('\nAIROOM_CONTEXT\n')[1]).messages.some((m:any)=>m.text.includes('@gPTIA'))));
    const duplicate=await h.engine.invoke('team.save',{member:{executor:'codex',name:'Gptia'}}) as MemberProfile;
    await assert.rejects(h.roomSend({text:'@Gptia',memberIds:['codex',duplicate.id]}),/同名/);
  }finally{await h.dispose();}
});

test('the user toggles reactions on member messages in the current topic only',async()=>{
  const h=await harness({codex:roomReply('我来写测试')});
  try{
    await h.roomSend({text:'谁来写测试？',memberIds:['codex']});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'reply finishes');
    const [question,reply]=h.engine.snapshot().room.messages;
    await h.engine.invoke('room.react',{messageId:reply.id,emoji:'👍'});
    await h.engine.invoke('room.react',{messageId:reply.id,emoji:'😄'});
    assert.deepEqual(h.engine.snapshot().room.messages[1].reactions,{'👍':['user'],'😄':['user']});
    await h.engine.invoke('room.react',{messageId:reply.id,emoji:'👍'});
    assert.deepEqual(h.engine.snapshot().room.messages[1].reactions,{'😄':['user']},'a second click removes it');
    await assert.rejects(h.engine.invoke('room.react',{messageId:reply.id,emoji:'🔥'}),/不支持/);
    await assert.rejects(h.engine.invoke('room.react',{messageId:question.id,emoji:'👍'}),/不能添加/);
    await h.engine.invoke('room.archive',{});
    await assert.rejects(h.engine.invoke('room.react',{messageId:reply.id,emoji:'👍'}),/当前话题/,'archives are read-only');
  }finally{await h.dispose();}
});

test('compressing the current topic writes a summary in a throwaway session and members continue from it',async()=>{
  const h=await harness({codex:[roomReply('我建议先做登录页。'),roomReply('好的，按摘要继续。')],claude:roomReply('- 结论：先做登录页（Gptia 提议）')});
  try{
    await h.roomSend({text:'第一件事做什么？',memberIds:['codex']});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'first turn');
    const summary=await h.engine.invoke('room.compress',{memberId:'claude'}) as RoomSummary;
    assert.equal(summary.text,'- 结论：先做登录页（Gptia 提议）');assert.equal(summary.by,'claude');assert.equal(summary.count,2);
    const writer=h.instances.find(item=>item.context?.session.provider==='claude')!;
    assert.match(writer.prompt,/\[AIROOM 话题压缩\]/);assert.match(writer.prompt,/Gptia：我建议先做登录页。/);
    assert.equal(writer.context!.settings.permissions.claude.commands,'deny','the summary writer cannot run commands either');
    const snapshot=h.engine.snapshot(),lounge=snapshot.projects.find(project=>project.kind==='lounge')!;
    assert.equal(snapshot.sessions.filter(session=>session.projectId===lounge.id&&!session.roomRetiredAt).length,0,'summary session removed and reusable room context reset');
    assert.equal(snapshot.sessions.filter(session=>session.projectId===lounge.id&&session.roomRetiredAt).length,1,'the earlier room run remains readable history');
    assert.equal(h.engine.store.get('sessions',writer.context!.session.id),undefined,'the throwaway summary session is removed');
    assert.equal(snapshot.room.threads!.find(thread=>thread.id===snapshot.room.currentThreadId)!.summary!.text,summary.text);
    assert.match(snapshot.room.messages.at(-1)!.text,/压缩成摘要/);assert.equal(snapshot.room.state.compressing,undefined);
    assert.match((await h.engine.invoke('room.export',{}) as {content:string}).content,/## 话题摘要（Claudia整理于 .+，覆盖 2 条）\n\n- 结论：先做登录页/);
    await h.roomSend({text:'那第二件呢？',memberIds:['codex']});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'second turn');
    const next=h.instances.filter(item=>item.context?.session.provider==='codex').at(-1)!;
    const input=JSON.parse(next.prompt.split('\nAIROOM_CONTEXT\n')[1]);
    assert.ok(input.background.some((b:any)=>b.text.includes('- 结论：先做登录页')));
    assert.ok(![...input.messages,...input.recent,...input.references].some((m:any)=>m.text.includes('第一件事做什么')),'messages folded into the summary are not repeated');
    assert.ok(input.messages.some((m:any)=>m.text.includes('那第二件呢？')));
  }finally{await h.dispose();}
});

test('a summary can propose things to remember; only what the user accepts, for the members they pick, reaches members',async()=>{
  const h=await harness({codex:[roomReply('我习惯先看结论。'),roomReply('好的。'),roomReply('收到。')],claude:roomReply('- 结论：先做登录页\n\n【可记住】\n- 阿潘喜欢先看结论\n2. 阿潘周末不讨论工作\n- 阿潘喜欢先看结论')});
  const lastCodex=()=>h.instances.filter(item=>item.context?.session.provider==='codex').at(-1)!;
  try{
    await h.engine.invoke('profile.save',{profile:{name:'阿潘'}});
    await h.roomSend({text:'以后都先说结论',memberIds:['codex']});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'first turn');
    const summary=await h.engine.invoke('room.compress',{memberId:'claude'}) as RoomSummary;
    assert.match(h.instances.find(item=>item.context?.session.provider==='claude')!.prompt,/【可记住】/);
    assert.equal(summary.text,'- 结论：先做登录页','proposals are split off the summary');
    assert.deepEqual(summary.proposals,['阿潘喜欢先看结论','阿潘周末不讨论工作']);
    const threadId=h.engine.snapshot().room.currentThreadId!;
    await h.roomSend({text:'继续',memberIds:['codex']});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'second turn');
    assert.doesNotMatch(lastCodex().prompt+lastCodex().context!.persona,/周末不讨论工作/,'unaccepted proposals never reach members');
    await assert.rejects(h.engine.invoke('memory.accept',{threadId,texts:['编造的一条'],memberIds:['codex']}),/请选择/);
    // A card that would go over the limit refuses the whole change; no other card is written.
    await h.engine.invoke('team.save',{member:{id:'dsh',name:'Deepseek',memories:Array.from({length:4},(_,index)=>({id:`full${index}`,text:'满'.repeat(1998),source:'manual'}))}});
    await assert.rejects(h.engine.invoke('memory.accept',{threadId,texts:['阿潘周末不讨论工作'],memberIds:['codex','dsh']}),/Deepseek：.*合计超过/);
    assert.equal(memoryEntries(h.engine.store.members().find(member=>member.id==='codex')!).length,0);
    assert.equal(h.engine.store.get<RoomThread>('room_threads',threadId)!.summary!.proposals!.length,2,'proposals wait until handled');
    await h.engine.invoke('memory.accept',{threadId,texts:['阿潘周末不讨论工作'],memberIds:['codex']});
    const codex=h.engine.store.members().find(member=>member.id==='codex')!;
    assert.deepEqual(memoryEntries(codex).map(entry=>[entry.text,entry.source]),[['阿潘周末不讨论工作','proposed']]);
    assert.match(codex.memories![0].origin!,/^Claudia提议 · 话题「.+」$/);
    assert.equal(memoryEntries(h.engine.store.members().find(member=>member.id==='claude')!).length,0,'members not chosen are unchanged');
    const thread=h.engine.store.get<RoomThread>('room_threads',threadId)!;
    assert.equal(thread.summary!.proposals,undefined);assert.equal(thread.summary!.text,'- 结论：先做登录页');
    await h.roomSend({text:'周末呢？',memberIds:['codex']});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'third turn');
    assert.match(lastCodex().context!.persona!,/长期记住的事：\n- 阿潘周末不讨论工作/);
    assert.deepEqual(await h.engine.invoke('memory.dismiss',{threadId}),{dismissed:true});
    // Clearing the topic erases its summary along with the messages it described.
    await h.engine.invoke('room.clear');
    assert.equal(h.engine.store.get<RoomThread>('room_threads',threadId)!.summary,undefined);
  }finally{await h.dispose();}
});

test('attached files reach members: text inline and paths in projects; in the room only programs that take images get the picture',async()=>{
  const h=await harness({codex:[{delivery:'confirmed',start:context=>context.emit('delta','看完了'),finish:{}},roomReply('看不到图，但读了需求。')],claude:roomReply('图里是登录页。')});
  try{
    // Claude's connection check says it takes images; the fake Codex does not.
    const engine=h.engine as unknown as {providers:ProviderInfo[]};
    engine.providers=[...engine.providers.filter(info=>info.id!=='claude'),{id:'claude',name:'Claude',available:true,auth:'subscription',detail:'fake',capabilities:{steer:false,cancel:'native',streaming:true,write:false,history:true,images:true}}];
    await fs.writeFile(path.join(h.directory,'需求.md'),'先做登录页');await fs.writeFile(path.join(h.directory,'shot.png'),Buffer.from([1,2,3]));await fs.writeFile(path.join(h.directory,'spec.pdf'),Buffer.from([0,1]));
    const [note,shot,spec]=await h.engine.invoke('attachment.import',{paths:['需求.md','shot.png','spec.pdf'].map(name=>path.join(h.directory,name))}) as Attachment[];
    // A project task: text inline, other files by path; the run keeps records without paths.
    const session=h.session('codex');
    const sent=await h.engine.invoke('session.send',{sessionId:session.id,text:'',attachments:[note,shot,spec]}) as {runId:string};
    const worker=await h.started(sent.runId);
    assert.equal(h.run(sent.runId).input,'请看附件。');
    assert.deepEqual(h.run(sent.runId).attachments!.map(item=>item.name),['需求.md','shot.png','spec.pdf']);
    assert.ok(!('path' in h.run(sent.runId).attachments![0]),'stored records carry no paths');
    assert.match(worker.prompt,/#### 需求\.md\n```\n先做登录页\n```/);assert.match(worker.prompt,/shot\.png（图片）：你当前的程序收不到图片内容/);
    assert.ok(worker.prompt.includes(path.join('attachments',spec.id,'spec.pdf')),'other files by path');
    assert.equal(worker.context!.attachments!.length,3);
    await waitFor(()=>completed.has(h.run(sent.runId).status),'project turn');
    await assert.rejects(h.engine.invoke('session.send',{sessionId:session.id,text:'x',attachments:[{...note,name:'..\\需求.md'}]}),/附件无效/);
    // The room: Claude gets the picture, Codex an honest note; both get the text.
    await h.roomSend({text:'看看这个',memberIds:['claude','codex'],attachments:[shot,note]});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'room turns');
    const asked=h.engine.snapshot().room.messages.find(message=>message.author==='user')!;
    assert.deepEqual(asked.attachments!.map(item=>item.name),['shot.png','需求.md']);
    const claude=h.instances.find(item=>item.context?.session.provider==='claude')!,codex=h.instances.filter(item=>item.context?.session.provider==='codex').at(-1)!;
    assert.deepEqual(JSON.parse(claude.prompt.split('\nAIROOM_CONTEXT\n')[1]).messages[0].attachments,['shot.png','需求.md']);assert.match(claude.prompt,/shot\.png（图片，已随消息附上）/);assert.match(claude.prompt,/先做登录页/);
    assert.deepEqual(claude.context!.attachments!.map(item=>item.name),['shot.png'],'only images go as pictures');
    assert.match(codex.prompt,/收不到图片内容/);assert.match(codex.prompt,/先做登录页/);assert.equal(codex.context!.attachments,undefined);
    assert.doesNotMatch(claude.prompt+codex.prompt,/attachments[\\/]/,'no paths in the room');
    // Copies go when nothing refers to them: clearing the room keeps what the project turn still uses.
    const stored=(item:Attachment)=>fs.stat(path.join(h.directory,'data','attachments',item.id)).then(()=>true,()=>false);
    await h.engine.invoke('room.clear');
    assert.deepEqual([await stored(shot),await stored(note),await stored(spec)],[true,true,true]);
    await h.engine.invoke('session.delete',{sessionId:session.id,discardWorkspace:true});
    assert.deepEqual([await stored(shot),await stored(note),await stored(spec)],[false,false,false]);
  }finally{await h.dispose();}
});

test('Codex and DSH receive attached pictures in both project tasks and ordinary room turns',async()=>{
  const project={delivery:'confirmed' as const,start:(context:AdapterContext)=>context.emit('delta','已收到图片'),finish:{}};
  const h=await harness({codex:[project,roomReply('收到图片')],dsh:[project,roomReply('收到图片')]});
  try{
    const engine=h.engine as unknown as {providers:ProviderInfo[]};
    engine.providers=engine.providers.map(info=>['codex','dsh'].includes(info.id)?{...info,available:true,auth:info.id==='dsh'?'account':'subscription',capabilities:{...info.capabilities,images:true}}:info);
    for(const id of ['codex','dsh'] as const)if(!engine.providers.some(info=>info.id===id))engine.providers.push({id,name:id,available:true,auth:id==='dsh'?'account':'subscription',detail:'fixture',capabilities:{steer:false,cancel:'native',streaming:true,write:false,history:true,images:true}});
    await fs.writeFile(path.join(h.directory,'图片.png'),Buffer.from([1,2,3]));
    const attachments=await h.engine.invoke('attachment.import',{paths:[path.join(h.directory,'图片.png')]}) as Attachment[];
    for(const id of ['codex','dsh'] as const){
      const session=h.session(id),sent=await h.engine.invoke('session.send',{sessionId:session.id,text:'看看图片',attachments}) as {runId:string};
      const native=await h.started(sent.runId);assert.match(native.prompt,/图片，已随消息附上/);assert.equal(native.context!.attachments![0].id,attachments[0].id);
      await waitFor(()=>completed.has(h.run(sent.runId).status),'picture project turn');
    }
    await h.roomSend({text:'请两位看图',memberIds:['codex','dsh'],attachments});await waitFor(()=>!h.engine.snapshot().room.state.active,'picture room turns');
    for(const id of ['codex','dsh']){
      const native=h.instances.filter(item=>item.context?.session.provider===id).at(-1)!;
      assert.match(native.prompt,/图片，已随消息附上/);assert.doesNotMatch(native.prompt,/收不到图片内容/);
      assert.equal(native.context!.attachments![0].id,attachments[0].id);assert.equal(native.context!.session.writeMode,false);
    }
  }finally{await h.dispose();}
});

test('a new topic with an inherited summary starts in one go even when the summary run finishes slowly',async()=>{
  const h=await harness({codex:[roomReply('周末去爬山吧。')],claude:roomReply('- 计划：周末爬山')});
  try{
    await h.roomSend({text:'周末做什么？',memberIds:['codex']});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'first turn');
    // Provider confirmation runs after the run is marked ended; slow it down to hold the execution open.
    const engine=h.engine as unknown as {confirmProvider:(ctx:unknown)=>Promise<void>},confirm=engine.confirmProvider.bind(h.engine);
    engine.confirmProvider=async ctx=>{await new Promise(resolve=>setTimeout(resolve,400));await confirm(ctx);};
    const firstId=h.engine.snapshot().room.currentThreadId!;
    const next=await h.engine.invoke('room.archive',{inherit:true,memberId:'claude'}) as RoomThread;
    assert.equal(next.inherited?.threadId,firstId);assert.equal(next.inherited?.text,'- 计划：周末爬山');
    assert.equal(h.engine.snapshot().sessions.filter(session=>session.purpose==='room-summary').length,0,'the summary session is removed');
  }finally{await h.dispose();}
});

test('a new topic can inherit a summary, reusing an up-to-date one and continuing an archived topic',async()=>{
  const h=await harness({codex:[roomReply('周末去爬山吧。'),roomReply('记得带水。'),roomReply('接着聊爬山。'),roomReply('好的。')],claude:roomReply('- 计划：周末爬山')});
  try{
    await h.roomSend({text:'周末做什么？',memberIds:['codex']});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'first turn');
    const firstId=h.engine.snapshot().room.currentThreadId!;
    const next=await h.engine.invoke('room.archive',{title:'周末计划',inherit:true,memberId:'claude'}) as RoomThread;
    assert.deepEqual(next.inherited,{threadId:firstId,title:'周末计划',text:'- 计划：周末爬山'});
    assert.equal(h.engine.snapshot().room.threads!.find(thread=>thread.id===firstId)!.summary!.text,'- 计划：周末爬山','the archived topic keeps its summary');
    await h.roomSend({text:'还要准备什么？',memberIds:['codex']});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'second turn');
    assert.deepEqual(JSON.parse(h.instances.filter(item=>item.context?.session.provider==='codex').at(-1)!.prompt.split('\nAIROOM_CONTEXT\n')[1]).background,[{title:'周末计划',text:'- 计划：周末爬山'}]);
    // Archive again without inheriting, then continue the first topic from the empty new one: its summary is current, so no new call.
    await h.engine.invoke('room.archive',{});
    const writes=h.instances.filter(item=>item.context?.session.provider==='claude').length;
    const resumed=await h.engine.invoke('room.archive',{inherit:true,from:firstId}) as RoomThread;
    assert.equal(h.instances.filter(item=>item.context?.session.provider==='claude').length,writes,'an up-to-date summary is reused');
    assert.equal(resumed.id,h.engine.snapshot().room.currentThreadId,'an empty current topic simply takes the summary');
    assert.equal(resumed.inherited!.threadId,firstId);
    await assert.rejects(h.engine.invoke('room.archive',{}),/没有消息/);
    // Dropping the inherited summary: only the current topic, and members restart without it.
    const lastCodex=()=>h.instances.filter(item=>item.context?.session.provider==='codex').at(-1)!;
    await h.roomSend({text:'先聊着',memberIds:['codex']});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'inherited turn');
    assert.equal(JSON.parse(lastCodex().prompt.split('\nAIROOM_CONTEXT\n')[1]).background[0].title,'周末计划');
    await assert.rejects(h.engine.invoke('room.uninherit',{threadId:firstId}),/当前话题/);
    const plain=await h.engine.invoke('room.uninherit',{threadId:resumed.id}) as RoomThread;
    assert.equal(plain.inherited,undefined);assert.equal(h.engine.snapshot().room.threads!.find(thread=>thread.id===resumed.id)!.inherited,undefined);
    const retired=lastCodex().context!.session.id;
    assert.ok(!h.engine.store.list<Session>('sessions').some(session=>session.projectId!==h.project.id&&session.provider==='codex'&&!session.roomRetiredAt),'reusable room sessions restart');
    assert.ok(h.engine.store.get<Session>('sessions',retired)?.roomRetiredAt,'the old run remains audit history');
    await h.roomSend({text:'换个话题',memberIds:['codex']});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'plain turn');
    assert.notEqual(lastCodex().context!.session.id,retired);
    assert.doesNotMatch(lastCodex().prompt,/上一个话题/);assert.match(lastCodex().prompt,/先聊着/);
  }finally{await h.dispose();}
});

test('a failed summary leaves the topic unchanged and cleans up',async()=>{
  const h=await harness({codex:roomReply('随便聊聊'),claude:roomReply('[PASS]')});
  try{
    await assert.rejects(h.engine.invoke('room.compress',{memberId:'claude'}),/没有可以压缩的内容/);
    await h.roomSend({text:'你好',memberIds:['codex']});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'turn');
    await assert.rejects(h.engine.invoke('room.compress',{memberId:'claude'}),/没能写出摘要/);
    const snapshot=h.engine.snapshot(),thread=snapshot.room.threads!.find(item=>item.id===snapshot.room.currentThreadId)!;
    assert.equal(thread.summary,undefined);assert.equal(snapshot.room.state.compressing,undefined);
    assert.equal(snapshot.sessions.filter(session=>session.purpose==='room-summary').length,0);
    assert.ok(snapshot.sessions.some(session=>session.provider==='codex'),'the room context is kept when nothing was compressed');
    assert.equal(thread.count,2);
    await h.engine.invoke('room.rename',{threadId:thread.id,title:'  打招呼  '});
    assert.equal(h.engine.snapshot().room.threads![0].title,'打招呼');
    await assert.rejects(h.engine.invoke('room.rename',{threadId:thread.id,title:' '}),/不能为空/);
  }finally{await h.dispose();}
});

test('a room conclusion handed to a project runs there and its outcome is reported back to the topic',async()=>{
  const failing:Plan={delivery:'confirmed',start:context=>context.emit('delta','开始'),finish:{failure:{kind:'failed',message:'测试失败'}}};
  const h=await harness({codex:roomReply('先做登录页。'),claude:[roomReply('登录页做好了。'),failing]});
  try{
    await h.roomSend({text:'先做什么？',memberIds:['codex']});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'room reply');
    const conclusion=h.engine.snapshot().room.messages.find(message=>message.author==='codex')!;
    await assert.rejects(h.engine.invoke('room.handoff',{projectId:'lounge',memberId:'claude',text:'x'}),/工作项目|不存在/);
    await assert.rejects(h.engine.invoke('room.handoff',{projectId:h.project.id,memberId:'nobody',text:'x'}),/选择一位成员/);
    const result=await h.engine.invoke('room.handoff',{projectId:h.project.id,memberId:'claude',text:'请根据讨论完成：先做登录页。',messageId:conclusion.id,writeMode:false}) as {sessionId:string;runId:string};
    const session=h.engine.store.get<Session>('sessions',result.sessionId)!;
    assert.equal(session.projectId,h.project.id);assert.equal(session.writeMode,false);assert.equal(session.provider,'claude');
    assert.deepEqual(h.engine.store.get<Run>('runs',result.runId)!.origin,{threadId:h.engine.snapshot().room.currentThreadId,messageId:conclusion.id});
    const handed=h.engine.snapshot().room.messages.find(message=>message.system&&message.link?.runId===result.runId)!;
    assert.match(handed.text,/已交给 Claudia（项目「.+」）：请根据讨论完成：先做登录页。/);
    await waitFor(()=>h.engine.snapshot().room.messages.some(message=>message.system&&/完成了交给 TA 的任务，结果待你验收/.test(message.text)),'outcome reported back');
    const reported=h.engine.snapshot().room.messages.at(-1)!;
    assert.deepEqual(reported.link,{projectId:h.project.id,sessionId:result.sessionId,runId:result.runId,outcome:'ended'});
    // Continuing an existing session, and a failed task is reported as such.
    const again=await h.engine.invoke('room.handoff',{projectId:h.project.id,sessionId:result.sessionId,text:'再补一个注册页'}) as {sessionId:string;runId:string};
    assert.equal(again.sessionId,result.sessionId);
    await waitFor(()=>h.engine.snapshot().room.messages.some(message=>message.system&&/没能完成任务：测试失败/.test(message.text)),'failure reported back');
    const other=h.session('codex');
    await assert.rejects(h.engine.invoke('room.handoff',{projectId:'missing',sessionId:other.id,text:'x'}),/不存在/);
  }finally{await h.dispose();}
});

test('a room outcome can be reviewed by another member, sent back with the findings and then accepted',async()=>{
  const task:Plan={delivery:'confirmed',start:async context=>{await fs.writeFile(path.join(context.cwd,'file.txt'),'changed');context.emit('delta','登录页');context.emit('tool','写入 file.txt');context.emit('delta','做好了。');},finish:{}};
  const review:Plan={delivery:'confirmed',start:context=>context.emit('delta','**已核实**：页面能打开。\n**需实测**：表单校验。\n需要修改'),finish:{}};
  const h=await harness({codex:[roomReply('先做登录页。'),task,roomReply('改好了。')],dsh:review});
  const notes=()=>h.engine.snapshot().room.messages.filter(message=>message.system);
  try{
    await h.roomSend({text:'先做什么？',memberIds:['codex']});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'room reply');
    const handed=await h.engine.invoke('room.handoff',{projectId:h.project.id,memberId:'codex',text:'做登录页',writeMode:true}) as {sessionId:string;runId:string};
    const outcome=await waitFor(()=>notes().find(message=>message.link?.outcome==='ended'&&message.link.runId===handed.runId),'task outcome');
    assert.equal(outcome.detail,'登录页\n\n做好了。');
    const worked=h.engine.store.get<Session>('sessions',handed.sessionId)!;assert.notEqual(worked.workspaceKind,'original');
    await assert.rejects(h.engine.invoke('run.review',{runId:handed.runId,memberId:'codex'}),/另选一位/);
    // Asked from the project side: the review still reports to the topic the task came from.
    const asked=await h.engine.invoke('run.review',{runId:handed.runId,memberId:'dsh',focus:'看看表单'}) as {sessionId:string;runId:string};
    const reviewer=h.engine.store.get<Session>('sessions',asked.sessionId)!;
    assert.equal(reviewer.writeMode,false);assert.equal(reviewer.provider,'dsh');assert.equal(reviewer.workspace,worked.workspace);assert.equal(reviewer.workspaceKind,'original');
    const adapter=await h.started(asked.runId);
    assert.equal(adapter.context!.cwd,worked.workspace);
    assert.match(adapter.prompt,/看看表单/);assert.match(adapter.prompt,/做登录页/);assert.match(adapter.prompt,/登录页\n\n做好了。/);assert.match(adapter.prompt,/修改 file\.txt/);assert.match(adapter.prompt,/已核实.*需实测.*建议/s);
    assert.ok(notes().some(message=>/已请 .+ 复核 .+ 在项目/.test(message.text)&&message.link?.runId===asked.runId));
    const reviewed=await waitFor(()=>notes().find(message=>message.link?.outcome&&message.link.reviewOf?.runId===handed.runId),'review outcome');
    assert.match(reviewed.text,/复核完了/);assert.match(reviewed.detail!,/需要修改/);
    // Sending the findings back continues the worker's own session and decides both notes.
    const back=await h.engine.invoke('run.verdict',{messageId:reviewed.id,verdict:'returned',note:' '}) as {sessionId:string;runId:string};
    assert.equal(back.sessionId,handed.sessionId);assert.match(h.run(back.runId).input,/验收没有通过[\s\S]*需要修改/);
    for(const id of [outcome.id,reviewed.id])assert.equal(h.engine.store.get<RoomMessage>('room_messages',id)!.link!.verdict,'returned');
    await assert.rejects(h.engine.invoke('run.verdict',{messageId:outcome.id,verdict:'accepted'}),/已经打回/);
    const fixed=await waitFor(()=>notes().find(message=>message.link?.outcome==='ended'&&message.link.runId===back.runId),'fixed outcome');
    await h.engine.invoke('run.verdict',{messageId:fixed.id,verdict:'accepted'});
    assert.equal(h.run(back.runId).status,'completed');assert.equal(h.run(back.runId).validation,'在聊天室验收通过');
    assert.equal(h.engine.store.get<RoomMessage>('room_messages',fixed.id)!.link!.verdict,'accepted');
    await assert.rejects(h.engine.invoke('run.verdict',{messageId:fixed.id,verdict:'accepted'}),/已经验收通过/);
    // Removing the review session never discards the copy it read.
    await h.engine.invoke('session.delete',{sessionId:asked.sessionId,discardWorkspace:true});
    assert.equal(await fs.readFile(path.join(worked.workspace!,'file.txt'),'utf8'),'changed');
  }finally{await h.dispose();}
});

test('unknown delivery isolates that room speaker without retrying it while the next speaker continues',async()=>{
  const h=await harness({claude:{delivery:'confirmed',start:()=>{throw new Error('transport disconnected');}},codex:roomReply('其他成员正常回答。')});
  try{
    await h.roomSend({text:'这一轮不能误重发',memberIds:['claude','codex']});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'unknown room delivery finishes');
    assert.equal(h.instances.filter(item=>item.context).length,2);
    assert.equal(h.instances.filter(item=>item.context?.run.provider==='claude').length,1);
    assert.equal(h.engine.snapshot().room.messages.at(-1)!.status,'done');
    assert.equal(h.engine.store.list<Run>('runs')[0].status,'unknown');
  }finally{await h.dispose();}
});

test('archiving keeps history, clears native room contexts and isolates the next topic; clearing and archive deletion are distinct',async()=>{
  const nativeReply=(text:string):Plan=>({delivery:'confirmed',start:context=>{context.persistNativeSession('native-'+context.session.id,'airoom');context.emit('delta',text);},finish:{}});
  const h=await harness({codex:[nativeReply('旧话题回应'),nativeReply('新话题回应')]});
  try{
    const ordinary=h.session('codex');
    await h.roomSend({text:'旧话题秘密',memberIds:['codex']});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'old topic finishes');
    const oldId=h.engine.snapshot().room.currentThreadId!;
    const oldSession=h.instances.find(item=>item.context)!.context!.session.id;
    const archive=h.engine.invoke('room.archive');
    await assert.rejects(h.roomSend({text:'不能在换话题期间发送',memberIds:['codex']}),/整理话题/);
    await archive;
    assert.equal(h.engine.snapshot().room.messages.length,0);
    assert.ok(h.engine.store.get<Session>('sessions',oldSession)?.roomRetiredAt);
    const oldRuns=h.engine.store.list<Run>('runs').filter(run=>run.sessionId===oldSession),oldEvents=h.engine.store.listEvents(oldSession);
    assert.ok(oldRuns.length>0);assert.ok(oldEvents.length>0);
    assert.ok(h.engine.store.get<Session>('sessions',ordinary.id),'project sessions are preserved');
    assert.equal(h.engine.store.allRoomMessages(oldId).length,2);
    await h.roomSend({text:'这是新的话题',memberIds:['codex']});
    await waitFor(()=>!h.engine.snapshot().room.state.active,'new topic finishes');
    const next=h.instances.filter(item=>item.context)[1];assert.notEqual(next.context!.session.id,oldSession);
    assert.equal(next.context!.session.nativeId,undefined);assert.ok(!next.prompt.includes('旧话题秘密'));
    const exported=await h.engine.invoke('room.export',{threadId:oldId}) as {content:string;count:number};
    assert.equal(exported.count,2);assert.match(exported.content,/旧话题秘密/);assert.doesNotMatch(exported.content,/新的话题/);
    await h.engine.invoke('room.clear');assert.equal(h.engine.store.allRoomMessages(oldId).length,2);
    assert.ok(h.engine.store.get<Session>('sessions',oldSession));assert.deepEqual(h.engine.store.listEvents(oldSession),oldEvents);
    await assert.rejects(h.engine.invoke('room.delete',{threadId:h.engine.snapshot().room.currentThreadId}),/当前话题/);
    const remove=h.engine.store.delete.bind(h.engine.store);h.engine.store.delete=(entity,id)=>{if(entity==='room_threads'&&id===oldId)throw new Error('fixture archive storage failure');remove(entity,id);};
    try{await assert.rejects(h.engine.invoke('room.delete',{threadId:oldId}),/storage failure/);assert.ok(h.engine.store.get<Session>('sessions',oldSession));assert.deepEqual(h.engine.store.listEvents(oldSession),oldEvents);assert.ok(oldRuns.every(run=>h.engine.store.get('runs',run.id)));assert.equal(h.engine.store.allRoomMessages(oldId).length,2);}finally{h.engine.store.delete=remove;}
    await h.engine.invoke('room.delete',{threadId:oldId});assert.equal(h.engine.store.get('room_threads',oldId),undefined);
    assert.equal(h.engine.store.get('sessions',oldSession),undefined);assert.equal(h.engine.store.listEvents(oldSession).length,0);assert.ok(oldRuns.every(run=>!h.engine.store.get('runs',run.id)));
    assert.equal(h.engine.snapshot().room.threads!.length,1);
  }finally{await h.dispose();}
});

test('engine writeback undo shares the directory queue and records completion',async()=>{
  const {withProjectWrite}=await import('../src/backend/project-access');
  const h=await harness({claude:{delivery:'confirmed',start:async context=>{await fs.writeFile(path.join(context.cwd,'file.txt'),'round');await fs.writeFile(path.join(context.cwd,'new.txt'),'added');},finish:{summary:'done'}}});
  let release!:()=>void;try{
    const session=h.session(),sent=await h.send(session.id);await waitFor(()=>completed.has(h.run(sent.runId).status),'run');
    await h.engine.invoke('workspace.apply',{sessionId:session.id});
    const first=await h.engine.invoke('workspace.undo.info',{sessionId:session.id}) as any;assert.equal(first.projectUndo.status,'applied');
    let locked=false;const hold=withProjectWrite(h.engine.store,h.project.id,h.source,async()=>{locked=true;await new Promise<void>(r=>release=r);});await waitFor(()=>locked,'write queue');
    const undo=h.engine.invoke('workspace.undo',{sessionId:session.id,runId:sent.runId});await new Promise(r=>setImmediate(r));assert.equal(await fs.readFile(path.join(h.source,'file.txt'),'utf8'),'round');release();await hold;assert.equal((await undo as any).status,'undone');
    assert.equal(await fs.readFile(path.join(h.source,'file.txt'),'utf8'),'source');await assert.rejects(fs.stat(path.join(h.source,'new.txt')),{code:'ENOENT'});assert.equal(h.run(sent.runId).workspaceUndo?.status,'undone');
    assert.ok(h.engine.store.listEvents(session.id).some(e=>e.kind==='status'&&e.text.includes('项目原文件已撤销')));
  }finally{release?.();await h.dispose();}
});


test('offline maintenance disables both automation and project dispatch',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM maintenance-'));
  const engine=new Engine(directory,()=>{},()=>{},undefined,{maintenanceOnly:true});
  try{
    assert.equal((engine as any).projectFlow.host.alive(),false);
    assert.equal((engine as any).automation.timer,undefined);
  }finally{await engine.close();await fs.rm(directory,{recursive:true,force:true});}
});
