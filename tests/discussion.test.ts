import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from './helpers/seeded-engine';
import { RoomDiscussionController } from '../src/backend/room-discussion';
import { chooseHandSpeaker, discussionCommand, nextDiscussionSpeaker, parseDiscussionReply, parseHandVote, waitAfterMeetingRound, type DiscussionReply, type HandVote, type RoomDiscussion } from '../src/shared/discussion';
import { roomMarkdown } from '../src/shared/room';
import type { RoomMessage, Run } from '../src/shared/types';
import { normalizeMember, personaInstructions } from '../src/shared/defaults';

type Context = { turn:string; revision:number; you:string; phase:string; proposal?:RoomDiscussion['proposal']; caughtUp:boolean; messages:{id:string;text:string}[]; references:{id:string;text:string}[]; background:{title:string;text:string}[]; recent:{id:string;text:string}[]; questions:RoomDiscussion['questions']; reviewRequired:boolean;canPropose:boolean;meetingStage?:string;supplementedMembers?:string[] };
type Answer = Partial<DiscussionReply> | string | { failure:string; unknown?:boolean;limited?:boolean };
type HandContext = { round:string; revision:number; you:string; speakingPreference:string; questions:RoomDiscussion['questions']; messages:{id:string;text:string}[];handStage?:string;supplementedMembers?:string[] };
type HandAnswer = HandVote | string | { failure:string; unknown?:boolean; limited?:boolean };
async function fixture(respond:(context:Context,index:number)=>Answer|Promise<Answer>, random=()=>0, handRespond:(context:HandContext,index:number)=>HandAnswer|Promise<HandAnswer>=()=>({want:0,why:'没有新补充'}), freshSession?:(index:number)=>boolean|undefined, quotaPreference?:(memberId:string)=>number, summarize?:(context:Context)=>Answer|Promise<Answer>) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM discussion-')),store=new Store(directory);
  const calls:Context[]=[],prompts:string[]=[],hands:HandContext[]=[],minutes:Context[]=[],warnings:string[]=[];let running:Promise<void>|undefined,alive=true,interrupts=0,runSequence=0,canceledHands=0;
  const cancelVotes=new Set<(answer:HandAnswer)=>void>();
  const controller=new RoomDiscussionController(store,{
    callLimits:()=>store.get<import('../src/shared/types').Settings>('settings','main')?.discussionCallLimits,
    random,
    quotaPreference,
    alive:()=>alive,busy:()=>Boolean(running),changed:()=>{},
    launch:flow=>{running=Promise.resolve().then(flow).finally(()=>{running=undefined;store.put('room','state',{...store.roomState(),active:false,speaking:undefined});});},
    interrupt:async()=>{interrupts++;controller.pause('人类停止',true);},
    cancelHands:async()=>{canceledHands++;for(const finish of cancelVotes)finish({failure:'已停止'});},
    warning:(_runId,text)=>warnings.push(text),
    turn:async(member,prompt,onRun,options)=>{
      if(options?.shouldStart?.()===false)return {text:'',status:'stopped'};
      if(options?.hand){
        const ctx=JSON.parse(prompt.split('\nAIROOM_HAND_CONTEXT\n')[1]) as HandContext;hands.push(ctx);onRun('run-'+ ++runSequence);
        let cancel!:(answer:HandAnswer)=>void;const stopped=new Promise<HandAnswer>(resolve=>cancel=resolve);cancelVotes.add(cancel);
        const answer=await Promise.race([Promise.resolve(handRespond(ctx,hands.length-1)),stopped]);cancelVotes.delete(cancel);
        if(typeof answer!=='string'&&'failure' in answer)return {text:'',status:'failed',error:answer.failure,unknown:answer.unknown,limited:answer.limited};
        return {status:'done',text:typeof answer==='string'?answer:JSON.stringify(answer)};
      }
      if(options?.summary){
        const ctx=JSON.parse(prompt.split('\nAIROOM_CONTEXT\n')[1]) as Context;minutes.push(ctx);onRun('run-'+ ++runSequence);
        const answer=await (summarize?.(ctx)??{body:'结论：方案已确认。\n分歧：无。\n下一步：未约定。'});
        if(typeof answer!=='string'&&'failure' in answer)return {text:'',status:'failed',error:answer.failure,unknown:answer.unknown};
        return {status:'done',text:typeof answer==='string'?answer:JSON.stringify({version:1,turn:ctx.turn,revision:ctx.revision,action:'speak',...answer})};
      }
      const remember=freshSession?.(calls.length);if(typeof remember==='boolean')prompt=options?.freshPrompt?.(remember)??prompt;
      prompts.push(prompt);
      const ctx=JSON.parse(prompt.split('\nAIROOM_CONTEXT\n')[1]) as Context;calls.push(ctx);
      assert.equal(ctx.you,member.id);onRun('run-'+ ++runSequence);
      const answer=await respond(ctx,calls.length-1);
      if(typeof answer!=='string'&&'failure' in answer)return {text:'{"private":"partial"}',status:'failed',error:answer.failure,unknown:answer.unknown,limited:answer.limited};
      return {status:'done',text:typeof answer==='string'?answer:JSON.stringify({version:1,turn:ctx.turn,revision:ctx.revision,action:'speak',body:'',...answer})};
    },
  });
  const state=()=>store.roomState().discussion!;
  const messages=()=>store.allRoomMessages(store.currentRoomThread().id);
  const input=(text='讨论如何实施',extra:Record<string,unknown>={})=>controller.input({text,memberIds:['claude','codex','dsh'],maxCalls:30,maxMinutes:0,hostPick:false,...extra});
  const finish=async()=>{await running;};
  const requestMinutes=()=>controller.requestMinutes({discussionId:state().id,revision:state().revision});
  const dispose=async()=>{alive=false;for(const finish of cancelVotes)finish({failure:'清理测试'});await running;store.close();await rm(directory,{recursive:true,force:true});};
  return {store,controller,calls,prompts,hands,minutes,warnings,state,messages,input,finish,requestMinutes,dispose,directory,interrupts:()=>interrupts,canceledHands:()=>canceledHands};
}
const accept=(c:Context):Answer=>({action:'accept',body:'',proposalId:c.proposal!.id});

test('warm discussion prompts omit acknowledged background but preserve unread text, questions and canonical history',async()=>{
  const h=await fixture((_c,i)=>({body:'回复'+i,...(i===0?{questions:[{to:'codex',text:'以后核对这个未完成事项？'}]}:{})}));
  try{
    await h.input('必须记住的决定');await h.finish();const history=h.messages().map(m=>m.id),question=h.state().questions[0];
    await h.input('继续处理这次的新消息');await h.finish();assert.equal(h.calls.length,6);
    assert.equal(h.calls[3].recent.length,0);assert.ok(h.calls[3].messages.some(m=>m.text==='继续处理这次的新消息'));
    assert.ok(h.calls[3].questions.some(q=>q.id===question.id));assert.ok(history.every(id=>h.messages().some(m=>m.id===id)));
    assert.ok(h.prompts[3].split('\nAIROOM_CONTEXT\n')[0].length<h.prompts[0].split('\nAIROOM_CONTEXT\n')[0].length/2);
  }finally{await h.dispose();}
});

test('a warm format correction restores complete rules without changing the turn or unread messages',async()=>{
  const h=await fixture((_c,index)=>index===3?'malformed reply':{body:'收到'});
  try{
    await h.input('原始决定');await h.finish();await h.input('继续这次问题');await h.finish();
    assert.equal(h.calls.length,7);assert.equal(h.calls[3].turn,h.calls[4].turn);assert.equal(h.calls[3].revision,h.calls[4].revision);
    assert.match(h.prompts[4],/background 是已有话题摘要/);assert.match(h.prompts[4],/不要把问题标记为已解决来凑收尾/);
    assert.deepEqual(h.calls[4].messages,h.calls[3].messages);assert.ok(h.prompts[4].includes('唯一一次格式补正'));
  }finally{await h.dispose();}
});

test('fresh native discussion contexts restore full instructions and original constraints after warm turns',async()=>{
  const h=await fixture(()=>({body:'收到'}),()=>0,undefined,index=>index===3?true:undefined);
  try{
    await h.input('原来的约束必须保留');await h.finish();await h.input('重新连接继续');await h.finish();
    assert.ok(h.calls[3].messages.some(m=>m.text==='原来的约束必须保留'));assert.match(h.prompts[3],/background 是已有话题摘要/);
    assert.ok(h.calls[4].recent.length===0);
  }finally{await h.dispose();}
});

