import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Adapter } from '../src/shared/types';
import { RoomRuntimePool } from '../src/backend/runtime-pool';
import { PreflightCache } from '../src/backend/adapters/preflight-cache';

const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function mock(){
  let open=true,closed=0;
  return {start:async()=>({}),probe:async()=>({} as any),stop:async()=>{},canReuse:()=>open,dispose:async()=>{open=false;closed++;},get closed(){return closed;}} satisfies Adapter & {closed:number};
}
test('pool reuses serial room leases, retires changed configurations and refuses overlapping turns',async()=>{
  const pool=new RoomRuntimePool(),first=mock(),second=mock();
  try{
    const one=await pool.acquire('member','settings-1',()=>first);
    await assert.rejects(pool.acquire('member','settings-1',()=>mock()),/活动请求/);
    await one.release(true);
    const two=await pool.acquire('member','settings-1',()=>mock());assert.equal(two.adapter,first);assert.ok(two.reused);await two.release(true);
    const changed=await pool.acquire('member','settings-2',()=>second);assert.equal(first.closed,1);assert.equal(changed.adapter,second);assert.equal(changed.reused,false);
    await changed.release(true);await pool.closeAll();assert.equal(second.closed,1);assert.equal(pool.size,0);
  }finally{await pool.closeAll();}
});
test('pool bounds idle processes, expires them and recycles unknown deliveries',async()=>{
  const pool=new RoomRuntimePool({limit:1,idleMs:30}),first=mock(),second=mock();
  try{
    const one=await pool.acquire('one','a',()=>first);await one.release(true);
    const two=await pool.acquire('two','a',()=>second);assert.equal(first.closed,1);assert.equal(pool.size,1);await two.release(true);
    for(let i=0;i<20&&pool.size;i++)await delay(10);
    assert.equal(pool.size,0);assert.equal(second.closed,1);
    const uncertain=mock(),three=await pool.acquire('three','a',()=>uncertain);await three.release(false);assert.equal(uncertain.closed,1);assert.equal(pool.size,0);
  }finally{await pool.closeAll();}
});
test('invalidated active leases cannot become warm again, and all-stop cancels an acquisition awaiting cleanup',async()=>{
  const pool=new RoomRuntimePool(),first=mock();const one=await pool.acquire('member','a',()=>first);
  await pool.invalidate();assert.equal(first.closed,0);let conditions:Record<string,boolean>|undefined;
  await one.release(true,value=>{conditions=value;});assert.equal(first.closed,1);
  assert.deepEqual(conditions,{cached:true,requested:true,invalidated:true,current:true,adapterReusable:true,retained:false});
  let release!:()=>void;
  const slow=mock();slow.dispose=async()=>{await new Promise<void>(resolve=>{release=resolve;});};
  const two=await pool.acquire('member','a',()=>slow);await two.release(true);
  const waiting=pool.acquire('member','b',()=>mock());void waiting.catch(()=>{});
  await delay(1);await pool.closeAll();release();await assert.rejects(waiting,/已回收/);assert.equal(pool.size,0);
});
test('preflight checks cache positive results, refresh explicitly and expire without retaining failures',async()=>{
  let reads=0;const cache=new PreflightCache<number>(20,value=>value>0),read=async()=>++reads;
  assert.equal(await cache.get('a',read),1);assert.equal(await cache.get('a',read),1);
  assert.equal(await cache.get('a',read,true),2);
  await delay(25);assert.equal(await cache.get('a',read),3);
  await assert.rejects(cache.get('bad',async()=>{throw new Error('offline');}),/offline/);
  assert.equal(await cache.get('bad',read),4);
  await cache.get('negative',async()=>0);assert.equal(await cache.get('negative',read),5);
  await cache.get('fresh-failure',async()=>1);
  await assert.rejects(cache.get('fresh-failure',async()=>{throw new Error('logged out');},true),/logged out/);
  assert.equal(await cache.get('fresh-failure',async()=>2),2);
});
test('login invalidation rejects cache fill from an older in-flight check',async()=>{
  const cache=new PreflightCache<number>();let finish!:(value:number)=>void;
  const old=cache.get('login',()=>new Promise<number>(resolve=>{finish=resolve;}));cache.clear();
  assert.equal(await cache.get('login',async()=>2),2);finish(1);assert.equal(await old,1);
  assert.equal(await cache.get('login',async()=>3),2);
});
