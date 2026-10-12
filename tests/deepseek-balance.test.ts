import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Engine } from './helpers/seeded-engine';
import { DshAdapter } from '../src/backend/adapters/dsh';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';
import { quotaPreference } from '../src/shared/quota';
import type { AccountBalance, Adapter, ProviderInfo } from '../src/shared/types';

const ready=(amount='20.120000000000000000'):AccountBalance=>({status:'ready',wallets:[{currency:'CNY',balance:amount}],bonusWallets:[{currency:'CNY',balance:'0E-16'}],checkedAt:new Date().toISOString()});
const provider:ProviderInfo={id:'dsh',name:'DeepSeek Harness',available:true,auth:'account',detail:'fixture',capabilities:{steer:false,cancel:'native',streaming:false,write:true,history:false}};
const wait=async(check:()=>boolean)=>{for(let i=0;i<300;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('balance fixture did not settle');};
async function fixture(balance:()=>Promise<AccountBalance>){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM-balance-'));let speech=0,stops=0,disposed=0,probes=0,reusable=false,at=Date.parse('2026-10-04T01:00:00Z');
  const adapter:Adapter={probe:async()=>{probes++;return provider;},accountBalance:balance,runtimeFingerprint:async()=> 'fixture-stamp',canReuse:()=>reusable,
    start:async ctx=>{speech++;reusable=true;ctx.markDelivery('confirmed');ctx.emit('message',ctx.run.input.includes('\nAIROOM_CONTEXT\n')?JSON.stringify({...JSON.parse(ctx.run.input.split('\nAIROOM_CONTEXT\n')[1]),action:'speak',body:'fixture reply'}):'fixture reply',{source:'assistant'});return {};},stop:async()=>{stops++;reusable=false;},dispose:async()=>{disposed++;reusable=false;}};
  const engine=new Engine(path.join(directory,'data'),()=>{},()=>{},()=>adapter,{automationNow:()=>at,automationTickMs:5});
  await engine.probe('dsh');
  return {engine,directory,counts:()=>({speech,stops,disposed,probes}),tick:async()=>{at+=60_000;await wait(()=>Boolean(engine.snapshot().automation?.recent.some(item=>Date.parse(item.startedAt)===at&&item.status!=='running')));},
    cleanup:async()=>{await engine.close();assert.ok(path.basename(directory).startsWith('AIROOM-balance-'));await fs.rm(directory,{recursive:true,force:true});}};
}

test('balance refresh shares one account request across members without probing, calling a model or recycling a warm runtime',async()=>{
  let reads=0,release!:(balance:AccountBalance)=>void;
  const f=await fixture(()=>{reads++;return new Promise(resolve=>{release=resolve;});});
  try{
    await f.engine.invoke('room.send',{mode:'discuss',style:'chat',maxCalls:1,maxMinutes:0,text:'warm runtime',memberIds:['dsh']});await wait(()=>!f.engine.snapshot().room.state.active);
    const before=f.counts(),first=f.engine.invoke('provider.balance',{provider:'dsh'}),second=f.engine.invoke('provider.balance',{provider:'dsh'});await wait(()=>reads===1);release(ready());await Promise.all([first,second]);
    assert.deepEqual(f.counts(),before);assert.equal(f.engine.snapshot().quotas?.dsh?.balance?.wallets[0].balance,'20.120000000000000000');
    await f.engine.invoke('room.send',{text:'next round',mode:'discuss',style:'chat',maxCalls:1,maxMinutes:0,memberIds:['dsh']});await f.engine.invoke('room.resume',{maxCalls:1});await wait(()=>!f.engine.snapshot().room.state.active);assert.equal(f.counts().disposed,0);assert.equal(f.counts().speech,2);
    await assert.rejects(()=>f.engine.invoke('provider.balance',{provider:'codex'}),/尚未提供/);
  }finally{await f.cleanup();}
});
test('a failed account balance check clears the old value without changing connectivity or inventing an exhausted quota',async()=>{
  let fail=false;const f=await fixture(async()=>{if(fail)throw Error('network unavailable');return ready();});
  try{await f.engine.invoke('provider.balance',{provider:'dsh'});fail=true;await f.engine.invoke('provider.balance',{provider:'dsh'});const snap=f.engine.snapshot();assert.equal(snap.providers.find(info=>info.id==='dsh')?.available,true);assert.equal(snap.quotas?.dsh?.balance?.status,'unavailable');assert.equal(quotaPreference(snap.quotas?.dsh),1);assert.equal(f.counts().speech,0);}finally{await f.cleanup();}
});
test('login invalidation rejects a late old-account balance while allowing the new account check to finish first',async()=>{
  const releases:((balance:AccountBalance)=>void)[]=[];const f=await fixture(()=>new Promise(resolve=>{releases.push(resolve);}));
  try{
    const old=f.engine.invoke('provider.balance',{provider:'dsh'});await wait(()=>releases.length===1);await f.engine.invoke('internal.provider.invalidate',{provider:'dsh'});
    const current=f.engine.invoke('provider.balance',{provider:'dsh'});await wait(()=>releases.length===2);releases[1](ready('8'));await current;releases[0](ready('999'));await old;
    assert.equal(f.engine.snapshot().quotas?.dsh?.balance?.wallets[0].balance,'8');
  }finally{await f.cleanup();}
});
test('a balance rounded to zero blocks scheduled speech without charging; a refreshed cent permits it',async()=>{
  let amount='0.004';const f=await fixture(async()=>ready(amount));
  try{
    await f.engine.invoke('provider.balance',{provider:'dsh'});await f.engine.invoke('automation.policy.save',{policies:{'scheduled-message':{enabled:true,dailyLimit:4}}});
    await f.engine.invoke('automation.save',{name:'balance gate',enabled:true,schedule:{kind:'interval',minutes:1},action:{kind:'member-message',memberId:'dsh',threadId:f.engine.store.currentRoomThread().id,feature:'scheduled-message',text:'test'}});await f.tick();
    assert.equal(f.counts().speech,0);assert.equal(f.engine.store.list('automatic_attempts').length,0);assert.match(f.engine.snapshot().automation!.recent[0].reason!,/额度/);
    amount='0.005';await f.engine.invoke('provider.balance',{provider:'dsh'});await f.tick();assert.equal(f.counts().speech,1);assert.equal(f.engine.store.list('automatic_attempts').length,1);
  }finally{await f.cleanup();}
});
test('balance samples survive a restart only for the same public account configuration',async()=>{
  const f=await fixture(async()=>ready('5'));let reopened:Engine|undefined;
  try{
    await f.engine.invoke('provider.balance',{provider:'dsh'});await f.engine.close();reopened=new Engine(path.join(f.directory,'data'),()=>{},()=>{},()=>({probe:async()=>provider,start:async()=>({}),stop:async()=>{}}));
    assert.equal(reopened.snapshot().quotas?.dsh?.balance?.wallets[0].balance,'5');reopened.settings={...reopened.settings,dshProfile:'different-public-profile'};assert.equal(reopened.snapshot().quotas?.dsh,undefined);
  }finally{await reopened?.close();await f.cleanup();}
});
test('the account subprocess parser returns only safe wallet fields and removes its generated launch patch',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM-balance-parser-')),patchFile=path.join(directory,'patch.json');await fs.writeFile(patchFile,'[]');
  try{
    const adapter=new DshAdapter();adapter.accountLaunch=async()=>({command:process.execPath,args:['-e',`console.log('AIROOM_DSH_ACCOUNT '+JSON.stringify({type:'status',authenticated:true,state:'signed-in',accountBalance:{...${JSON.stringify(ready('12.340000000000001'))},token:'fixture-private',wallets:[{currency:'CNY',balance:'12.340000000000001',contact:'fixture-private'}]}}))`],env:process.env,cwd:directory,patchFile});
    const balance=await adapter.accountBalance(DEFAULT_SETTINGS,process.env);assert.equal(balance.status,'ready');assert.equal(balance.wallets[0].balance,'12.340000000000001');assert.ok(!JSON.stringify(balance).includes('fixture-private'));assert.equal(await fs.stat(patchFile).catch(()=>null),null);
  }finally{assert.ok(path.basename(directory).startsWith('AIROOM-balance-parser-'));await fs.rm(directory,{recursive:true,force:true});}
});
test('the account parser refuses a balance attached to a signed-out or unrecognized account status',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM-balance-parser-'));
  try{
    for(const status of [{authenticated:false,state:'signed-out'},{authenticated:true,state:'not-a-native-state'}]){
      const adapter=new DshAdapter(),patchFile=path.join(directory,'patch.json');await fs.writeFile(patchFile,'[]');
      adapter.accountLaunch=async()=>({command:process.execPath,args:['-e',`console.log('AIROOM_DSH_ACCOUNT '+JSON.stringify({type:'status',...${JSON.stringify(status)},accountBalance:${JSON.stringify(ready('999'))}}))`],env:process.env,cwd:directory,patchFile});
      const balance=await adapter.accountBalance(DEFAULT_SETTINGS,process.env);assert.equal(balance.status,'unavailable');assert.equal(balance.signedOut,status.state==='signed-out'?true:undefined);
    }
  }finally{assert.ok(path.basename(directory).startsWith('AIROOM-balance-parser-'));await fs.rm(directory,{recursive:true,force:true});}
});