test('a direct request to wait ends only the response round, without extra closure calls or lost questions',async()=>{
  assert.equal(waitAfterMeetingRound('示例：“这轮答完等我下一条问题”'),false);
  const h=await fixture((_c,i)=>i===2?{action:'propose',body:'本轮已回答。'}:{body:'回答'+i,questions:i===0?[{to:'dsh',text:'以后再核对这个边界？'}]:[]});
  try{
    await h.input('每人只答一个要点，这轮答完等我下一条问题。');await h.finish();
    assert.deepEqual(h.calls.map(c=>c.you),['claude','codex','dsh']);assert.ok(h.calls.every(c=>!c.canPropose));
    assert.equal(h.state().phase,'waiting_user');assert.equal(h.minutes.length,0);assert.equal(h.state().proposal,undefined);assert.equal(h.state().questions.filter(q=>!q.answeredBy).length,1);
    await h.input('@DS 下一条只回复收到。');await h.finish();assert.equal(h.calls.length,4);assert.equal(h.calls[3].you,'dsh');assert.equal(h.state().phase,'waiting_user');
  }finally{await h.dispose();}
});

test('continuing a meeting applies new hand and host settings and invalidates the previous host choice',async()=>{
  const h=await fixture(()=>({body:'回答一次'}),()=>0,()=>({want:2,why:'有补充'}));
  try{
    await h.input('@DS 先回答。');await h.finish();assert.equal(h.state().phase,'waiting_user');assert.equal(h.hands.length,0);
    await h.input('现在举手后等待我点名。',{handRaise:true,hostPick:true});await h.finish();
    const previous=h.state(),hand=previous.handRound!;assert.equal(previous.handRaise,true);assert.equal(previous.hostPick,true);assert.equal(previous.phase,'awaiting-host');assert.equal(h.hands.length,3);assert.equal(h.calls.length,4);
    await h.input('@DS 关闭举手后只回答一次。',{handRaise:false,hostPick:false});await h.finish();
    assert.equal(h.state().handRaise,false);assert.equal(h.state().hostPick,false);assert.equal(h.state().phase,'waiting_user');assert.equal(h.hands.length,3);assert.equal(h.calls.length,5);
    await assert.rejects(h.controller.hostChoice({discussionId:previous.id,revision:previous.revision,handRoundId:hand.id,choice:'member',memberId:'dsh'}),/已改变/);
  }finally{await h.dispose();}
});

test('a single participant always answers once and never polls hands',async()=>{
  for(const want of [0,2] as const){const h=await fixture(()=>({body:'只回答一次'}),()=>0,()=>({want,why:'不应调用'}));
    try{await h.input('按举手规则讨论。',{memberIds:['dsh'],handRaise:true,hostPick:true});await h.finish();assert.equal(h.calls.length,1);assert.equal(h.hands.length,0);assert.equal(h.state().phase,'waiting_user');assert.equal(h.state().calls,1);assert.equal(h.state().handRaise,false);}finally{await h.dispose();}}
});

test('low quota reduces ordinary selection and ballot scores while explicit questions keep their obligation',()=>{
  const d={members:['claude','codex','dsh'],style:'chat',priority:[],questions:[],reviewRequired:[],phase:'talking',calls:0,lastSpoke:{}} as unknown as RoomDiscussion;
  let low=0;for(let i=0;i<1000;i++)if(nextDiscussionSpeaker(d,[],()=>i/1000,{claude:.1,codex:1,dsh:1})==='claude')low++;
  assert.ok(low<60);assert.equal(nextDiscussionSpeaker(d,[],()=>0,{claude:0,codex:0,dsh:1}),'dsh');
  assert.equal(nextDiscussionSpeaker({...d,priority:['claude']},[],()=>0,{claude:0}),'claude');
  assert.equal(chooseHandSpeaker(d,{claude:{status:'done',want:3},codex:{status:'done',want:2},dsh:{status:'done',want:0}},[],()=>0,{claude:.35}).selected,'codex');
});
test('all exhausted members pause without calls and exhausted seats do not hold up healthy replies',async()=>{
  for(const handRaise of [false,true]){const h=await fixture(()=>({body:'must not run'}),()=>0,()=>({want:3,why:'must not poll'}),undefined,()=>0);
    try{await h.input('all exhausted',{handRaise});await h.finish();assert.equal(h.calls.length,0);assert.equal(h.hands.length,0);assert.equal(h.state().phase,'blocked');assert.equal(h.state().calls,0);}finally{await h.dispose();}}
  const h=await fixture(()=>({body:'请核实。',questions:[{to:'codex',text:'验证过吗？'}]}),()=>0,undefined,undefined,id=>id==='claude'?1:0);
  try{await h.input();await h.finish();assert.equal(h.calls.length,1);assert.equal(h.state().phase,'waiting_user');assert.ok(h.state().skippedMembers?.codex);assert.equal(h.state().questions.filter(q=>!q.answeredBy).length,1);assert.equal(h.state().proposal,undefined);}finally{await h.dispose();}
});

test('members exhausted after the response round skip hands, and remaining participants share the call budget',async()=>{
  let speechCount=0;
  const h=await fixture((_c,i)=>{speechCount++;return {body:'第 '+(i+1)+' 位发言'};},()=>0,()=>({want:2,why:'有补充'}),undefined,id=>id==='claude'&&speechCount>=3?0:1);
  try{await h.input('vote only available members',{handRaise:true,maxCalls:6});await h.finish();assert.deepEqual(h.hands.map(hand=>hand.you),['codex','dsh']);assert.equal(h.calls.length,4);assert.equal(h.state().calls,6);assert.equal(h.state().skippedMembers?.claude.limited,true);assert.notEqual(h.state().phase,'idle');}finally{await h.dispose();}
});

test('three members answer in seating order, retain questions, and only the human requests minutes',async()=>{
  const h=await fixture((c,i)=>i===0?{body:'初步方案。',next:'dsh',questions:[{to:'dsh',text:'如何验证？'}]}:i===1?{body:'先检查边界。',next:'claude'}:{action:'propose',body:'补上边界检查，本话题可以结束。',answers:[c.questions[0].id]});
  try{await h.input();await h.finish();assert.deepEqual(h.calls.map(c=>c.you),['claude','codex','dsh']);assert.equal(h.state().phase,'waiting_user');assert.equal(h.state().proposal,undefined);assert.equal(h.minutes.length,0);assert.equal(h.state().questions.filter(q=>!q.answeredBy).length,0);assert.equal(h.messages().filter(m=>m.discussionControl).length,0);
    assert.match(roomMarkdown(h.store.currentRoomThread(),h.messages(),id=>id),/边界检查/);await h.requestMinutes();await h.finish();assert.equal(h.minutes.length,1);assert.deepEqual((h.minutes[0] as unknown as {participants:{name:string;spoke:boolean}[]}).participants.map(p=>p.spoke),[true,true,true],'minutes name exactly the members who took part');assert.equal(h.state().phase,'idle');assert.equal(h.state().endedBy,'user');assert.equal(h.state().calls,4);
  }finally{await h.dispose();}
});

test('proposed closure in a work meeting stays visible prose and cannot dispatch acceptance calls',async()=>{
  const h=await fixture(()=>({action:'propose',body:'已完成，可以结束。'}));
  try{await h.input();await h.finish();assert.equal(h.calls.length,3);assert.equal(h.state().phase,'waiting_user');assert.equal(h.state().proposal,undefined);assert.equal(h.minutes.length,0);assert.equal(h.messages().filter(m=>m.text==='已完成，可以结束。').length,3);assert.equal(h.messages().filter(m=>m.discussionControl).length,0);await h.input('@DS 再说明一个限制');await h.finish();assert.equal(h.calls.length,4);assert.equal(h.state().phase,'waiting_user');}finally{await h.dispose();}
});

test('unanswered questions, fabricated targets and ordinary prose cannot fake closure',async()=>{
  for(const mode of ['question','target','prose','accept'] as const){
    const h=await fixture((c,i)=>{
      if(mode==='target')return {body:'呼叫',next:'not-present'};
      if(mode==='prose')return '好了，结束吧。';
      if(mode==='accept')return {action:'accept',body:'',proposalId:'invented'};
      if(i===0)return {body:'还有一个问题。',questions:[{to:'codex',text:'是否验证？'}]};
      return {action:'propose',body:'直接结束。'};
    });try{await h.input('守护收尾',{maxCalls:4});await h.finish();assert.notEqual(h.state().phase,'idle',mode);
      if(mode==='prose'||mode==='accept'){assert.equal(h.state().phase,'budget');assert.equal(h.calls.length,4);assert.ok(h.messages().some(m=>m.status==='failed'&&m.text.includes('这次没能回答')));}
      if(mode==='question'){assert.equal(h.state().questions.filter(q=>!q.answeredBy).length,1);assert.equal(h.state().proposal,undefined);assert.ok(h.warnings.some(w=>w.includes('发言保留')));}
      if(mode==='target')assert.ok(h.warnings.some(w=>w.includes('顺序')));
      assert.ok(h.messages().every(m=>!m.text.includes('"action"')));}finally{await h.dispose();}
  }
});

