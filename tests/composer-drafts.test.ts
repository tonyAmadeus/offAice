import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeFileSync,statSync,utimesSync} from 'node:fs';
import {Store} from './helpers/seeded-engine';
import {ComposerDrafts} from '../src/backend/composer-drafts';
import {EngineAttachments} from '../src/backend/engine-attachments';
import {LegacyCollaborations} from '../src/backend/engine-collaborations';
import {Engine} from './helpers/seeded-engine';
import {attachmentPath,importAttachments} from '../src/backend/attachments';
import {composerDraftId,emptyComposerDraft,remainingComposerDraft} from '../src/shared/composer-draft';
import {callUsage,callUsageLabel} from '../src/shared/call-usage';
import {firstMessageTitle} from '../src/shared/room';
import type {Adapter,ProviderId,Run} from '../src/shared/types';
import type {PersonalRoomData} from '../src/shared/member-workspaces';

const directory=()=>path.join(process.env.AIROOM_TEST_PROFILE!,'draft-'+randomUUID());

test('confirmed submissions remove only their prefix, attachments and unchanged reply or intent',()=>{
  const attachment={id:'sent-file',name:'sent.txt'} as any,newAttachment={id:'new-file',name:'new.txt'} as any;
  const sent={text:'发出的正文',attachments:[attachment],replyTo:'sent-reply',workIntent:'add' as const};
  assert.deepEqual(remainingComposerDraft({...sent,text:sent.text+'补充'},sent),{text:'补充',attachments:[],replyTo:undefined,workIntent:undefined});
  assert.deepEqual(remainingComposerDraft({text:'替换后的新正文',attachments:[attachment,newAttachment],replyTo:'new-reply',workIntent:'supplement'},sent),{text:'替换后的新正文',attachments:[newAttachment],replyTo:'new-reply',workIntent:'supplement'});
  assert.equal(remainingComposerDraft({...sent,text:'  发出的正文  补充'},{...sent,text:'  发出的正文  '}).text,'补充');
  assert.equal(remainingComposerDraft({...sent,text:'发出的正文补充'},{...sent,text:'  发出的正文  '}).text,'补充');
  assert.equal(remainingComposerDraft({...sent,text:'刚写的新正文'},{...sent,text:''}).text,'刚写的新正文');
});

test('automatic titles strip only leading member mentions before truncating',()=>{
  const members=[{id:'claude',name:'Claudia'},{id:'codex',name:'Gptia'},{id:'dsh',name:'鲸鱼娘'},{id:'custom',name:'小 蓝'}];
  assert.equal(firstMessageTitle('  @claudia，＠Gptia：整理下周安排',members),'整理下周安排');
  assert.equal(firstMessageTitle('@DSH @DS 讨论这个问题',members),'讨论这个问题');
  assert.equal(firstMessageTitle('@小 蓝 看材料',members),'看材料');
  assert.equal(firstMessageTitle('@Claudia',members),'');
  assert.equal(firstMessageTitle('稍后请 @Claudia 看材料',members),'稍后请 @Claudia 看材料');
  assert.equal(firstMessageTitle('Claudia@example.com',members),'Claudia@example.com');
  assert.equal(firstMessageTitle('@ClaudiaExtra 看材料',members),'@ClaudiaExtra 看材料');
  assert.equal(firstMessageTitle('@未知成员 看材料',members),'@未知成员 看材料');
  assert.equal([...firstMessageTitle('@Claudia '+ '😀'.repeat(30),members)].length,20);
});

test('populated legacy default topics persist their auto-title opt-out after the first check',()=>{
  const data=directory();let store=new Store(data);
  try{
    const thread=store.currentRoomThread();
    store.put('room_threads',thread.id,{...thread,autoTitle:false});
    store.put('room_messages','legacy-user',{id:'legacy-user',author:'user',text:'旧正文',threadId:thread.id,at:new Date().toISOString()});
    store.put('room_threads',thread.id,{...thread,autoTitle:undefined});
    store.nameRoomThread(thread.id,'新的消息');
    assert.equal(store.currentRoomThread().title,'当前话题');assert.equal(store.currentRoomThread().autoTitle,false);
    store.close();store=new Store(data);
    assert.equal(store.currentRoomThread().autoTitle,false);
    store.nameRoomThread(thread.id,'又一条新消息');assert.equal(store.currentRoomThread().title,'当前话题');
  }finally{store.close();}
});

