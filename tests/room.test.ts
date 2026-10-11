import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/backend/store';
import { DEFAULT_ROOM_THREAD, isRoomPass, roomMarkdown, roomMentions } from '../src/shared/room';
import type { RoomMessage, RoomThread, Run } from '../src/shared/types';

const members = [{id:'ds',name:'DS'},{id:'long',name:'审稿人'},{id:'short',name:'审稿'},{id:'space',name:'Code Reviewer'},{id:'g',name:'Gptia'}];
test('DS aliases target the built-in member, preserve ambiguity and do not match longer unknown names',()=>{
  const team=[{id:'dsh',name:'鲸鱼娘'},{id:'codex',name:'Gptia'}];
  assert.deepEqual(roomMentions('＠ds @DSH @鲸鱼娘 @Gptia',team),{ids:['dsh','codex'],unknown:[],ambiguous:[]});
  assert.deepEqual(roomMentions('@DSHelper @DS_2',team).unknown,['DSHelper','DS_2']);
  assert.deepEqual(roomMentions('@DS',[...team,{id:'other',name:'DS'}]).ambiguous,['DS']);
  assert.deepEqual(roomMentions('@DS',[{id:'custom',name:'Deepseek'}]).unknown,['DS']);
});
test('mentions use longest names, Unicode @, case-insensitive matching, distinct mention order and ignore email addresses',()=>{
  assert.deepEqual(roomMentions('＠审稿人 @Code Reviewer，@gPTIA @DS @ds；联系 user@example.com',members),{ids:['long','space','g','ds'],unknown:[],ambiguous:[]});
  assert.deepEqual(roomMentions('@DSH 和 @不存在',members),{ids:[],unknown:['DSH','不存在'],ambiguous:[]});
  assert.deepEqual(roomMentions('@DS＠Gptia',members).ids,['ds','g']);
  assert.deepEqual(roomMentions('Please@Gptia，hey＠DS',members).ids,['g','ds']);
  assert.deepEqual(roomMentions('user@ds.example.com',members).ids,[]);
  assert.deepEqual(roomMentions('请 @',members).unknown,['（未填写名字）']);
  assert.deepEqual(roomMentions('@ds',[...members,{id:'dup',name:'ds'}]).ambiguous,['DS']);
  assert.equal(isRoomPass(' \n[PASS]\t '),true);
  assert.equal(isRoomPass('[PASS] 还有一点要说'),false);
  assert.equal(isRoomPass(''),false);
});

test('legacy room messages migrate once and paginate without gaps when timestamps tie or new messages arrive',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM room-history-'));let store=new Store(root);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  store.delete('room_threads',DEFAULT_ROOM_THREAD);store.delete('room','current');store.delete('room_cursors','global');store.delete('room_states','global');store.delete('room_migrations','rooms-v1');
  const at='2026-10-04T02:00:00.000Z';
  for(let i=0;i<333;i++)store.put('room_messages','old-'+i,{id:'old-'+i,at,author:'user',text:'旧记录 '+i,status:'done'});
  store.close();store=new Store(root);
  assert.equal(store.currentRoomThread().id,DEFAULT_ROOM_THREAD);
  assert.ok(store.list<RoomMessage>('room_messages').every(message=>message.threadId===DEFAULT_ROOM_THREAD));
  const initial=store.roomHistory(DEFAULT_ROOM_THREAD,undefined,57);
  store.put('room_messages','new',{id:'new',threadId:DEFAULT_ROOM_THREAD,at,author:'user',text:'新到的消息'});
  let page=initial;const groups=[page.messages];
  while(page.hasMore){page=store.roomHistory(DEFAULT_ROOM_THREAD,page.before,57);groups.unshift(page.messages);}
  assert.deepEqual(groups.flat().map(message=>message.id),Array.from({length:333},(_,i)=>'old-'+i));
  assert.equal(store.snapshot().room.messages.length,100);
  assert.equal(store.roomMessages(1)[0].id,'new');
  const next=store.archiveRoom();
  assert.equal(store.roomHistory(next.id).messages.length,0);
  assert.equal(store.allRoomMessages(DEFAULT_ROOM_THREAD).length,334);
  assert.throws(()=>store.roomHistory(next.id,initial.before),/分页位置/);
  store.close();store=new Store(root);
  assert.equal(store.currentRoomThread().id,next.id);
  assert.equal(store.roomThreads().length,2);
  assert.equal(store.allRoomMessages(DEFAULT_ROOM_THREAD).length,334,'a second migration does not duplicate records');
});