test('a human mention invalidates an in-flight old proposal and only its recipient replies before waiting',async()=>{
  let release!:(value:Answer)=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);
  const h=await fixture((_c,i)=>{if(i===0){entered();return new Promise<Answer>(r=>release=r);}return {body:'已看到用户的新约束。'};});
  try{await h.input();await started;await h.input('@DS 新增一个约束');release({action:'propose',body:'旧议题结束。'});await h.finish();assert.equal(h.state().phase,'waiting_user');assert.deepEqual(h.calls.map(c=>c.you),['claude','dsh']);assert.ok(h.calls[1].messages.some(m=>m.text.includes('新增一个约束')));assert.equal(h.state().proposal,undefined);assert.ok(h.messages().some(m=>m.discussionStale));await h.input('所有人按新约束再核对');await h.finish();assert.deepEqual(h.calls.slice(2).map(c=>c.you),['claude','codex','dsh']);assert.equal(h.state().phase,'waiting_user');}finally{release?.({action:'pass',body:''});await h.dispose();}
});

test('human stop wins over in-flight controls and fresh human text starts a new full response round',async()=>{
  let release!:(value:Answer)=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);
  const h=await fixture((c,i)=>{if(i===0){entered();return new Promise<Answer>(r=>release=r);}return c.phase==='closing'?accept(c):c.canPropose?{action:'propose',body:'核对补充后可以结束。'}:{body:'回应补充要求。'};});
  try{await h.input();await started;h.controller.pause();release({body:'已生成的回应。'});await h.finish();assert.equal(h.state().phase,'paused');assert.equal(h.calls.length,1);await h.input('这是中止后的补充');await h.finish();assert.equal(h.state().phase,'waiting_user');assert.deepEqual(h.calls.slice(1,4).map(c=>c.you),['claude','codex','dsh']);assert.ok(h.calls[1].messages.some(m=>m.text.includes('中止后的补充')));}finally{release?.({action:'pass',body:''});await h.dispose();}
});

test('asking the human stops scheduling and a human answer resumes the same discussion',async()=>{
  const h=await fixture((c,i)=>i===0?{action:'ask_user',body:'你选哪个？',questions:[{to:'user',text:'选 A 还是 B？'}]}:c.phase==='closing'?accept(c):c.canPropose?{action:'propose',body:'按你的选择结束。'}:{body:'本轮回应已记录。'});
  try{await h.input();await h.finish();const id=h.state().id;assert.equal(h.state().phase,'waiting_user');assert.equal(h.calls.length,3);assert.throws(()=>h.controller.resume({}),/先回答/);await h.input('选 A');await h.finish();assert.equal(h.state().id,id);assert.equal(h.state().phase,'waiting_user');}finally{await h.dispose();}
});

test('a human end preserves unanswered questions and requires a fresh topic without fabricating acceptance',async()=>{
  const h=await fixture(()=>({body:'需要你确认预算。',questions:[{to:'user',text:'这次预算是多少？'}]}));
  try{
    await h.input();await h.finish();const id=h.state().id,calls=h.calls.length,questions=structuredClone(h.state().questions);
    assert.throws(()=>h.controller.finishByUser(false,'older-discussion'),/讨论已切换/);assert.equal(h.state().phase,'waiting_user');
    h.controller.finishByUser(false,id);assert.equal(h.state().phase,'idle');assert.equal(h.state().endedBy,'user');assert.ok(h.state().endedAt);assert.deepEqual(h.state().questions,questions);assert.equal(h.state().proposal,undefined);assert.equal(h.calls.length,calls);
    assert.throws(()=>h.controller.resume({}),/新话题/);await h.input('换一个话题');await h.finish();assert.notEqual(h.state().id,id);assert.equal(h.state().endedBy,undefined);
  }finally{await h.dispose();}
});

test('a human end cannot acknowledge an unknown delivery implicitly or replay its original turn',async()=>{
  const h=await fixture(()=>({failure:'unconfirmed',unknown:true}));
  try{await h.input();await h.finish();const id=h.state().id,unknown=h.state().unknownRunId,calls=h.calls.length;assert.throws(()=>h.controller.finishByUser(false,id),/结果未知/);assert.equal(h.state().phase,'blocked');h.controller.finishByUser(true,id);assert.equal(h.state().endedBy,'user');assert.ok(h.state().acknowledgedRunIds?.includes(unknown!));assert.equal(h.calls.length,calls);assert.equal(h.state().proposal,undefined);}finally{await h.dispose();}
});

test('budget pauses preserve pending seats and invalid replies remain bounded without closing a meeting',async()=>{
  const h=await fixture((_c,i)=>({body:'新增观点 '+i}));try{await h.input('预算测试',{maxCalls:2});await h.finish();assert.equal(h.state().phase,'budget');assert.equal(h.calls.length,2);h.controller.resume({maxCalls:2});await h.finish();assert.equal(h.calls.length,3);assert.equal(h.state().phase,'waiting_user');}finally{await h.dispose();}
  const silent=await fixture(()=>({action:'pass',body:''}));try{await silent.input('无补充',{maxCalls:0});await silent.finish();assert.equal(silent.state().phase,'blocked');assert.equal(silent.calls.length,6);assert.equal(silent.messages().filter(m=>m.status==='failed'&&m.text.includes('这次没能回答')).length,3);assert.equal(silent.state().endedAt,undefined);}finally{await silent.dispose();}
});

test('unknown delivery skips only that member across rounds and needs acknowledgment before rejoining',async()=>{
  const h=await fixture((c,i)=>i===0?{failure:'lost receipt',unknown:true}:c.phase==='closing'?accept(c):{action:'propose',body:'核对后形成新回应。'});
  try{await h.input();await h.finish();assert.equal(h.state().phase,'waiting_user');assert.deepEqual(h.calls.map(c=>c.you),['claude','codex','dsh']);await h.input('补充说明');await h.finish();assert.deepEqual(h.calls.slice(3).map(c=>c.you),['codex','dsh']);assert.throws(()=>h.controller.resume({}),/结果未知/);h.controller.resume({acknowledgeUnknown:true});await h.finish();assert.equal(h.state().phase,'waiting_user');assert.equal(h.calls.at(-1)!.you,'claude');assert.notEqual(h.calls[0].turn,h.calls.at(-1)!.turn);}finally{await h.dispose();}
});

test('latest human mention has priority and weighted handoffs leave room for a third member',async()=>{
  let seed=12345;const random=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);
  const h=await fixture((c,i)=>({body:`观点 ${i}`,next:c.you==='claude'?'codex':'claude'}),random);
  try{await h.input('@DS 先谈谈',{style:'chat',maxCalls:60});await h.finish();assert.equal(h.calls[0].you,'dsh');assert.ok(h.calls.filter(c=>c.you==='dsh').length>=3);assert.equal(h.state().phase,'budget');}finally{await h.dispose();}
});

test('restart hides partial protocol and pauses a discussion without fabricating an accepted closure',async()=>{
  const h=await fixture(()=>({action:'pass',body:''}));
  try{
    await h.input('建立状态',{maxCalls:1});await h.finish();const d={...h.state(),phase:'closing' as const};
    h.store.put('room','state',{active:true,mode:'discuss',discussion:d});
    const message:RoomMessage={id:'partial',author:'claude',text:'',status:'speaking',at:new Date().toISOString(),discussionId:d.id,threadId:h.store.currentRoomThread().id,runId:'interrupted-run'};
    h.store.put('room_messages',message.id,message);
    h.store.put('runs','interrupted-run',{id:'interrupted-run',bootId:'previous',status:'running',delivery:'sent',sessionId:'s'} as Run);
    h.store.recover('new-boot');assert.equal(h.state().phase,'blocked');assert.equal(h.state().unknownRunId,'interrupted-run');assert.equal(h.store.get<RoomMessage>('room_messages','partial')!.text,'');assert.equal(h.store.roomState().active,false);
  }finally{await h.dispose();}
});

test('only matching structured control and standalone human commands carry authority',()=>{
  assert.throws(()=>parseDiscussionReply('{"action":"accept"}','actual',1));
  assert.throws(()=>parseDiscussionReply(JSON.stringify({version:1,turn:'wrong',revision:1,action:'pass',body:''}),'actual',1));
  assert.equal(discussionCommand('先停一停'),'pause');assert.equal(discussionCommand('这个“先停一停”会触发吗？'),undefined);
  assert.equal(discussionCommand('不要停止讨论'),undefined);assert.equal(discussionCommand('继续聊吧'),'resume');
});

