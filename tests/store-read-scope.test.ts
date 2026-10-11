import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {Store} from '../src/backend/store';
import type {TimelineEvent} from '../src/shared/types';
test('projection read scopes see writes, deletes, thread clears and rollbacks immediately',async()=>{
  const root=path.resolve('.test-cache/store-read-scope');await mkdir(root,{recursive:true});const directory=await mkdtemp(path.join(root,'run-')),store=new Store(directory);
  try{const thread=store.currentRoomThread();store.readScope(()=>{
    assert.deepEqual(store.list('fixture'),[]);store.put('fixture','a',{id:'a'});assert.equal(store.list('fixture').length,1);store.delete('fixture','a');assert.equal(store.list('fixture').length,0);
    store.put('room_messages','m',{id:'m',threadId:thread.id,roomId:'global',author:'user',text:'fixture',at:new Date().toISOString()});
    assert.equal(store.roomThreads()[0].count,1);assert.equal(store.allRoomMessages(thread.id).length,1);store.clearRoomThread(thread.id);assert.equal(store.roomThreads()[0].count,0);assert.equal(store.allRoomMessages(thread.id).length,0);
    assert.throws(()=>store.transaction(()=>{store.put('fixture','b',{id:'b'});assert.equal(store.list('fixture').length,1);throw new Error('rollback');}),/rollback/);assert.equal(store.list('fixture').length,0);
    store.put('history','a',{id:'a',status:'ended'});store.put('history','b',{id:'b',status:'ended'});assert.equal(store.list('history').length,2);store.pruneHistory('history',1);assert.equal(store.list('history').length,1);
  });store.put('fixture','c',{id:'c'});assert.equal(store.readScope(()=>store.list('fixture').length),1);}
  finally{store.close();assert.equal(path.dirname(directory),root);await rm(directory,{recursive:true,force:true});}
});

test('scoped entity reads keep independent objects and invalidate missing values, writes and rollback',async()=>{
  const root=path.resolve('.test-cache/store-read-scope');await mkdir(root,{recursive:true});const directory=await mkdtemp(path.join(root,'run-')),store=new Store(directory);
  try{store.readScope(()=>{
    assert.equal(store.get('fixture','a'),undefined);
    store.put('fixture','a',{value:{count:1}});
    const first=store.get<{value:{count:number}}>('fixture','a')!;first.value.count=99;
    assert.equal(store.get<typeof first>('fixture','a')!.value.count,1);
    assert.throws(()=>store.transaction(()=>{store.put('fixture','a',{value:{count:2}});assert.equal(store.get<typeof first>('fixture','a')!.value.count,2);throw Error('rollback');}),/rollback/);
    assert.equal(store.get<typeof first>('fixture','a')!.value.count,1);
    store.delete('fixture','a');assert.equal(store.get('fixture','a'),undefined);
  });}finally{store.close();assert.equal(path.dirname(directory),root);await rm(directory,{recursive:true,force:true});}
});

test('run event reads preserve original and correction ordering without unrelated history or duplicate events',async()=>{
  const root=path.resolve('.test-cache/store-read-scope');await mkdir(root,{recursive:true});const directory=await mkdtemp(path.join(root,'run-')),store=new Store(directory);
  try{
    const events=[['old','unrelated'],['start','original'],['foreign','another-project'],['repair','correction'],['end','original']];
    for(const [id,runId] of events)store.appendEvent({id,runId,sessionId:'session',provider:'codex',at:'2026-10-10T00:00:00.000Z',kind:'message',text:id,fidelity:'native'} as TimelineEvent);
    assert.deepEqual(store.eventsForRuns(['correction','original','original',undefined]).map(e=>e.id),['start','repair','end']);
    assert.deepEqual(store.runEvents('original').map(e=>e.id),['start','end']);
    assert.deepEqual(store.eventsForRuns([]),[]);
    store.readScope(()=>{assert.equal(store.runEvents('correction').length,1);store.appendEvent({id:'late',runId:'correction',sessionId:'session',provider:'codex',at:'2026-10-10T00:00:01.000Z',kind:'message',text:'late',fidelity:'native'});assert.equal(store.runEvents('correction').length,2);store.deleteSessionEvents('session');assert.deepEqual(store.runEvents('original'),[]);});
  }finally{store.close();assert.equal(path.dirname(directory),root);await rm(directory,{recursive:true,force:true});}
});