test('drafts restore across a store restart, keep old attachments alive and never create runs',()=>{
  const data=directory();let store=new Store(data);
  const scope={roomId:'global' as const,threadId:store.currentRoomThread().id};
  const source=path.join(data,'notes.txt');writeFileSync(source,'材料');
  const attachment=importAttachments(data,[source])[0],old=new Date(Date.now()-48*3600000);
  utimesSync(path.dirname(attachmentPath(data,attachment)),old,old);
  try{
    new ComposerDrafts(store).save({...scope,value:{text:'尚未发出的要求',attachments:[attachment],workIntent:'supplement'}});
    new EngineAttachments(store,()=>true).release();assert.ok(statSync(attachmentPath(data,attachment)).isFile());
    assert.equal(store.list('runs').length,0);assert.equal(store.liveEvents().length,0);
    store.close();store=new Store(data);
    assert.equal(new ComposerDrafts(store).get(scope)?.text,'尚未发出的要求');
    assert.equal(new ComposerDrafts(store).get(scope)?.workIntent,'supplement');
    new EngineAttachments(store,()=>true).release();assert.ok(statSync(attachmentPath(data,attachment)).isFile());
    new ComposerDrafts(store).save({...scope,value:emptyComposerDraft()});
    new EngineAttachments(store,()=>true).release([attachment.id]);
    assert.throws(()=>statSync(attachmentPath(data,attachment)),{code:'ENOENT'});
  }finally{store.close();}
});

test('drafts belong to their exact room and topic; clear and delete remove only the matching draft',()=>{
  const store=new Store(directory()),drafts=new ComposerDrafts(store),first={roomId:'global' as const,threadId:store.currentRoomThread().id};
  try{
    drafts.save({...first,value:{text:'甲话题',attachments:[]}});
    const second={roomId:'global' as const,threadId:store.archiveRoom().id};
    drafts.save({...second,value:{text:'乙话题',attachments:[]}});
    store.put('projects','p',{id:'p',name:'项目',directory:store.dataDirectory,createdAt:new Date().toISOString(),collaborationPaused:false});
    store.ensureProjectRoom('p');
    assert.throws(()=>drafts.get({...first,roomId:'project:p'}),/不属于/);
    assert.equal(drafts.get(first)?.text,'甲话题');assert.equal(drafts.get(second)?.text,'乙话题');
    store.clearRoomThread(first.threadId);assert.equal(drafts.get(first),null);assert.equal(drafts.get(second)?.text,'乙话题');
    store.delete('room_threads',first.threadId);
    assert.throws(()=>drafts.save({...first,value:{text:'过期保存',attachments:[]}}),/不属于/);
    assert.equal(store.get('composer_drafts',composerDraftId(first)),undefined);
  }finally{store.close();}
});

test('invalid draft attachments cannot replace a good draft or point outside the attachment store',()=>{
  const store=new Store(directory()),drafts=new ComposerDrafts(store),scope={roomId:'global' as const,threadId:store.currentRoomThread().id};
  try{
    drafts.save({...scope,value:{text:'保留这份',attachments:[]}});
    assert.throws(()=>drafts.save({...scope,value:{text:'坏附件',attachments:[{id:'../outside',name:'x.txt'} as any]}}),/附件无效/);
    assert.equal(drafts.get(scope)?.text,'保留这份');
  }finally{store.close();}
});

test('restored data rejects a delayed draft write from the previous database generation',()=>{
  const store=new Store(directory()),drafts=new ComposerDrafts(store),scope={roomId:'global' as const,threadId:store.currentRoomThread().id};
  try{
    drafts.save({...scope,value:{text:'备份中的草稿',attachments:[]}});
    store.put('restore_info','main',{at:'restored-generation'});
    assert.throws(()=>drafts.save({...scope,value:{text:'恢复前迟到的保存',attachments:[]}}),/已恢复/);
    assert.equal(drafts.get({...scope,restoreEpoch:'restored-generation'})?.text,'备份中的草稿');
    assert.equal(store.snapshot().restoreEpoch,'restored-generation');
  }finally{store.close();}
});