test('two participants speak again only after human input and explicit end starts a fresh topic',async()=>{
  const h=await fixture((_c,i)=>({body:'新观点 '+i}));try{await h.input('两人讨论',{memberIds:['claude','dsh']});await h.finish();const id=h.state().id;assert.equal(h.calls.length,2);assert.equal(h.state().phase,'waiting_user');await h.input('再核对一次');await h.finish();assert.equal(h.state().id,id);assert.equal(h.calls.length,4);h.controller.finishByUser(false,id);await h.input('新的话题',{memberIds:['claude','dsh']});await h.finish();assert.notEqual(h.state().id,id);assert.equal(h.state().phase,'waiting_user');assert.equal(h.calls.length,6);}finally{await h.dispose();}
});

test('summaries survive compression and explicit replies supply the referenced original text',async()=>{
  const h=await fixture((c,i)=>({body:`已读 ${i}`}));
  try{
    await h.input('先聊旧内容',{maxCalls:1});await h.finish();const original=h.messages()[0],thread=h.store.currentRoomThread();
    h.store.put('room_threads',thread.id,{...thread,inherited:{threadId:'old',title:'上个话题',text:'继承的决定'},summary:{text:'压缩后的结论',by:'claude',at:new Date().toISOString(),count:2,upTo:h.messages().at(-1)!.id}});
    h.controller.rebase();await h.input('请解释这条',{replyTo:original.id});h.controller.resume({maxCalls:1});await h.finish();
    const c=h.calls.at(-1)!;assert.ok(c.background.some(b=>b.text==='压缩后的结论'));assert.ok(c.background.some(b=>b.text==='继承的决定'));assert.ok(c.references.some(m=>m.id===original.id&&m.text===original.text));assert.ok(!c.messages.some(m=>m.id===original.id));
  }finally{await h.dispose();}
});

test('a backlog is read in bounded batches across explicit human response rounds',async()=>{
  const h=await fixture((_c,i)=>({body:'逐批核对未读补充 '+i}));
  try{await h.input('初始化',{maxCalls:1});await h.finish();h.controller.pause();
    for(let i=0;i<70;i++){const d=h.state(),m={id:'backlog-'+i,threadId:h.store.currentRoomThread().id,author:'user',text:'暂停时补充 '+i,status:'done' as const,at:new Date().toISOString(),discussionId:d.id,discussionRevision:d.revision+1};h.store.put('room_messages',m.id,m);h.store.put('room','state',{...h.store.roomState(),discussion:{...d,revision:d.revision+1,latestUserId:m.id}});}
    h.controller.resume({maxCalls:20});await h.finish();assert.equal(h.state().phase,'waiting_user');
    for(let i=0;i<3;i++){await h.input('继续核对未读补充 '+i);await h.finish();assert.equal(h.state().phase,'waiting_user');}
    assert.ok(h.calls.some(c=>!c.caughtUp));for(const member of ['claude','codex','dsh']){const seen=new Set(h.calls.filter(c=>c.you===member).flatMap(c=>c.messages.map(m=>m.text)));for(let i=0;i<70;i++)assert.ok(seen.has('暂停时补充 '+i),member+' missed '+i);}assert.ok(h.calls.every(c=>c.messages.length<=32));assert.equal(h.minutes.length,0);
  }finally{await h.dispose();}
});

test('a pause persisted during a call still requires unknown acknowledgment after restart',async()=>{
  const h=await fixture(()=>({action:'pass',body:''}));
  try{
    await h.input('初始化',{maxCalls:1});await h.finish();h.controller.pause();
    h.store.put('runs','run-1',{id:'run-1',bootId:'old',status:'running',delivery:'sent',sessionId:'s'} as Run);
    h.store.recover('new');assert.equal(h.state().phase,'paused');assert.equal(h.state().unknownRunId,'run-1');assert.throws(()=>h.controller.resume({}),/结果未知/);
    h.controller.resume({acknowledgeUnknown:true,maxCalls:1});await h.finish();h.store.recover('third');assert.equal(h.state().unknownRunId,undefined);assert.equal(h.state().phase,'budget');
  }finally{await h.dispose();}
});

test('elapsed discussion time prevents another dispatch and is not natural completion',async()=>{
  let h:Awaited<ReturnType<typeof fixture>>;
  h=await fixture(()=>{const d=h.state();h.store.put('room','state',{...h.store.roomState(),discussion:{...d,deadline:Date.now()-1}});return {body:'当前发言保留。'};});
  try{await h.input();await h.finish();assert.equal(h.calls.length,1);assert.equal(h.state().phase,'budget');}finally{await h.dispose();}
});

test('pause and resume commands do not silently answer pending human questions',async()=>{
  const h=await fixture(c=>c.you==='claude'?{action:'ask_user',body:'请选择 A 或 B？',questions:[{to:'user',text:'A 或 B？'}]}:{body:'本轮意见已回答，等待用户确认。'});
  try{await h.input();await h.finish();await assert.rejects(h.input('继续讨论'),/先回答/);assert.equal(h.state().phase,'waiting_user');assert.equal(h.state().questions.filter(q=>!q.answeredBy).length,1);await h.input('先停一停');assert.equal(h.state().phase,'paused');assert.throws(()=>h.controller.resume({}),/先回答/);}finally{await h.dispose();}
});

test('personality weighting is reproducible, honors direct questions and avoids consecutive monopolies',()=>{
  const profiles=[{id:'quiet',talkativeness:'quiet' as const},{id:'normal',talkativeness:'normal' as const},{id:'chatty',talkativeness:'chatty' as const}];
  const simulate=()=>{
    let seed=27182;const random=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);
    const d={members:profiles.map(p=>p.id),style:'chat',phase:'talking',priority:[],questions:[],reviewRequired:[],lastSpoke:{},calls:0} as unknown as RoomDiscussion;
    const count:Record<string,number>={quiet:0,normal:0,chatty:0};let last='';
    for(let i=0;i<12000;i++){const next=nextDiscussionSpeaker(d,profiles,random);assert.notEqual(next,last);count[next]++;d.lastSpoke[next]=d.calls++;last=next;}
    d.priority=['quiet'];assert.equal(nextDiscussionSpeaker(d,profiles,random),'quiet');d.priority=[];
    d.questions=[{id:'q',from:'chatty',to:'normal',text:'你怎么看？',messageId:'m'}];d.reviewRequired=['quiet'];assert.equal(nextDiscussionSpeaker(d,profiles,random),'normal');
    return count;
  };
  const counts=simulate();assert.deepEqual(counts,simulate());assert.ok(counts.chatty>counts.normal);assert.ok(counts.normal>counts.quiet);assert.ok(counts.chatty>counts.quiet*1.2);assert.ok(counts.quiet>2000);
  const card=normalizeMember({id:'claude',name:'Claudia',talkativeness:'chatty'});assert.equal(card.talkativeness,'chatty');assert.match(personaInstructions(card,{name:'你'}),/积极接话/);
  assert.equal(normalizeMember({id:'claude',talkativeness:'invalid'}).talkativeness,'normal');
});

test('hands poll together after the seated round, then only remaining members may supplement',async()=>{
  const releases:((vote:HandAnswer)=>void)[]=[];let ready!:()=>void;const started=new Promise<void>(r=>ready=r);
  const h=await fixture((_c,i)=>({body:'第 '+(i+1)+' 次发言'}),()=>0,(_c,i)=>i<3?new Promise<HandAnswer>(resolve=>{releases.push(resolve);if(releases.length===3)ready();}):{want:0,why:'没有新补充'});
  try{await h.input('大家先轮流再举手',{handRaise:true,maxCalls:10});await started;assert.equal(h.state().phase,'raising');assert.deepEqual(h.calls.map(c=>c.you),['claude','codex','dsh']);releases.forEach((r,i)=>r({want:i===2?3:1,why:'有补充'}));await h.finish();assert.deepEqual(h.calls.map(c=>c.you),['claude','codex','dsh','dsh']);assert.deepEqual(h.hands.slice(3).map(c=>c.you),['claude','codex']);assert.ok(h.hands.slice(0,3).every(c=>c.handStage==='first-poll'));assert.ok(h.hands.slice(3).every(c=>c.handStage==='after-supplement'&&c.supplementedMembers?.join()==='dsh'));assert.equal(h.calls[3].meetingStage,'selected-supplement');assert.equal(h.state().calls,9);assert.equal(h.state().phase,'waiting_user');assert.ok(h.messages().every(m=>!m.text.includes('"want"')));}finally{releases.forEach(r=>r({want:0,why:'结束测试'}));await h.dispose();}
});