test('room exports retain speaker identities, timestamps, summary labels and readable silence status',()=>{
  const thread:RoomThread={id:'t',title:'议题',createdAt:'2026-10-04T02:00:00Z',archivedAt:'2026-10-04T03:00:00Z'};
  const messages:RoomMessage[]=[
    {id:'1',author:'retired',authorName:'原来的成员名',text:'结论正文',at:thread.createdAt,kind:'summary',status:'done'},
    {id:'2',author:'ds',text:'',at:thread.archivedAt!,status:'passed'},
  ];
  const exported=roomMarkdown(thread,messages,()=> 'DS');
  assert.match(exported,/原来的成员名 · 会议总结/);assert.match(exported,/DS · 未发言/);
  assert.match(exported,/归档时间/);assert.match(exported,/2026/);assert.match(exported,/结论正文/);assert.doesNotMatch(exported,/\[PASS\]/);
});

test('room exports name attachments and generated images so the Markdown can be traced back to the files',()=>{
  const thread:RoomThread={id:'t',title:'图片',createdAt:'2026-10-04T02:00:00Z'};
  const at=thread.createdAt;
  const messages:RoomMessage[]=[
    {id:'1',author:'user',text:'看这张图',at,attachments:[{id:'a1',name:'草图.png',kind:'image',mime:'image/png',size:10}]},
    {id:'2',author:'codex',text:'已生成',at,status:'done',generatedImages:[{id:'g1',name:'AIROOM-图片.png',kind:'image',mime:'image/png',size:20,nativeItemId:'n',nativeTurnId:'t',generatedAt:at}]},
  ];
  const exported=roomMarkdown(thread,messages,id=>id);
  assert.ok(exported.includes('> 附件：草图.png（资料目录 attachments/a1/）'));
  assert.ok(exported.includes('> 生成的图片：AIROOM-图片.png（资料目录 attachments/g1/）'));
});

test('recovery folds a completed optional PASS but reports a required PASS without automatically retrying',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM room-recovery-')),store=new Store(root);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const at='2026-10-04T02:00:00Z';
  for(const allowPass of [true,false]){
    const id=allowPass?'optional':'required';
    const run:Run={id,sessionId:id,projectId:'lounge',provider:'codex',revision:1,status:'ended',input:'fixture',createdAt:at,updatedAt:at,completedAt:at,bootId:'old',delivery:'confirmed'};
    store.put('runs',id,run);store.appendEvent({id:'event-'+id,runId:id,sessionId:id,provider:'codex',at,kind:'delta',text:'[PASS]',fidelity:'native'});
    store.put('room_messages',id,{id,threadId:DEFAULT_ROOM_THREAD,author:'codex',text:'',at,status:'speaking',runId:id,allowPass} satisfies RoomMessage);
  }
  store.recover('new');
  assert.equal(store.get<RoomMessage>('room_messages','optional')!.status,'passed');
  assert.equal(store.get<RoomMessage>('room_messages','required')!.status,'failed');
  assert.match(store.get<RoomMessage>('room_messages','required')!.error!,/未自动重试/);
  assert.ok(store.roomMessages().every(message=>message.text===''));
});

test('archive deletion rolls back on a storage failure and leaves the current topic intact',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM room-delete-')),store=new Store(root);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  store.put('room_messages','old',{id:'old',threadId:DEFAULT_ROOM_THREAD,author:'user',text:'保留旧记录',at:'2026-10-04T02:00:00Z'});
  const next=store.archiveRoom();
  store.put('room_messages','current',{id:'current',threadId:next.id,author:'user',text:'当前内容',at:'2026-10-04T02:00:00Z'});
  const original=store.delete.bind(store);
  store.delete=(entity,id)=>{if(entity==='room_threads')throw new Error('fixture storage failure');original(entity,id);};
  assert.throws(()=>store.removeArchivedRoomThread(DEFAULT_ROOM_THREAD),/storage failure/);
  assert.equal(store.allRoomMessages(DEFAULT_ROOM_THREAD).length,1);assert.ok(store.get('room_threads',DEFAULT_ROOM_THREAD));
  store.delete=original;store.removeArchivedRoomThread(DEFAULT_ROOM_THREAD);
  assert.equal(store.get('room_threads',DEFAULT_ROOM_THREAD),undefined);assert.equal(store.roomMessages()[0].id,'current');
});
