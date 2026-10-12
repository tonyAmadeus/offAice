import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from './helpers/seeded-engine';
import { acknowledgedNativeContext, nativeContextNeedsRefresh, NATIVE_CONTEXT_REFRESH_CHARS } from '../src/backend/native-context';
import type { Adapter, AdapterContext, Session } from '../src/shared/types';

test('native refresh is bounded by turns, input size, native identity and explicit compression', () => {
  const session = { nativeId: 'native', nativeContext: { nativeId: 'native', turnsSinceRefresh: 1, inputCharsSinceRefresh: 10 } } as Session;
  assert.equal(nativeContextNeedsRefresh(session), false);
  assert.equal(nativeContextNeedsRefresh(session, NATIVE_CONTEXT_REFRESH_CHARS), true);
  for (let i=0;i<3;i++) session.nativeContext=acknowledgedNativeContext(session, 100, false, false);
  assert.equal(nativeContextNeedsRefresh(session), true);
  session.nativeContext=acknowledgedNativeContext(session,100,true,false);
  assert.equal(nativeContextNeedsRefresh(session), false);
  session.nativeContext=acknowledgedNativeContext(session,100,false,true);
  assert.equal(nativeContextNeedsRefresh(session), true);
  session.nativeId='another';assert.equal(nativeContextNeedsRefresh(session), true);
});

test('Engine refreshes short and long meetings without replaying acknowledged messages or rewinding seen', async () => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM-context-refresh-'));
  const calls:{ctx:AdapterContext;prompt:string;input:any;seen:number}[]=[];
  let compress=false;
  const factory=():Adapter=>({
    probe:async()=>({id:'codex',name:'Codex',available:true,auth:'subscription',detail:'fixture',capabilities:{streaming:true,write:false,history:true,cancel:'native',steer:false}}),
    stop:async()=>{},
    start:async(ctx,prompt)=>{
      const input=JSON.parse(prompt.split('\nAIROOM_CONTEXT\n')[1]);
      const seen=engine.store.roomState().discussion?.seen.codex??0;
      for(const message of input.messages){const row=engine.store.get<any>('room_messages',message.id);assert.ok(row.discussionRevision>seen,`already acknowledged message ${message.text}`);}
      calls.push({ctx,prompt,input,seen});
      ctx.persistNativeSession('native-fixture');ctx.markDelivery('confirmed');
      if(compress){ctx.invalidateNativeContext?.();compress=false;}
      ctx.emit('delta',JSON.stringify({version:1,turn:input.turn,revision:input.revision,action:'speak',body:'实际回复'}));
      return {};
    },
  });
  const engine=new Engine(directory,()=>{},()=>{},factory);
  const send=async(text:string)=>{
    await engine.invoke('room.send',{text,mode:'discuss',style:'work',memberIds:['codex']});
    const deadline=Date.now()+10000;
    while(engine.store.roomState().active){if(Date.now()>deadline)assert.fail('meeting did not settle');await new Promise(r=>setTimeout(r,10));}
    assert.equal(engine.store.roomState().discussion?.phase,'waiting_user');
  };
  try{
    await engine.probe();
    for(let i=0;i<5;i++)await send(i===0?'原始决定：待办甲必须保留':'继续 '+i);
    assert.equal(calls.length,5);assert.equal(calls[1].input.incremental,true);
    assert.equal(calls[4].input.incremental,false);assert.ok(!calls[4].input.messages.some((m:any)=>m.text.includes('待办甲')));
    assert.ok(calls[4].input.recent.some((m:any)=>m.text.includes('待办甲')));
    assert.doesNotMatch(calls[4].prompt,/AIROOM 人物与记忆更新/);
    compress=true;await send('本轮执行端报告压缩');await send('压缩后续聊');
    assert.equal(calls.length,7);assert.equal(calls[6].input.incremental,false);
    assert.ok(!calls[6].input.messages.some((m:any)=>m.text.includes('待办甲')));
    for(let i=7;i<22;i++){
      const before=engine.store.roomState().discussion!.seen.codex;
      await send('长会议继续 '+i);
      assert.ok(engine.store.roomState().discussion!.seen.codex>=before);
    }
    assert.equal(calls.length,22);
    assert.ok(calls.some(c=>c.seen>32&&!c.input.incremental&&c.input.recent.length===8));
    const session=engine.store.get<Session>('sessions',calls.at(-1)!.ctx.session.id)!;
    assert.equal(session.nativeContext?.refreshRequired,false);
    const stamp=structuredClone(session.nativeContext);
    await engine.close();
    const reopened=new Engine(directory,()=>{},()=>{},factory);
    try{assert.deepEqual(reopened.store.get<Session>('sessions',session.id)?.nativeContext,stamp);}finally{await reopened.close();}
  }finally{await engine.close();await rm(directory,{recursive:true,force:true,maxRetries:5});}
});