test('equal hand scores use personality weighting, while all silent votes use the ordinary selector',()=>{
  const d={members:['quiet','chatty'],phase:'talking',priority:[],questions:[],reviewRequired:[],lastSpoke:{},calls:2} as unknown as RoomDiscussion;
  const profiles=[{id:'quiet',talkativeness:'quiet' as const},{id:'chatty',talkativeness:'chatty' as const}];
  const equal={quiet:{status:'done' as const,want:2 as const,why:'有补充'},chatty:{status:'done' as const,want:2 as const,why:'有补充'}};
  assert.equal(chooseHandSpeaker(d,equal,profiles,()=>0.3).selected,'chatty');
  assert.equal(chooseHandSpeaker(d,{...equal,quiet:{...equal.quiet,want:0},chatty:{...equal.chatty,want:0}},profiles,()=>0).selected,'quiet');
  assert.ok(chooseHandSpeaker(d,{},profiles,()=>0).fallback);
  d.lastSpoke={quiet:1};assert.equal(chooseHandSpeaker(d,equal,profiles,()=>0).selected,'chatty');
  d.members.push('third');d.lastSpoke={quiet:0,chatty:1,third:2};d.calls=3;
  assert.equal(chooseHandSpeaker(d,{...equal,third:{status:'done',want:0,why:'没补充'}},profiles,()=>0.3).selected,'chatty','an earlier speaker is eligible when the actual last speaker has lower intent');
});

test('polling reserves remaining voters and a possible speech, while zero hands stop without another speech',async()=>{
  const h=await fixture(()=>({body:'这是新增内容。'}));try{await h.input('预算不足',{handRaise:true,maxCalls:3});await h.finish();assert.equal(h.state().phase,'budget');assert.equal(h.hands.length,0);h.controller.resume({maxCalls:4});await h.finish();assert.equal(h.state().calls,6);assert.equal(h.hands.length,3);assert.equal(h.calls.length,3);assert.equal(h.state().phase,'waiting_user');}finally{await h.dispose();}
});

test('a human mention limits the response to its recipients and member questions or stale review do not jump seats',async()=>{
  const h=await fixture((c,i)=>i===0?{body:'请回答验证问题。',questions:[{to:'dsh',text:'怎样验证？'}]}:{body:'按座位核对问题。',answers:c.questions.filter(q=>!q.answeredBy&&q.to===c.you).map(q=>q.id)});
  try{await h.input('@Claudia 先说明',{handRaise:true,maxCalls:4});await h.finish();assert.deepEqual(h.calls.map(c=>c.you),['claude']);assert.equal(h.state().phase,'waiting_user');assert.equal(h.hands.length,0);h.store.put('room','state',{...h.store.roomState(),discussion:{...h.state(),reviewRequired:['codex']}});await h.input('所有人核对',{handRaise:false});await h.finish();assert.deepEqual(h.calls.slice(1).map(c=>c.you),['claude','codex','dsh']);assert.equal(h.hands.length,0);assert.equal(h.state().questions.filter(q=>!q.answeredBy).length,0);}finally{await h.dispose();}
});

test('invalid votes are ignored once without leaking control into visible speech',async()=>{
  for(const malformed of ['{"want":4,"why":"越界"}','{"want":3}','我想发言'])assert.throws(()=>parseHandVote(malformed));
  assert.deepEqual(parseHandVote('```json\n{"want":2,"why":"有新观点"}\n```'),{want:2,why:'有新观点'});
  const h=await fixture(()=>({body:'实际发言才表达观点。'}),()=>0,c=>c.you==='claude'?'{"want":4,"why":"越界","action":"accept"}':{want:0,why:'没有补充'});
  try{
    await h.input('格式测试',{handRaise:true,maxCalls:7});await h.finish();assert.equal(h.hands.length,3);assert.equal(h.state().handRound!.ballots.claude.status,'invalid');assert.ok(h.state().handRound!.fallback);
    assert.equal(h.calls.length,3);assert.equal(h.state().phase,'waiting_user');assert.ok(h.messages().every(m=>!m.text.includes('"action"')));
  }finally{await h.dispose();}
});

test('human interjection invalidates in-flight hand votes and the new mention speaks first',async()=>{
  const releases:((vote:HandAnswer)=>void)[]=[];let ready!:()=>void;const started=new Promise<void>(r=>ready=r);
  const h=await fixture(()=>({body:'按最新补充回答。'}),()=>0,()=>new Promise<HandAnswer>(resolve=>{releases.push(resolve);if(releases.length===3)ready();}));
  try{
    await h.input('原议题',{handRaise:true,maxCalls:7});await started;await h.input('@DS 先回答新要求');
    releases.forEach((r,i)=>r({want:i===0?3:0,why:'旧意愿'}));await h.finish();
    assert.deepEqual(h.calls.slice(3).map(c=>c.you),['dsh']);assert.ok(h.calls[3].messages.some(m=>m.text.includes('新要求')));assert.equal(h.state().handRound!.status,'stale');assert.equal(h.state().handRound!.selected,undefined);
  }finally{releases.forEach(r=>r({want:0,why:'结束测试'}));await h.dispose();}
});

test('pause during polling stops old hands and fresh human text starts the next response round',async()=>{
  const releases:((vote:HandAnswer)=>void)[]=[];let ready!:()=>void;const started=new Promise<void>(r=>ready=r);
  const h=await fixture(()=>({body:'恢复后接话。'}),()=>0,()=>new Promise<HandAnswer>(resolve=>{releases.push(resolve);if(releases.length===3)ready();}));
  try{
    await h.input('举手暂停',{handRaise:true,maxCalls:7});await started;h.controller.pause();
    releases.forEach(r=>r({want:3,why:'还想补充'}));await h.finish();assert.equal(h.state().phase,'paused');assert.equal(h.calls.length,3);
    await h.input('@Claudia 暂停中补充',{handRaise:false});await h.finish();assert.equal(h.calls.length,4);assert.equal(h.state().phase,'waiting_user');assert.equal(h.calls[3].you,'claude');assert.ok(h.calls[3].messages.some(m=>m.text.includes('暂停中补充')));
  }finally{releases.forEach(r=>r({want:0,why:'结束测试'}));await h.dispose();}
});

test('unknown hand delivery preserves other votes and needs acknowledgment before rejoining',async()=>{
  const h=await fixture(()=>({body:'核对后正式接话。'}),()=>0,c=>c.you==='claude'?{failure:'receipt lost',unknown:true}:{want:0,why:'没有补充'});
  try{
    await h.input('未知投递',{handRaise:true,maxCalls:7});await h.finish();assert.equal(h.state().phase,'waiting_user');assert.equal(h.calls.length,3);assert.equal(h.hands.length,3);assert.equal(h.canceledHands(),0);
    assert.deepEqual(h.state().unknownRunIds,['run-4']);assert.throws(()=>h.controller.resume({}),/结果未知/);
    h.controller.resume({acknowledgeUnknown:true,handRaise:false,maxCalls:1});await h.finish();assert.equal(h.calls.length,4);assert.equal(h.state().phase,'waiting_user');assert.equal(h.hands.length,3);assert.deepEqual(h.state().acknowledgedRunIds,['run-4']);
  }finally{await h.dispose();}
});

test('restart retains every unknown hand request and never resumes a collecting round',async()=>{
  const h=await fixture(()=>({body:'继续发言。'}));
  try{
    await h.input('建立状态',{maxCalls:1});await h.finish();const d=h.state();
    for(const id of ['hand-a','hand-b'])h.store.put('runs',id,{id,bootId:'old',status:'running',delivery:'sent',sessionId:id} as Run);
    h.store.put('room','state',{...h.store.roomState(),active:true,discussion:{...d,handRaise:true,phase:'raising',handRound:{id:'round',revision:d.revision,status:'collecting',ballots:{claude:{status:'pending',runId:'hand-a'},dsh:{status:'pending',runId:'hand-b'}}}}});
    h.store.recover('new');assert.equal(h.state().phase,'blocked');assert.deepEqual(h.state().unknownRunIds,['hand-a','hand-b']);assert.equal(h.state().handRound!.status,'stopped');assert.equal(h.store.roomState().active,false);
    assert.throws(()=>h.controller.resume({}),/结果未知/);h.controller.resume({acknowledgeUnknown:true,handRaise:false,maxCalls:1});await h.finish();
    h.store.recover('next');assert.equal(h.state().unknownRunId,undefined);assert.deepEqual(h.state().acknowledgedRunIds,['hand-a','hand-b']);assert.equal(h.hands.length,0);
  }finally{await h.dispose();}
});

test('a single participant proposing closure waits for human input without hands or minutes',async()=>{
  const h=await fixture(()=>({action:'propose',body:'单人议题已处理完毕。'}));try{await h.input('单人讨论',{handRaise:true,memberIds:['dsh'],maxCalls:2});await h.finish();assert.equal(h.state().phase,'waiting_user');assert.equal(h.hands.length,0);assert.equal(h.calls.length,1);assert.equal(h.minutes.length,0);assert.equal(h.state().proposal,undefined);}finally{await h.dispose();}
});