test('a signed-out balance refresh rechecks connectivity, while a network-only failure keeps the last confirmed login',async()=>{
  let loggedIn=true;const f=await fixture(async()=>({...ready(),...(loggedIn?{}:{status:'unavailable' as const,signedOut:true,wallets:[],bonusWallets:[]})}));
  try{
    loggedIn=false;const native={probe:async()=>({...provider,available:false,auth:'none' as const,detail:'登录已失效'}),accountBalance:async()=>({...ready(),status:'unavailable' as const,signedOut:true,wallets:[],bonusWallets:[]}),start:async()=>{assert.fail('No model calls');},stop:async()=>{}};
    (f.engine as any).factory=()=>native;await f.engine.invoke('provider.balance',{provider:'dsh'});
    assert.equal(f.engine.snapshot().providers.find(info=>info.id==='dsh')!.auth,'none');assert.equal(f.engine.snapshot().quotas?.dsh?.balance?.status,'unavailable');assert.equal(f.counts().speech,0);
  }finally{await f.cleanup();}
  const failed=await fixture(async()=>{throw new Error('network failed');});try{await failed.engine.invoke('provider.balance',{provider:'dsh'});assert.equal(failed.engine.snapshot().providers.find(info=>info.id==='dsh')!.auth,'account');assert.equal(failed.counts().probes,1);}finally{await failed.cleanup();}
});
