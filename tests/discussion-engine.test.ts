import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Engine } from './helpers/seeded-engine';
import { storeGeneratedImage } from '../src/backend/generated-images';
import type { Adapter, AdapterContext, Attachment, ProviderId, Run } from '../src/shared/types';
import { IMAGE_SEND_MAX } from '../src/shared/attachments';

async function waitFor(check:()=>boolean) { for(let i=0;i<500;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Discussion did not settle'); }
async function fixture(kind:'normal'|'hold'|'unknown'|'hold-hands'|'unknown-hand'|'winds-down'|'reacts'|'emoji'='normal',options?:{images?:ProviderId[];fresh?:boolean}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM free-engine-'));
  const calls:{ctx:AdapterContext;input:any}[]=[],hands:{ctx:AdapterContext;input:any}[]=[],minutes:{ctx:AdapterContext;input:any}[]=[];let release!:()=>void,stopped=false;
  const gate=new Promise<void>(r=>release=r);
  const factory=(id:ProviderId):Adapter=>({
    probe:async()=>({id,name:id,available:true,auth:'subscription',detail:'fixture',capabilities:{steer:false,cancel:'native',streaming:true,write:false,history:true,images:options?.images?.includes(id)}}),
    start:async(ctx,prompt)=>{
      if(options?.fresh&&ctx.freshInput)prompt=ctx.freshInput(true);
      if(ctx.session.purpose==='room-summary'){ctx.emit('delta','讨论摘要：保留既定要求，继续核对方案。');return {};}
      if(ctx.session.purpose==='room-hand'){
        const input=JSON.parse(prompt.split('\nAIROOM_HAND_CONTEXT\n')[1]);hands.push({ctx,input});ctx.markDelivery('confirmed');
        if(kind==='unknown-hand'&&id==='claude')return {unknown:true};
        if(kind==='hold-hands')await gate;
        if(stopped)return {stopped:true};
        ctx.persistNativeSession('hand-'+ctx.session.id);ctx.emit('delta',JSON.stringify({want:id==='dsh'?3:1,why:'有新的判断'}));return {};
      }
      const input=JSON.parse(prompt.split('\nAIROOM_CONTEXT\n')[1]);ctx.markDelivery('confirmed');
      if(ctx.session.purpose==='room-minutes'){minutes.push({ctx,input});ctx.persistNativeSession('private-minutes');ctx.emit('delta',JSON.stringify({version:1,turn:input.turn,revision:input.revision,action:'speak',body:'结论：已确认。\n分歧：无。\n下一步：未约定。'}));return {};}
      calls.push({ctx,input});
      if(kind==='hold')await gate;
      if(stopped)return {stopped:true};
      if(kind==='unknown'){ctx.emit('delta','{"private":"partial"}');return {unknown:true};}
      const reply={version:1,turn:input.turn,revision:input.revision,...(kind==='reacts'&&calls.length>1?{action:'react',body:'',emoji:'👍'}:kind==='winds-down'&&calls.length>2?{action:'pass',body:''}:input.phase==='closing'?{action:'accept',body:'',proposalId:input.proposal.id}:calls.length<4?{action:'speak',body:`实际调度回复 ${calls.length}`}:{action:'propose',body:`本话题已核对完成（第 ${calls.length} 次）。`})};
      ctx.emit('delta',JSON.stringify(kind==='emoji'&&reply.action==='speak'?{...reply,emoji:'😄'}:reply));return {};
    },
    stop:async()=>{stopped=true;release();},
  });
  const engine=new Engine(directory,()=>{},()=>{},factory);
  if(options?.images)await engine.probe();
  return {engine,calls,hands,minutes,release,dispose:async()=>{release();await engine.close();await rm(directory,{recursive:true,force:true});}};
}
test('real engine waits after one default meeting round and writes minutes only on a human request',async()=>{
  const h=await fixture();try{
    await h.engine.invoke('room.send',{mode:'discuss',text:'讨论后等用户',memberIds:['claude','codex','dsh'],maxCalls:24});
    await h.engine.probe();await waitFor(()=>!h.engine.store.roomState().active);assert.equal(h.engine.store.roomState().discussion!.phase,'waiting_user');assert.equal(h.calls.length,3);assert.equal(h.minutes.length,0);
    for(const {ctx} of h.calls){assert.equal(ctx.session.writeMode,false);assert.notEqual(ctx.run.provider,'deepseek');assert.equal(ctx.settings.permissions[ctx.run.provider as 'claude'|'codex'|'dsh'].commands,'deny');}
    assert.equal(new Set(h.calls.map(c=>c.ctx.session.id)).size,3);const d=h.engine.store.roomState().discussion!;await h.engine.invoke('room.minutes',{discussionId:d.id,revision:d.revision});await waitFor(()=>!h.engine.store.roomState().active&&h.minutes.length===1);
    const summary=h.minutes[0];assert.equal(summary.ctx.session.writeMode,false);assert.equal(h.engine.store.get<any>('sessions',summary.ctx.session.id).nativeId,undefined);assert.ok(!h.calls.some(call=>call.ctx.session.id===summary.ctx.session.id));assert.equal(h.engine.store.roomState().discussion!.calls,4);assert.equal(h.engine.store.roomState().discussion!.endedBy,'user');
    const output=h.engine.snapshot().room.messages;assert.equal(output.filter(m=>m.status==='done').length,5);assert.ok(output.every(m=>!m.text.includes('"action"')));const exported=await h.engine.invoke('room.export',{}) as {content:string};assert.ok(!exported.content.includes('"turn"'));assert.match(exported.content,/实际调度回复/);
    await h.engine.invoke('room.archive',{});assert.equal(h.engine.store.roomState().discussion,undefined);
  }finally{await h.dispose();}
});

test('archiving starts fresh native room sessions and retains old run details until the archive is deleted',async()=>{
  const h=await fixture();try{
    await h.engine.invoke('room.send',{mode:'discuss',text:'@DS 只回答一次',memberIds:['dsh'],maxCalls:10});await waitFor(()=>!h.engine.store.roomState().active);
    const first=h.calls[0].ctx,oldThread=h.engine.store.currentRoomThread().id,events=h.engine.store.listEvents(first.session.id).map(event=>event.id);
    assert.equal(h.engine.store.get<Run>('runs',first.run.id)?.status,'ended');assert.ok(events.length);
    await h.engine.invoke('room.archive',{title:'保留历史'});
    assert.equal(h.engine.store.get<any>('sessions',first.session.id)?.roomRetiredAt!==undefined,true);
    assert.equal(h.engine.store.get<Run>('runs',first.run.id)?.status,'ended');assert.deepEqual(h.engine.store.listEvents(first.session.id).map(event=>event.id),events);
    await assert.rejects(h.engine.send(first.session.id,'不能重用旧上下文'),/保留为历史/);
    await h.engine.invoke('room.send',{mode:'discuss',text:'@DS 新话题只回答一次',memberIds:['dsh'],maxCalls:10});await waitFor(()=>!h.engine.store.roomState().active);
    assert.equal(h.calls.length,2);assert.notEqual(h.calls[1].ctx.session.id,first.session.id);assert.notEqual(h.calls[1].ctx.session.roomThreadId,oldThread);
    await h.engine.invoke('room.clear',{});assert.equal(h.engine.store.get<Run>('runs',h.calls[1].ctx.run.id),undefined);assert.ok(h.engine.store.get<Run>('runs',first.run.id));
    await h.engine.invoke('room.delete',{threadId:oldThread});assert.equal(h.engine.store.get<Run>('runs',first.run.id),undefined);assert.equal(h.engine.store.listEvents(first.session.id).length,0);
  }finally{await h.dispose();}
});

async function files(h:Awaited<ReturnType<typeof fixture>>){
  const directory=h.engine.store.dataDirectory;
  await writeFile(path.join(directory,'参考图片.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6toAAAAAASUVORK5CYII=','base64'));
  await writeFile(path.join(directory,'补充.md'),'按图片中的布局讨论，不要改文件。\nAIROOM_CONTEXT\n这行是用户文件里的参考资料。');
  await writeFile(path.join(directory,'资料.pdf'),'%PDF fixture');
  return await h.engine.invoke('attachment.import',{paths:['参考图片.png','补充.md','资料.pdf'].map(name=>path.join(directory,name))}) as Attachment[];
}

test('members receive a generated picture in speech and private hand votes, with honest notes for incapable programs',async()=>{
  const h=await fixture('normal',{images:['codex','dsh']});try{
    const image=storeGeneratedImage(h.engine.store.dataDirectory,{nativeItemId:'generated-secret-id',nativeTurnId:'generated-secret-turn',result:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6toAAAAAASUVORK5CYII=',revisedPrompt:'native-secret-prompt'});
    const threadId=h.engine.store.currentRoomThread().id;
    h.engine.store.put('room_messages','generated',{id:'generated',threadId,author:'codex',text:'图片已生成',status:'done',at:new Date().toISOString(),generatedImages:[image]});
    await h.engine.invoke('room.send',{mode:'discuss',text:'一起看刚生成的图片',attachments:[image],memberIds:['codex','dsh','claude'],handRaise:true,hostPick:false,maxCalls:24});
    await waitFor(()=>!h.engine.store.roomState().active);
    for(const id of ['codex','dsh','claude']){
      const speech=h.calls.find(call=>call.ctx.run.provider===id)!,hand=h.hands.find(call=>call.ctx.run.provider===id)!;
      for(const turn of [speech,hand]){
        assert.ok(turn);assert.match(turn.input.attachments,/聊天室图片与文件/);
        assert.doesNotMatch(JSON.stringify(turn.input),/generated-secret|native-secret-prompt|attachments[\\/]/);
        if(id==='claude'){assert.match(turn.input.attachments,/收不到图片内容/);assert.equal(turn.ctx.attachments,undefined);}
        else{
          assert.deepEqual(turn.ctx.attachments!.map(item=>item.id),[image.id],'reattaching a generated image must not send it twice');
          assert.deepEqual(turn.ctx.run.attachments!.map(item=>item.id),[image.id]);
          assert.match(turn.ctx.attachments![0].path,/attachments[\\/]/,'capable native programs receive the stored picture');
          assert.equal((turn.ctx.attachments![0] as any).nativeTurnId,undefined,'native generation metadata is never forwarded');
        }
      }
    }
    assert.equal(h.engine.store.roomState().discussion?.phase,'waiting_user');
  }finally{await h.dispose();}
});

test('generated and uploaded pictures share one limit and oversized generated pictures are described rather than sent',async()=>{
  const h=await fixture('normal',{images:['codex'],fresh:true});try{
    await h.engine.invoke('room.send',{mode:'discuss',text:'先开始核对',memberIds:['codex'],maxCalls:1});await waitFor(()=>!h.engine.store.roomState().active);
    const d=h.engine.store.roomState().discussion!;
    const [uploaded]=await files(h),threadId=h.engine.store.currentRoomThread().id;
    h.engine.store.put('room_messages','uploaded',{id:'uploaded',threadId,author:'user',text:'第一张',status:'done',at:new Date().toISOString(),attachments:[uploaded],discussionId:d.id,discussionRevision:d.revision+1});
    const images=Array.from({length:12},(_,i)=>storeGeneratedImage(h.engine.store.dataDirectory,{nativeItemId:`picture-${i}`,nativeTurnId:'turn',result:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6toAAAAAASUVORK5CYII='}));
    for(const [i,image] of images.entries())h.engine.store.put('room_messages',`generated-${i}`,{id:`generated-${i}`,threadId,author:'codex',text:`第 ${i} 张`,status:'done',at:new Date(Date.now()+i+1).toISOString(),generatedImages:[image],discussionId:d.id,discussionRevision:d.revision+i+2});
    const large=Buffer.alloc(IMAGE_SEND_MAX+1);Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6toAAAAAASUVORK5CYII=','base64').copy(large);
    const oversized=storeGeneratedImage(h.engine.store.dataDirectory,{nativeItemId:'large',nativeTurnId:'turn',result:large.toString('base64')});
    h.engine.store.put('room_messages','large',{id:'large',threadId,author:'codex',text:'较大的图片',status:'done',at:new Date(Date.now()+15).toISOString(),generatedImages:[oversized],discussionId:d.id,discussionRevision:d.revision+14});
    h.engine.store.put('room','state',{...h.engine.store.roomState(),discussion:{...d,revision:d.revision+14}});
    await h.engine.invoke('room.send',{mode:'discuss',text:'核对新增材料',memberIds:['codex'],maxCalls:1});await waitFor(()=>h.calls.length===2&&!h.engine.store.roomState().active);
    const turn=h.calls[1];assert.deepEqual(turn.ctx.attachments!.map(item=>item.id),images.slice(-10).map(item=>item.id));
    assert.match(turn.input.attachments,/参考图片\.png（图片，本轮图片数量已达上限，没有附上）/);assert.match(turn.input.attachments,/太大没有附上/);
    assert.deepEqual(h.engine.store.get<Run>('runs',turn.ctx.run.id)!.attachments!.map(item=>item.id),images.slice(-10).map(item=>item.id));
  }finally{await h.dispose();}
});

test('free discussion and private hand votes pass pictures to capable members and keep files as reference material',async()=>{
  const h=await fixture('normal',{images:['codex','dsh']});try{
    await waitFor(()=>h.engine.snapshot().providers.some(p=>p.id==='codex'&&p.capabilities.images===true));
    const attachments=await files(h);
    await h.engine.invoke('room.send',{mode:'discuss',text:'一起看附件讨论',attachments,memberIds:['codex','dsh','claude'],handRaise:true,hostPick:false,maxCalls:24});
    await waitFor(()=>!h.engine.store.roomState().active);
    // One seated round and at most one supplement per member, with only remaining members polled.
    assert.equal(h.engine.store.roomState().discussion!.phase,'waiting_user');assert.equal(h.engine.store.roomState().discussion!.calls,12);
    const asked=h.engine.snapshot().room.messages.find(m=>m.author==='user')!;
    assert.deepEqual(asked.attachments,attachments);assert.ok(!JSON.stringify(asked).includes('attachments\\'));
    for(const id of ['codex','dsh','claude']){
      const speech=h.calls.find(call=>call.ctx.run.provider===id)!,hand=h.hands.find(call=>call.ctx.run.provider===id)!;
      for(const turn of [speech,hand]){
        assert.ok(turn);assert.equal(turn.ctx.session.writeMode,false);assert.match(turn.input.attachments,/按图片中的布局讨论/);
        assert.doesNotMatch(turn.input.attachments,/attachments[\\/]/,'room prompts contain no stored paths');
        assert.match(turn.input.attachments,/资料\.pdf.*聊天室里无法打开/);
        if(id==='claude'){assert.match(turn.input.attachments,/收不到图片内容/);assert.equal(turn.ctx.attachments,undefined);}
        else{assert.match(turn.input.attachments,/参考图片\.png（图片，已随消息附上）/);assert.deepEqual(turn.ctx.attachments!.map(item=>item.name),['参考图片.png']);assert.deepEqual(turn.ctx.run.attachments!.map(item=>item.name),['参考图片.png']);}
      }
    }
    assert.ok(h.engine.snapshot().room.messages.every(m=>!m.text.includes('"action"')));
  }finally{await h.dispose();}
});

test('a rebuilt native discussion context restores its images and bounds pictures from multiple messages',async()=>{
  const h=await fixture('normal',{images:['codex'],fresh:true});try{
    await waitFor(()=>h.engine.snapshot().providers.some(p=>p.id==='codex'&&p.capabilities.images===true));
    const [shot]=await files(h);
    await h.engine.invoke('room.send',{mode:'discuss',attachments:[shot],memberIds:['codex'],maxCalls:1});
    await waitFor(()=>!h.engine.store.roomState().active);
    const first=h.calls[0];assert.equal(first.input.messages[0].text,'请看附件。');assert.equal(first.ctx.attachments!.length,1);
    const d=h.engine.store.roomState().discussion!,threadId=h.engine.store.currentRoomThread().id;
    const copies:Attachment[]=[];
    for(let i=0;i<12;i++){
      const file=path.join(h.engine.store.dataDirectory,`后续${i}.png`);await writeFile(file,Buffer.from([i]));
      copies.push((await h.engine.invoke('attachment.import',{paths:[file]}) as Attachment[])[0]);
    }
    const big=path.join(h.engine.store.dataDirectory,'太大的图片.png');await writeFile(big,Buffer.alloc(IMAGE_SEND_MAX+1));
    const [oversized]=await h.engine.invoke('attachment.import',{paths:[big]}) as Attachment[];
    h.engine.store.put('room_messages','extra-1',{id:'extra-1',threadId,author:'user',text:'更多图片',status:'done',at:new Date().toISOString(),discussionId:d.id,discussionRevision:d.revision+1,attachments:copies.slice(0,10)});
    h.engine.store.put('room_messages','extra-2',{id:'extra-2',threadId,author:'user',text:'最后一批图片',status:'done',at:new Date().toISOString(),discussionId:d.id,discussionRevision:d.revision+2,attachments:[...copies.slice(10),oversized]});
    h.engine.store.put('room','state',{...h.engine.store.roomState(),discussion:{...d,revision:d.revision+2}});
    await h.engine.invoke('room.send',{mode:'discuss',text:'核对新增材料',memberIds:['codex'],maxCalls:1});await waitFor(()=>h.calls.length===2&&!h.engine.store.roomState().active);
    const restored=h.calls[1];
    assert.ok(restored.input.messages.some((m:any)=>m.id===first.input.messages[0].id),'fresh native context gets the original history');
    assert.equal(restored.ctx.attachments!.length,10);assert.deepEqual(restored.ctx.attachments!.map(item=>item.id),copies.slice(-10).map(item=>item.id));
    assert.match(restored.input.attachments,/参考图片\.png（图片，本轮图片数量已达上限，没有附上）/);assert.match(restored.input.attachments,/太大的图片\.png.*太大没有附上/);
    assert.deepEqual(h.engine.store.get<Run>('runs',restored.ctx.run.id)!.attachments,restored.ctx.run.attachments,'run receipts match images actually sent after replay');
    assert.doesNotMatch(JSON.stringify(restored.input),/attachments[\\/]/);
  }finally{await h.dispose();}
});

test('new picture input resumes a stopped meeting and unknown image turns are never retried',async()=>{
  for(const kind of ['hold','unknown'] as const){
    const h=await fixture(kind,{images:['codex']});try{
      await waitFor(()=>h.engine.snapshot().providers.some(p=>p.id==='codex'&&p.capabilities.images===true));
      const [shot,note]=await files(h);
      await h.engine.invoke('room.send',{mode:'discuss',attachments:[shot],memberIds:['codex','claude']});
      await waitFor(()=>h.calls.length===1);
      if(kind==='hold'){
        await h.engine.invoke('room.pause');h.release();await waitFor(()=>!h.engine.store.roomState().active);assert.equal(h.engine.store.roomState().discussion!.phase,'paused');await h.engine.invoke('room.send',{mode:'discuss',attachments:[note],text:'@Gptia 查看这份新文件'});await waitFor(()=>!h.engine.store.roomState().active&&h.calls.length===2);assert.equal(h.engine.store.roomState().discussion!.phase,'waiting_user');
        assert.ok(h.engine.snapshot().room.messages.some(m=>m.author==='user'&&m.attachments?.some(a=>a.id===note.id)));
      }else{
        await waitFor(()=>!h.engine.store.roomState().active);assert.equal(h.engine.store.roomState().discussion!.phase,'blocked');
        await assert.rejects(h.engine.invoke('room.resume'),/结果未知/);assert.ok(h.engine.snapshot().room.messages.every(m=>!m.text.includes('private')));
      }
      assert.equal(h.calls.length,2);
    }finally{await h.dispose();}
  }
});
test('all-stop interrupts the current native call and does not dispatch another free-discussion member',async()=>{
  const h=await fixture('hold');try{
    await h.engine.invoke('room.send',{mode:'discuss',text:'停止测试',memberIds:['claude','codex','dsh']});
    await waitFor(()=>h.calls.length===1);await h.engine.invoke('all.stop',{});await waitFor(()=>!h.engine.store.roomState().active);
    assert.equal(h.calls.length,1);assert.equal(h.engine.store.roomState().discussion!.phase,'paused');
    const run=h.engine.store.get<Run>('runs',h.calls[0].ctx.run.id)!;assert.equal(run.status,'stopped');
  }finally{await h.dispose();}
});
test('unknown native completion stops the actual engine loop without exposing partial structured text',async()=>{
  const h=await fixture('unknown');try{
    await h.engine.invoke('room.send',{mode:'discuss',text:'未知投递测试',memberIds:['claude','codex']});
    await waitFor(()=>!h.engine.store.roomState().active);assert.equal(h.calls.length,2);assert.equal(h.engine.store.roomState().discussion!.phase,'blocked');
    assert.ok(h.engine.store.roomState().discussion!.unknownRunId);await assert.rejects(h.engine.invoke('room.resume',{}),/结果未知/);
    assert.ok(h.engine.snapshot().room.messages.every(m=>!m.text.includes('private')));
  }finally{await h.dispose();}
});

test('ACP members use the same discussion scheduler and compressed topics retain their summary',async()=>{
  const h=await fixture();try{
    h.engine.store.put('executors','acp-fixture',{id:'acp-fixture',name:'外接程序',command:'fixture',args:[],env:{},permissions:{commands:'auto',fileScope:'any',network:true},createdAt:new Date().toISOString()});
    h.engine.store.put('members','guest',{id:'guest',executor:'acp-fixture',name:'新成员'});
    await h.engine.invoke('room.send',{mode:'discuss',text:'一起讨论',memberIds:['guest','codex'],maxCalls:2});
    await waitFor(()=>!h.engine.store.roomState().active);assert.equal(h.engine.store.roomState().discussion!.phase,'waiting_user');
    const custom=h.calls.find(c=>c.ctx.run.provider==='acp-fixture')!;assert.ok(custom);assert.equal(custom.ctx.settings.permissions['acp-fixture'].commands,'deny');assert.equal(custom.ctx.session.writeMode,false);
    const oldSessions=h.calls.map(c=>c.ctx.session.id);
    await h.engine.invoke('room.compress',{memberId:'codex'});assert.equal(h.engine.store.roomState().discussion!.phase,'waiting_user');
    await h.engine.invoke('room.send',{mode:'discuss',text:'查看压缩后的背景继续回答',memberIds:['guest','codex'],maxCalls:12,handRaise:true,hostPick:false});await waitFor(()=>!h.engine.store.roomState().active);
    assert.equal(h.engine.store.roomState().discussion!.phase,'waiting_user');
    assert.ok(h.calls[2].input.background.some((b:any)=>b.text.includes('讨论摘要')));assert.ok(!oldSessions.includes(h.calls[2].ctx.session.id));
    const hand=h.hands.find(c=>c.ctx.run.provider==='acp-fixture')!;assert.ok(hand);assert.equal(hand.ctx.session.writeMode,false);assert.equal(hand.ctx.settings.permissions['acp-fixture'].commands,'deny');assert.ok(hand.input.background.some((b:any)=>b.text.includes('讨论摘要')));
  }finally{await h.dispose();}
});

test('actual hand requests reuse separate read-only sessions and share the ordinary run budget',async()=>{
  const h=await fixture();try{
    await h.engine.invoke('room.send',{mode:'discuss',text:'先举手再讨论',memberIds:['claude','codex','dsh'],handRaise:true,hostPick:false,maxCalls:24,maxMinutes:0});
    await waitFor(()=>!h.engine.store.roomState().active);const d=h.engine.store.roomState().discussion!;
    assert.equal(d.phase,'waiting_user');assert.equal(h.calls.length,6);assert.equal(h.hands.length,6);assert.equal(d.calls,12);assert.equal(d.handCalls,6);
    assert.deepEqual(h.calls.slice(0,4).map(c=>c.input.you),['claude','codex','dsh','dsh'],'hands go up after the round; the most eager speaks');
    const handSessions=new Set(h.hands.map(c=>c.ctx.session.id));assert.equal(handSessions.size,3);assert.ok(h.calls.every(c=>!handSessions.has(c.ctx.session.id)));
    for(const {ctx} of h.hands){assert.equal(ctx.session.writeMode,false);assert.equal(ctx.settings.permissions[ctx.run.provider as 'claude'|'codex'|'dsh'].commands,'deny');}
    assert.ok(h.hands.every(c=>c.ctx.session.nativeId===undefined));
    assert.ok(h.engine.store.list<any>('sessions').filter(s=>s.purpose==='room-hand').every(s=>!s.nativeId),'private ballots never retain native history');
    assert.ok(h.engine.snapshot().room.messages.every(m=>!m.text.includes('"want"')));
    await h.engine.invoke('room.clear');assert.equal(h.engine.store.list('sessions').length,0);
  }finally{await h.dispose();}
});

test('pausing hand collection withdraws queued votes before the current run releases its slot',async()=>{
  const h=await fixture('hold-hands');try{
    h.engine.settings.maxParallel=1;
    await h.engine.invoke('room.send',{mode:'discuss',text:'暂停举手队列',memberIds:['claude','codex','dsh'],handRaise:true,hostPick:false,maxCalls:7});
    await waitFor(()=>h.engine.store.list<Run>('runs').filter(r=>r.status==='queued').length===2&&h.hands.length===1);
    await h.engine.invoke('room.pause');h.release();await waitFor(()=>!h.engine.store.roomState().active);
    assert.equal(h.engine.store.roomState().discussion!.phase,'paused');assert.equal(h.hands.length,1);assert.equal(h.calls.length,3);
    const withdrawn=h.engine.store.list<Run>('runs').filter(r=>r.delivery==='withdrawn');assert.equal(withdrawn.length,2);assert.ok(withdrawn.every(r=>r.status==='stopped'));
  }finally{await h.dispose();}
});

test('all-stop cancels every active hand request and prevents formal speech',async()=>{
  const h=await fixture('hold-hands');try{
    h.engine.settings.maxParallel=3;
    await h.engine.invoke('room.send',{mode:'discuss',text:'停止全部举手',memberIds:['claude','codex','dsh'],handRaise:true,hostPick:false,maxCalls:7});
    await waitFor(()=>h.hands.length===3);await h.engine.invoke('all.stop');await waitFor(()=>!h.engine.store.roomState().active);
    assert.equal(h.engine.store.roomState().discussion!.phase,'paused');assert.equal(h.calls.length,3);
    const hands=h.engine.store.list<Run>('runs').filter(r=>h.engine.store.get<any>('sessions',r.sessionId)?.purpose==='room-hand');assert.equal(hands.length,3);assert.ok(hands.every(r=>r.status==='stopped'));
  }finally{await h.dispose();}
});

test('unknown hand completion isolates that voter while native peers continue until the round ends',async()=>{
  const h=await fixture('unknown-hand');try{
    h.engine.settings.maxParallel=3;
    await h.engine.invoke('room.send',{mode:'discuss',text:'核对未知举手',memberIds:['claude','codex','dsh'],handRaise:true,hostPick:false,maxCalls:12});
    await waitFor(()=>!h.engine.store.roomState().active);const d=h.engine.store.roomState().discussion!;
    assert.equal(d.phase,'waiting_user');assert.equal(d.unknownRunIds!.length,1);assert.equal(h.calls.length,5);assert.equal(h.calls.slice(3).filter(call=>call.input.you==='claude').length,0);
    await assert.rejects(h.engine.invoke('room.resume'),/结果未知/);
    const hands=h.engine.store.list<Run>('runs').filter(r=>h.engine.store.get<any>('sessions',r.sessionId)?.purpose==='room-hand');assert.equal(hands.filter(r=>r.status==='unknown').length,1);assert.ok(hands.some(r=>r.status==='ended'));
  }finally{await h.dispose();}
});

test('human input withdraws queued old votes and keeps the newest mentioned member first',async()=>{
  const h=await fixture('hold-hands');try{
    h.engine.settings.maxParallel=1;
    const options={mode:'discuss',memberIds:['claude','codex','dsh'],handRaise:true,hostPick:false,maxCalls:7,maxMinutes:0};
    await h.engine.invoke('room.send',{...options,text:'原讨论'});await waitFor(()=>h.engine.store.list<Run>('runs').filter(r=>r.status==='queued').length===2&&h.hands.length===1);
    await h.engine.invoke('room.send',{...options,text:'@DS 回答新要求'});h.release();await waitFor(()=>!h.engine.store.roomState().active);
    assert.equal(h.hands.length,1);assert.equal(h.calls.length,4);assert.equal(h.calls[3].input.you,'dsh');assert.ok(h.calls[3].input.messages.some((m:any)=>m.text.includes('新要求')));
    assert.equal(h.engine.store.list<Run>('runs').filter(r=>r.delivery==='withdrawn').length,2);assert.equal(h.engine.store.roomState().discussion!.handRound!.status,'stale');
  }finally{await h.dispose();}
});

test('a format correction waiting for an execution slot is withdrawn after human pause',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM correction-queue-'));
  let engine:Engine,projectSession:string,release!:()=>void,bodyCalls=0,projectCalls=0;
  const gate=new Promise<void>(r=>release=r);
  const factory=(id:ProviderId):Adapter=>({
    probe:async()=>({id,name:id,available:true,auth:'subscription',detail:'fixture',capabilities:{steer:false,cancel:'native',streaming:true,write:false,history:true}}),
    start:async(ctx,prompt)=>{
      ctx.markDelivery('confirmed');
      if(!prompt.includes('\nAIROOM_CONTEXT\n')){projectCalls++;await gate;return {};}
      bodyCalls++;await engine.send(projectSession,'occupy execution slot');ctx.emit('delta','这个回复需要补正');return {};
    },stop:async()=>release(),
  });
  engine=new Engine(directory,()=>{},()=>{},factory);
  try{
    engine.settings.maxParallel=1;
    const project=await engine.invoke('project.create',{directory}) as {id:string};projectSession=engine.createSession(project.id,'codex',undefined,false).id;
    await engine.invoke('room.send',{mode:'discuss',text:'同一轮最多补正一次',memberIds:['claude'],maxCalls:4,maxMinutes:0});
    await waitFor(()=>projectCalls===1&&engine.store.list<Run>('runs').some(r=>r.status==='queued'&&r.sessionId!==projectSession));
    await engine.invoke('room.pause');release();await waitFor(()=>!engine.store.roomState().active);
    assert.equal(bodyCalls,1);assert.equal(engine.store.roomState().discussion!.calls,2);assert.equal(engine.store.roomState().discussion!.phase,'paused');
    assert.ok(engine.store.list<Run>('runs').some(r=>r.sessionId!==projectSession&&r.status==='stopped'&&r.delivery==='withdrawn'));
    assert.equal(engine.store.roomState().discussion!.proposal,undefined);
  }finally{release();await engine.close();await rm(directory,{recursive:true,force:true});}
});

test('a chat may wind down only after a good stretch of talk, and only when everyone agrees',async()=>{
  const h=await fixture();try{
    await h.engine.invoke('room.send',{mode:'discuss',style:'chat',text:'你们觉得自己有自我意识吗',memberIds:['claude','codex','dsh'],maxCalls:0,maxMinutes:0});
    await waitFor(()=>!h.engine.store.roomState().active);
    const d=h.engine.store.roomState().discussion!;
    assert.equal(d.style,'chat');assert.equal(d.limit,0);assert.equal(d.deadline,0);
    // The fixture proposes from its fourth call on. With three members a chat needs six remarks first,
    // so calls 4–6 stay ordinary remarks, call 7 proposes, and the other two agree.
    assert.deepEqual(h.calls.map(c=>c.input.canPropose),[false,false,false,false,false,false,true,false,false]);
    assert.deepEqual(h.calls.map(c=>c.input.phase),['talking','talking','talking','talking','talking','talking','talking','closing','closing']);
    assert.equal(d.phase,'idle');assert.equal(d.endedBy,'members');assert.match(d.reason??'',/都同意先聊到这儿/);
    assert.equal(h.engine.snapshot().room.messages.filter(m=>m.author!=='user'&&m.status==='done').length,7);
  }finally{await h.dispose();}
});
test('switching between 闲聊 and 开会 starts a new discussion instead of continuing a paused one',async()=>{
  const h=await fixture('hold');try{
    await h.engine.invoke('room.send',{mode:'discuss',style:'chat',text:'随便聊聊',memberIds:['claude','codex'],maxCalls:0});
    await waitFor(()=>h.calls.length===1);const first=h.engine.store.roomState().discussion!.id;
    await h.engine.invoke('room.pause',{});h.release();await waitFor(()=>!h.engine.store.roomState().active);
    await h.engine.invoke('room.send',{mode:'discuss',style:'work',text:'开会：定一下周末计划',memberIds:['claude','codex'],maxCalls:24});
    const d=h.engine.store.roomState().discussion!;assert.notEqual(d.id,first);assert.equal(d.style,'work');
  }finally{await h.dispose();}
});
test('a chat ends on its own once every member has nothing to add',async()=>{
  const h=await fixture('winds-down');try{
    await h.engine.invoke('room.send',{mode:'discuss',style:'chat',text:'随便聊聊',memberIds:['claude','codex','dsh'],maxCalls:24});
    await waitFor(()=>!h.engine.store.roomState().active);
    const d=h.engine.store.roomState().discussion!;
    assert.equal(d.phase,'idle');assert.equal(d.endedBy,'members');assert.match(d.reason??'',/接着聊/);
    assert.equal(h.calls.length,5);assert.deepEqual([...d.passed!].sort(),['claude','codex','dsh']);
  }finally{await h.dispose();}
});
test('chat and work discussions brief members differently',async()=>{
  for(const style of ['chat','work',undefined]){
    const h=await fixture('hold');try{
      await h.engine.invoke('room.send',{mode:'discuss',...(style?{style}:{}),text:'聊聊',memberIds:['claude'],maxCalls:24});
      await waitFor(()=>h.calls.length===1);
      const prompt=h.calls[0].ctx.run.input;
      if(style==='chat'){assert.match(prompt,/这是聊天，不是任务/);assert.match(prompt,/canPropose=false 时不要 propose/);assert.match(prompt,/不要频繁提议/);assert.doesNotMatch(prompt,/propose 表示目标已处理/);assert.equal(h.calls[0].input.canPropose,false);}
      else{assert.match(prompt,/每位成员只回答一次/);assert.doesNotMatch(prompt,/这是聊天/);assert.equal(h.engine.store.roomState().discussion!.style,'work');}
    }finally{await h.dispose();}
  }
});

test('in 闲聊 a member may answer with just an emoji, shown on the user\'s message; 开会 asks for words',async()=>{
  const h=await fixture('reacts');try{
    await h.engine.invoke('room.send',{mode:'discuss',style:'chat',text:'今天天气真好',memberIds:['claude','codex','dsh'],maxCalls:0});
    await waitFor(()=>!h.engine.store.roomState().active);
    const d=h.engine.store.roomState().discussion!,messages=h.engine.snapshot().room.messages,asked=messages.find(m=>m.author==='user')!;
    assert.equal(h.calls.length,4);assert.equal(d.phase,'idle');
    assert.deepEqual([...asked.reactions!['👍']].sort(),['claude','codex','dsh']);
    const answers=messages.filter(m=>m.reaction);assert.equal(answers.length,3);assert.ok(answers.every(m=>m.status==='passed'&&!m.text&&m.inReplyTo===asked.id));
    assert.match(h.calls[0].ctx.run.input,/react 表示只想用一个表情回应/);
  }finally{await h.dispose();}
  const w=await fixture('reacts');try{
    await w.engine.invoke('room.send',{mode:'discuss',style:'work',text:'开会',memberIds:['claude','codex'],maxCalls:0});
    await waitFor(()=>w.calls.length>=3);await w.engine.invoke('room.pause',{});await waitFor(()=>!w.engine.store.roomState().active);
    const asked=w.engine.snapshot().room.messages.find(m=>m.author==='user')!;
    assert.equal(asked.reactions,undefined);assert.ok(!w.engine.snapshot().room.messages.some(m=>m.reaction));
    assert.doesNotMatch(w.calls[0].ctx.run.input,/react 表示/);
  }finally{await w.dispose();}
});

test('in 闲聊 an emoji alongside a remark stays occasional, and agreeing to wind down shows as a thumbs-up',async()=>{
  const h=await fixture('emoji');try{
    await h.engine.invoke('room.send',{mode:'discuss',style:'chat',text:'聊聊周末',memberIds:['claude','codex','dsh'],maxCalls:0});
    await waitFor(()=>!h.engine.store.roomState().active);
    const d=h.engine.store.roomState().discussion!,messages=h.engine.snapshot().room.messages,asked=messages.find(m=>m.author==='user')!;
    assert.equal(d.phase,'idle');
    // Every one of the first three remarks asked for 😄; only the first is kept so close together.
    assert.deepEqual(asked.reactions,{'😄':[h.calls[0].input.you]});
    const proposal=messages.find(m=>m.id===d.proposal!.id)!;assert.deepEqual([...proposal.reactions!['👍']].sort(),['claude','codex','dsh'].filter(id=>id!==d.proposal!.proposer));
    assert.ok(messages.filter(m=>m.author!=='user'&&m.status==='done').every(m=>!m.reaction),'remarks keep their text and are not hidden');
  }finally{await h.dispose();}
});