test('a rebuilt native session gets previously read room context, not just the last eight messages',async()=>{
  const h=await fixture((_c,i)=>({body:`这是本轮新的观点 ${i}。`}),()=>0,undefined,i=>i===16?true:undefined);
  try{
    await h.input('必须保留最初的验收约束',{style:'chat',maxCalls:16});await h.finish();await h.input('@Claudia 继续检查');h.controller.resume({maxCalls:1});await h.finish();
    assert.ok(h.calls[16].messages.some(m=>m.text==='必须保留最初的验收约束'));assert.ok(h.calls[16].caughtUp);assert.equal(h.calls[16].you,'claude');
  }finally{await h.dispose();}
});

test('a stateless executor gets history every turn and pauses explicitly when it cannot fit a replay',async()=>{
  const h=await fixture((_c,i)=>({body:`新的意见 ${i}`}),()=>0,undefined,()=>false);
  try{
    await h.input('最早的约束必须带上',{style:'chat',memberIds:['claude'],maxCalls:12});await h.finish();assert.equal(h.calls.length,12);assert.ok(h.calls.every(c=>c.messages.some(m=>m.text==='最早的约束必须带上')));
    for(let i=0;i<35;i++)await h.input(`暂停后新增 ${i}`);h.controller.resume({maxCalls:5});await h.finish();
    assert.equal(h.calls.length,12);assert.equal(h.state().phase,'blocked');assert.match(h.state().reason!,/先压缩/);
  }finally{await h.dispose();}
});

test('one failed hand preserves peer receipts and no raised peer ends the response round',async()=>{
  const h=await fixture((_c,i)=>({body:'第 '+i+' 次发言'}),()=>0,c=>c.you==='claude'?{failure:'连接失败'}:{want:0,why:'没有主动补充'});try{await h.input('举手一人失败',{handRaise:true,maxCalls:12});await h.finish();assert.equal(h.state().phase,'waiting_user');assert.equal(h.calls.length,3);assert.equal(h.canceledHands(),0);assert.equal(h.state().handRound!.ballots.claude.status,'failed');assert.ok(h.warnings.some(w=>w.includes('连接失败')));assert.equal(h.state().calls,6);}finally{await h.dispose();}
});

test('all failed or rate-limited hands pause once without a fallback model call',async()=>{
  for(const limited of [false,true]){
    const h=await fixture((c,i)=>({body:`第 ${i+1} 位轮流发言`}),()=>0,()=>({failure:limited?'额度不足':'程序出错',limited}));
    try{await h.input('全员失败',{handRaise:true,maxCalls:20});await h.finish();assert.equal(h.state().phase,'blocked');assert.equal(h.hands.length,3);assert.equal(h.calls.length,3);assert.equal(h.state().calls,6);assert.equal(h.canceledHands(),0);if(limited)assert.match(h.state().reason!,/限流/);}finally{await h.dispose();}
  }
});

test('a known malformed reply gets exactly one budgeted correction in the same turn',async()=>{
  const h=await fixture((c,i)=>i===0?'忘记了格式':c.phase==='closing'?accept(c):c.canPropose?{action:'propose',body:'按原始约束核对完毕。'}:{body:'按原始约束回答。'});
  try{
    await h.input();await h.finish();assert.equal(h.state().phase,'waiting_user');assert.equal(h.calls.length,4);assert.equal(h.state().calls,4);
    assert.equal(h.calls[0].turn,h.calls[1].turn);assert.equal(h.calls[0].revision,h.calls[1].revision);assert.deepEqual(h.calls[0].messages,h.calls[1].messages);
    assert.equal(h.messages().filter(m=>m.author!=='user'&&m.text&&m.kind!=='summary').length,3);assert.ok(h.warnings.some(w=>w.includes('唯一一次补正')));
  }finally{await h.dispose();}
  const failed=await fixture(()=> '还是纯文本');
  try{await failed.input('补正失败继续其他成员',{maxCalls:6});await failed.finish();assert.equal(failed.calls.length,6);assert.equal(failed.state().phase,'blocked');assert.equal(failed.messages().filter(m=>m.status==='failed'&&m.text.includes('这次没能回答')).length,3);assert.ok(failed.messages().every(m=>!m.text.includes('纯文本')));}finally{await failed.dispose();}
});

test('correction respects remaining budget and never repairs a mismatched turn or closure proposal',async()=>{
  const limited=await fixture(()=> '无 JSON');
  try{await limited.input('仅一次预算',{maxCalls:1});await limited.finish();assert.equal(limited.calls.length,1);assert.equal(limited.state().phase,'budget');assert.match(limited.state().reason!,/补正/);}finally{await limited.dispose();}
  for(const wrong of ['turn','revision','version'] as const){
    const h=await fixture(()=>({body:'旧控制不能采用',[wrong]:{turn:'old-turn',revision:-1,version:2}[wrong]} as Answer));
    try{await h.input();await h.finish();assert.equal(h.calls.length,3);assert.equal(h.state().phase,'blocked');assert.equal(Object.keys(h.state().skippedMembers??{}).length,3);}finally{await h.dispose();}
  }
  const proposal=await fixture((c,i)=>c.phase==='closing'?{action:'accept',body:'',proposalId:'another-proposal'}:c.canPropose?{action:'propose',body:'已核对完毕。'}:{body:'本轮已回答 '+i});
  try{await proposal.input('旧协议收尾校验',{style:'chat'});await proposal.finish();assert.ok(proposal.calls.length>=4);assert.equal(proposal.state().phase,'idle');assert.equal(proposal.state().proposal!.accepted.length,1);assert.equal(proposal.state().proposal!.skipped!.length,2);assert.match(proposal.state().reason!,/没有表态/);}finally{await proposal.dispose();}
});

test('human pause and interjection suppress correction of an invalid old reply',async()=>{
  for(const pause of [false,true]){
    let release!:(answer:Answer)=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);
    const h=await fixture((_c,i)=>{if(i===0){entered();return new Promise<Answer>(r=>release=r);}return {body:'按新约束回应。'};});
    try{
      await h.input('旧要求',{maxCalls:2});await started;
      if(pause)h.controller.pause();else await h.input('@DS 新要求');
      release('旧回复格式无效');await h.finish();assert.equal(h.calls.length,pause?1:2);assert.equal(h.state().phase,pause?'paused':'waiting_user');assert.ok(h.messages().some(m=>m.discussionStale&&m.status==='failed'));
      if(!pause){assert.equal(h.calls[1].you,'dsh');assert.ok(h.calls[1].messages.some(m=>m.text.includes('新要求')));assert.notEqual(h.calls[0].turn,h.calls[1].turn);}
    }finally{release?.('结束测试');await h.dispose();}
  }
});

test('pause or unknown delivery during correction prevents further calls and false closure',async()=>{
  for(const unknown of [false,true]){
    let release!:(answer:Answer)=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);
    const h=await fixture((_c,i)=>{if(i===0)return '需要补正';if(i>1)return {body:'其他成员正常回答。'};entered();return new Promise<Answer>(r=>release=r);});
    try{
      await h.input();await started;if(!unknown)h.controller.pause();release(unknown?{failure:'lost correction receipt',unknown:true}:{action:'propose',body:'旧收尾不能继续。'});await h.finish();
      assert.equal(h.calls.length,unknown?4:2);assert.equal(h.state().phase,unknown?'waiting_user':'paused');assert.equal(h.state().proposal,undefined);
      if(unknown){assert.equal(h.state().unknownRunId,'run-2');assert.throws(()=>h.controller.resume({}),/结果未知/);}
    }finally{release?.('结束测试');await h.dispose();}
  }
});

test('invalid questions remain for later seated review and foreign answers do not remove pending obligations',async()=>{
  const review=await fixture((c,i)=>i===0?{body:'这里还有一个问题。',questions:[{to:'not-present',text:'谁来核对？'}]}:c.reviewRequired?{body:'重新明确：请 Codex 核对。',questions:[{to:'codex',text:'已经验证了吗？'}]}:{body:'按座位回答用户。'});
  try{await review.input('提问对象错误');await review.finish();assert.equal(review.calls.length,3);await review.input('@Claudia 请再明确提问对象');await review.finish();assert.deepEqual(review.calls.slice(0,4).map(c=>c.you),['claude','codex','dsh','claude']);assert.ok(review.calls[3].reviewRequired);assert.notEqual(review.state().phase,'idle');assert.equal(review.state().questions.filter(q=>!q.answeredBy).length,1);assert.ok(review.warnings.some(w=>w.includes('再次核对')));}finally{await review.dispose();}
  const foreign=await fixture((c,i)=>i===0?{body:'两位分别核对。',questions:[{to:'dsh',text:'DS 的检查？'},{to:'codex',text:'Codex 的检查？'}]}:i===1?{body:'我替 DS 确认。',answers:[c.questions.find(q=>q.to==='dsh')!.id]}:{body:'本轮回应，尚未完成检查。'});
  try{await foreign.input('不能代答',{maxCalls:3});await foreign.finish();assert.equal(foreign.state().questions.filter(q=>!q.answeredBy).length,2);assert.equal(foreign.state().proposal,undefined);assert.notEqual(foreign.state().phase,'idle');assert.ok(foreign.warnings.some(w=>w.includes('未经授权')));}finally{await foreign.dispose();}
});