test('tea topics use the first real user message and preserve manual names, including the default text',()=>{
  const store=new Store(directory()),at=new Date().toISOString();
  const put=(text:string,extra:Record<string,unknown>={})=>store.put('room_messages',randomUUID(),{id:randomUUID(),author:'user',text,threadId:store.currentRoomThread().id,at,...extra});
  try{
    put('仅作上下文',{contextOnly:true});assert.equal(store.currentRoomThread().title,'当前话题');
    put('@Claudia 整理\n 下周工作安排与交付清单，包括所有验收内容。');
    assert.equal(store.currentRoomThread().title,'整理 下周工作安排与交付清单，包括所有验');
    const title=store.currentRoomThread().title;put('后来的消息不覆盖');assert.equal(store.currentRoomThread().title,title);
    const next=store.archiveRoom();store.put('room_threads',next.id,{...next,title:'当前话题',autoTitle:false});
    put('这条也不能覆盖用户命名');assert.equal(store.currentRoomThread().title,'当前话题');
    assert.equal([...firstMessageTitle('😀'.repeat(30))].length,20);
  }finally{store.close();}
});

test('desk titles use the user text rather than inherited prompt material and never overwrite an explicit name',async()=>{
  let calls=0;
  const factory=(id:ProviderId):Adapter=>({probe:async()=>({id,name:id,available:true,auth:'subscription',detail:'isolated fake',capabilities:{streaming:true,history:true,write:true,cancel:'native',steer:false}}),stop:async()=>{},start:async(ctx)=>{calls++;ctx.markDelivery('confirmed');ctx.emit('delta','隔离回复');return {};}});
  const engine=new Engine(directory(),()=>{},()=>{},factory);
  try{
    await engine.probe();await engine.invoke('desk.open',{memberId:'claude'});await engine.invoke('desk.topic',{memberId:'claude'});
    let room=await engine.invoke('desk.open',{memberId:'claude'}) as PersonalRoomData;
    const first=engine.store.roomThread(room.currentThreadId!,room.roomId!);
    engine.store.put('room_threads',first.id,{...first,summary:{text:'不能用这一段背景命名',by:'claude',at:first.createdAt,count:0}});
    await engine.invoke('desk.topic',{memberId:'claude',inherit:true});room=await engine.invoke('desk.open',{memberId:'claude'}) as PersonalRoomData;
    await engine.invoke('room.send',{roomId:room.roomId,text:'@Claudia 真正的新问题',memberIds:['claude']});
    assert.equal(engine.store.roomThread(room.currentThreadId!,room.roomId!).title,'真正的新问题');
    assert.equal(engine.store.get<any>('sessions',room.sessionId!).title,'真正的新问题');
    await engine.stopAll();await engine.invoke('desk.topic',{memberId:'claude'});room=await engine.invoke('desk.open',{memberId:'claude'}) as PersonalRoomData;
    await engine.invoke('session.update',{sessionId:room.sessionId,title:'当前话题'});
    await engine.invoke('room.send',{roomId:room.roomId,text:'不能覆盖手动标题',memberIds:['claude']});
    assert.equal(engine.store.roomThread(room.currentThreadId!,room.roomId!).title,'当前话题');
  }finally{await engine.close();}
  assert.ok(calls>0);
});

test('legacy execution is unavailable while pause bookkeeping and stored history remain readable',()=>{
  const store=new Store(directory());let changed=0;const legacy=new LegacyCollaborations(store,()=>changed++);
  try{
    store.put('projects','p',{id:'p',collaborationPaused:false});
    store.put('collaborations','c',{id:'c',projectId:'p',mode:'council',status:'running',stage:'旧阶段',sessionIds:['saved-session']});
    store.put('workflows','c',{phase:2,results:['已保存正文'],runIds:['saved-run']});
    assert.throws(()=>legacy.resume('c'),/旧协作记录只供阅读/);
    legacy.pause('c');legacy.pause('c');
    assert.equal(store.get<any>('collaborations','c').stage,'已暂停新交接 · 旧阶段');
    assert.deepEqual(store.get<any>('workflows','c').results,['已保存正文']);
    assert.equal(store.list('runs').length,0);assert.equal(changed,2);
  }finally{store.close();}
});

test('call labels distinguish delivery from attempts and scope the estimate to preparation',()=>{
  const runs=[{id:'a',status:'failed',delivery:'prepared'},{id:'b',status:'ended',delivery:'confirmed'},{id:'c',status:'unknown',delivery:'unknown'},{id:'d',status:'stopped',delivery:'withdrawn'}] as Run[];
  const label=callUsageLabel(callUsage(runs),3,'准备阶段基础预计');
  assert.match(label,/累计尝试 4 次 · 已发出 1 次 · 已完成 1 次 · 准备阶段基础预计 3 次/);
  assert.match(label,/未发出失败 1 次.*未发出已撤回 1 次.*结果未知 1 次/);
});