test('a meeting raises hands only after a full round, and a round with no raised hand waits for the human',async()=>{
  const h=await fixture((c,i)=>({body:`第 ${i+1} 次发言`}),()=>0,()=>({want:0,why:'没有补充'}));
  try{
    await h.input('轮流开会',{handRaise:true,maxCalls:12});await h.finish();
    // No hand goes up mid-round and silence cannot start another round.
    assert.deepEqual(h.calls.map(c=>c.you),['claude','codex','dsh']);assert.equal(h.hands.length,3);
    assert.equal(h.state().phase,'waiting_user');assert.equal(h.state().calls,6);
  }finally{await h.dispose();}
  const chat=await fixture(()=>({body:'随便说说'}));
  try{await chat.input('闲聊不举手',{handRaise:true,style:'chat',maxCalls:4});await chat.finish();assert.equal(chat.state().handRaise,false);assert.equal(chat.hands.length,0);}finally{await chat.dispose();}
});

test('an interjection just after hands finish invalidates their selection and resets the human response round',async()=>{
  let interjected=false;
  const h=await fixture((c,i)=>{
    if(i===3){assert.equal(c.you,'dsh');assert.ok(c.messages.some(m=>m.text.includes('更新要求')));assert.equal(h.state().roundFrom,6);}
    return {body:`第 ${i+1} 次发言`};
  },()=>0,()=>({want:0,why:'没有补充'}));
  (h.controller as any).host.changed=()=>{
    if(!interjected&&h.state().handRound?.status==='done'){interjected=true;void h.input('@DS 更新要求，请先回应这条。');}
  };
  try{await h.input('会议原要求',{handRaise:true,maxCalls:7});await h.finish();assert.ok(interjected);assert.equal(h.calls.length,4);assert.equal(h.hands.length,3);assert.equal(h.state().phase,'waiting_user');assert.equal(h.state().handRound!.status,'stale');assert.equal(h.state().roundFrom,6);}finally{await h.dispose();}
});

test('chat questions expire after their recipient has a valid opportunity, without claiming an answer or expiring human questions',async()=>{
  for(const style of ['chat','work'] as const){
    const h=await fixture((c,i)=>i===0?{body:'你周末想做什么？',questions:[{to:'codex',text:'想去哪里？'}]}:i===1?{body:'我先说个别的想法。'}:{action:'pass',body:''});
    try{
      await h.input('随便聊聊',{style,maxCalls:0});await h.finish();
      const q=h.state().questions[0];assert.equal(h.calls[1].you,'codex');assert.equal(q.answeredBy,undefined);
      if(style==='chat'){assert.ok(q.expiredBy);assert.equal(h.state().phase,'idle');assert.ok(h.calls.slice(2).every(c=>c.questions.length===0));}
      else{assert.equal(q.expiredBy,undefined);assert.equal(h.state().phase,'waiting_user');assert.deepEqual([...new Set(h.calls.slice(2).map(c=>c.you))].sort(),['dsh']);}
    }finally{await h.dispose();}
  }
  const human=await fixture(()=>({action:'ask_user',body:'你呢？',questions:[{to:'user',text:'你的想法？'}]}));
  try{await human.input('问主人',{style:'chat',maxCalls:4});await human.finish();assert.equal(human.state().phase,'budget');assert.equal(human.calls.length,4);assert.equal(human.state().questions[0].expiredBy,undefined);assert.equal(human.state().questions[0].answeredBy,undefined);human.controller.resume({maxCalls:1});await human.finish();assert.equal(human.calls.length,5);}finally{await human.dispose();}
});

test('expired chat questions stay bounded over a long conversation and do not become answered',async()=>{
  const h=await fixture(c=>({body:`接着问 ${c.turn}`,questions:[{to:c.you==='claude'?'codex':'claude',text:'顺便聊个问题？'}]}));
  try{await h.input('多聊一会',{style:'chat',memberIds:['claude','codex'],maxCalls:150});await h.finish();assert.equal(h.state().phase,'budget');assert.equal(h.calls.length,150);assert.ok(h.state().questions.length<=65);assert.equal(h.state().questions.filter(q=>!q.expiredBy).length,1);assert.ok(h.state().questions.every(q=>!q.answeredBy));}finally{await h.dispose();}
});

test('casual member failures survive natural closure and the next human message without replay',async()=>{
  const h=await fixture((c,i)=>i===0?{failure:'quota exceeded',limited:true}:{action:'pass',body:''});
  try{
    await h.input('第一段闲聊',{style:'chat',maxCalls:0});await h.finish();assert.equal(h.state().phase,'idle');assert.deepEqual(h.calls.map(c=>c.you),['claude','codex','dsh']);
    await h.input('第二段闲聊',{style:'chat',maxCalls:0});await h.finish();assert.equal(h.state().phase,'idle');assert.deepEqual(h.calls.slice(3).map(c=>c.you),['codex','dsh']);assert.equal(h.state().skippedMembers?.claude.limited,true);
    h.controller.resume({maxCalls:3});await h.finish();assert.ok(h.calls.slice(5).some(c=>c.you==='claude'));
  }finally{await h.dispose();}
});

test('chat input and resume clear legacy hand flags, and switching style cannot erase an unknown result',async()=>{
  const h=await fixture(()=>({body:'聊天继续'}));
  try{
    await h.input('闲聊',{style:'chat',maxCalls:1});await h.finish();
    h.store.put('room','state',{...h.store.roomState(),discussion:{...h.state(),handRaise:true}});
    h.controller.resume({maxCalls:1});await h.finish();assert.equal(h.state().handRaise,false);
    h.store.put('room','state',{...h.store.roomState(),discussion:{...h.state(),handRaise:true}});
    await h.input('补充');assert.equal(h.state().handRaise,false);assert.equal(h.hands.length,0);
  }finally{await h.dispose();}
  const unknown=await fixture(()=>({failure:'连接中断',unknown:true}));
  try{await unknown.input('未确认',{style:'chat'});await unknown.finish();const id=unknown.state().id;await assert.rejects(()=>unknown.input('换成开会',{style:'work'}),/待核对/);assert.equal(unknown.state().id,id);assert.equal(unknown.calls.length,3);}finally{await unknown.dispose();}
});

test('late emoji-only replies do not react to the human interjection or resume a pause',async()=>{
  for(const pause of [false,true]){
    let release!:(answer:Answer)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
    const h=await fixture((_c,i)=>{if(i===0){entered();return new Promise<Answer>(resolve=>release=resolve);}return {action:'pass',body:''};});
    try{await h.input('旧话',{style:'chat',maxCalls:3});await started;if(pause)h.controller.pause();else await h.input('主人插话');release({action:'react',body:'',emoji:'😄'});await h.finish();assert.ok(h.messages().every(m=>!m.reactions));if(pause)assert.equal(h.state().phase,'paused');}finally{release?.({action:'pass',body:''});await h.dispose();}
  }
});

test('meeting minutes require a human request and preserve actual remarks without unanimous closure',async()=>{
  const h=await fixture(()=>({body:'保留对配色的分歧；Codex 负责验证，未约定时间。'}));try{await h.input('开会决定测试分工');await h.finish();assert.equal(h.minutes.length,0);await h.requestMinutes();await h.finish();const summary=h.messages().find(m=>m.kind==='summary')!;assert.equal(h.minutes.length,1);assert.equal(summary.status,'done');assert.equal(summary.author,'claude');assert.equal(h.state().meetingMinutes?.source,'user');assert.equal(h.state().proposal,undefined);assert.ok(h.minutes[0].messages.some(m=>m.text.includes('保留对配色的分歧')));assert.equal(h.state().calls,4);assert.equal(h.state().endedBy,'user');assert.match(roomMarkdown(h.store.currentRoomThread(),h.messages(),id=>id),/会议总结/);}finally{await h.dispose();}
  const chat=await fixture(()=>({action:'pass',body:''}));try{await chat.input('随便聊聊',{style:'chat',maxCalls:0});await chat.finish();assert.equal(chat.state().phase,'idle');assert.equal(chat.minutes.length,0);}finally{await chat.dispose();}
});

test('human minutes are explicit additional work and reject exhausted summarizers without dispatch',async()=>{
  let exhausted=false;const h=await fixture(()=>({body:'已回答，等待主人。'}),()=>0,undefined,undefined,()=>exhausted?0:1);try{await h.input('单人会议',{memberIds:['claude'],maxCalls:1});await h.finish();assert.equal(h.state().phase,'waiting_user');exhausted=true;await assert.rejects(h.requestMinutes(),/可用/);assert.equal(h.minutes.length,0);exhausted=false;await h.requestMinutes();await h.finish();assert.equal(h.calls.length,1);assert.equal(h.minutes.length,1);assert.equal(h.state().phase,'idle');assert.equal(h.state().meetingMinutes?.source,'user');}finally{await h.dispose();}
});

test('pausing minutes discards the late result and only explicit resume starts another summary turn',async()=>{
  for(const textCommand of [false,true]){
  let release!:(answer:Answer)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
  const h=await fixture(()=>({action:'propose',body:'会议已确认。'}),()=>0,undefined,undefined,undefined,()=>{if(!release){entered();return new Promise<Answer>(resolve=>release=resolve);}return {body:'重新整理的完整纪要。'};});
  try{await h.input('测试纪要暂停',{memberIds:['claude']});await h.finish();await h.requestMinutes();await started;if(textCommand)await h.input('先停一停');else h.controller.pause();release({body:'迟到的纪要'});await h.finish();assert.equal(h.state().phase,'paused');assert.equal(h.minutes.length,1);assert.ok(!h.messages().some(m=>m.text.includes('迟到')));assert.equal(h.state().proposal,undefined);assert.equal(h.state().meetingMinutes?.source,'user');
    if(textCommand)await h.input('继续讨论');else h.controller.resume({});await h.finish();assert.equal(h.minutes.length,2);assert.notEqual(h.minutes[0].turn,h.minutes[1].turn);assert.equal(h.calls.length,1);assert.equal(h.state().phase,'idle');assert.equal(h.messages().filter(m=>m.kind==='summary'&&m.status==='done').length,1);
  }finally{release?.({body:'清理'});await h.dispose();}
  }
});

test('unknown minutes and mismatched turn IDs stop once without automatic resend or fabricated completion',async()=>{
  for(const kind of ['unknown','turn'] as const){
    const h=await fixture(()=>({action:'propose',body:'已确认结论。'}),()=>0,undefined,undefined,undefined,c=>kind==='unknown'?{failure:'投递结果不确定',unknown:true}:{body:'旧纪要',turn:'previous-turn'});
    try{await h.input('纪要校验',{memberIds:['claude']});await h.finish();await h.requestMinutes();await h.finish();assert.equal(h.minutes.length,1);assert.equal(h.state().phase,'blocked');assert.equal(h.state().endedAt,undefined);assert.equal(h.state().meetingMinutes?.status,'failed');assert.ok(!h.messages().some(m=>m.kind==='summary'&&m.status==='done'));
      if(kind==='unknown')assert.throws(()=>h.controller.resume({}),/结果未知/);
    }finally{await h.dispose();}
  }
});

test('human interjection invalidates old minutes without completing the revised meeting or applying old controls',async()=>{
  let release!:(answer:Answer)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
  const h=await fixture((c,i)=>i===0?{action:'propose',body:'旧结论。'}:{action:'ask_user',body:'请确认新的安排。',questions:[{to:'user',text:'新安排是什么？'}]},()=>0,undefined,undefined,undefined,()=>{entered();return new Promise<Answer>(resolve=>release=resolve);});
  try{await h.input('旧计划',{memberIds:['claude']});await h.finish();await h.requestMinutes();await started;await h.input('计划已变，需要重新讨论');release({body:'旧计划的纪要'});await h.finish();assert.equal(h.state().phase,'waiting_user');assert.equal(h.state().meetingMinutes?.status,'stale');assert.equal(h.state().endedAt,undefined);assert.equal(h.calls.length,2);assert.ok(!h.messages().some(m=>m.kind==='summary'&&m.status==='done'));}finally{release?.({body:'清理'});await h.dispose();}
});

test('restart during minutes retains the human request and unknown receipt without replay',async()=>{
  let release!:(answer:Answer)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
  const h=await fixture(()=>({action:'propose',body:'结论已确认。'}),()=>0,undefined,undefined,undefined,()=>{entered();return new Promise<Answer>(resolve=>release=resolve);});
  try{await h.input('重启保护',{memberIds:['claude']});await h.finish();await h.requestMinutes();await started;const runId=h.state().meetingMinutes!.runId!;h.store.put('runs',runId,{id:runId,status:'running',delivery:'confirmed',sessionId:'minutes',bootId:'previous'} as Run);h.store.recover('next');
    assert.equal(h.state().phase,'blocked');assert.ok(h.state().unknownRunIds?.includes(runId));assert.equal(h.state().proposal,undefined);assert.equal(h.state().meetingMinutes?.source,'user');
    release({body:'重启前纪要'});await h.finish();assert.throws(()=>h.controller.resume({}),/结果未知/);assert.equal(h.minutes.length,1);assert.ok(!h.messages().some(m=>m.kind==='summary'&&m.status==='done'));
  }finally{release?.({body:'清理'});await h.dispose();}
});

for(const count of [2,3,4])test(`settings default meeting: ${count} participants receive ${count*2} formal speeches, auxiliary votes are separate`,async()=>{
  const h=await fixture(()=>({body:'正式观点'}),()=>0,()=>({want:1,why:'还有补充'}));try{
    const fourth=normalizeMember({name:'第四位',executor:'claude'},undefined,'m-fourth');h.store.put('members',fourth.id,fourth);
    const members=['claude','codex','dsh',fourth.id].slice(0,count);
    await h.input('各自说观点，再补充一次',{memberIds:members,maxCalls:undefined,handRaise:true});await h.finish();
    assert.equal(h.state().allowance,count*2);assert.equal(h.state().budgetKind,'speech');assert.equal(h.state().speechCalls,count*2);assert.equal(h.calls.length,count*2);
    assert.ok(h.hands.length>=count);assert.equal(h.state().calls,h.calls.length+h.hands.length);assert.equal(h.state().phase,'waiting_user');
    await h.input('下一轮继续',{memberIds:members,maxCalls:undefined,handRaise:false});await h.finish();assert.equal(h.calls.length,count*3);assert.equal(h.state().limit,count*4);
  }finally{await h.dispose();}
});
test('settings custom speech cap permits a correction and human minutes without spending another formal speech',async()=>{
  const h=await fixture((_c,i)=>i===0?'invalid JSON':{body:'补正后的真实观点'});try{
    h.store.put('settings','main',{discussionCallLimits:{chat:{mode:'unlimited',calls:8},work:{mode:'custom',calls:1}}});
    await h.input('限一次正式发言',{maxCalls:undefined});await h.finish();assert.equal(h.calls.length,2);assert.equal(h.state().speechCalls,1);assert.equal(h.state().phase,'budget');
    await h.requestMinutes();await h.finish();assert.equal(h.minutes.length,1);assert.equal(h.state().speechCalls,1);assert.equal(h.state().calls,3);
  }finally{await h.dispose();}
});
test('chat defaults to unlimited and settings replace a legacy finite cap when continuing',async()=>{
  const h=await fixture((_c,i)=>i>5?{action:'pass',body:''}:i===5?{action:'ask_user',body:'接下来想聊什么？',questions:[{to:'user',text:'你的想法？'}]}:{body:'继续闲聊'});try{
    await h.input('旧聊天',{style:'chat',maxCalls:2});await h.finish();assert.equal(h.state().phase,'budget');
    h.controller.resume({});await h.finish();assert.ok(h.calls.length>6);assert.equal(h.state().limit,0);assert.equal(h.state().allowance,0);assert.equal(h.state().minutes,0);assert.equal(h.state().phase,'idle');assert.ok(h.state().questions.some(q=>q.to==='user'&&!q.answeredBy));
  }finally{await h.dispose();}
});
test('custom chat and unlimited meetings are independent settings',async()=>{
  const h=await fixture(()=>({body:'一条正式回复'}));try{
    h.store.put('settings','main',{discussionCallLimits:{chat:{mode:'custom',calls:4},work:{mode:'unlimited',calls:8}}});
    await h.input('四次闲聊',{style:'chat',maxCalls:undefined});await h.finish();assert.equal(h.calls.length,4);assert.equal(h.state().phase,'budget');
    await h.input('开始开会',{style:'work',maxCalls:undefined});await h.finish();assert.equal(h.state().limit,0);assert.equal(h.calls.length,7);assert.equal(h.state().phase,'waiting_user');
  }finally{await h.dispose();}
});
