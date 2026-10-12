import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeAccountUsage } from '../src/backend/adapters/claude-quota';
import { ClaudeAdapter } from '../src/backend/adapters/claude';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';
import { mergeQuota,quotaReport,quotaPreference } from '../src/shared/quota';
import { Engine } from './helpers/seeded-engine';
import type { Adapter } from '../src/shared/types';

const sample={rate_limits:{limits:[{kind:'session',percent:23,resets_at:'2026-10-04T20:00:00Z',severity:'normal',is_active:true},{kind:'weekly_all',percent:7,resets_at:'2026-10-10T20:00:00Z',severity:'normal',is_active:false}]}};
async function fixture(mode='ready'){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM-claude-usage-')),file=path.join(directory,'claude.cjs');
  await fs.writeFile(file,`const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
if(process.argv.includes('--version')){console.log('2.1.288');process.exit(0);}
if(process.argv.includes('auth')){const out=fs.existsSync(require('node:path').join(__dirname,'signed-out'));console.log(JSON.stringify({loggedIn:!out,authMethod:out?'none':'claude.ai',apiProvider:'firstParty'}));process.exit(0);}
fs.writeFileSync(require('node:path').join(__dirname,'argv.json'),JSON.stringify(process.argv));
const send=m=>console.log(JSON.stringify(m)),mode=${JSON.stringify(mode)};
rl.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(require('node:path').join(__dirname,'requests.jsonl'),line+'\\n');
if(m.type==='control_request'){if(mode==='timeout')return;send({type:'control_response',response:{subtype:'success',request_id:mode==='wrong-id'?'old-id':m.request_id,response:{commands:[{name:'usage',builtin:mode!=='custom'}]}}});}
if(m.type==='user'){if(mode==='signs-out'){const p=require('node:path'),home=p.join(__dirname,'home');fs.mkdirSync(home,{recursive:true});fs.writeFileSync(p.join(home,'.credentials.json'),'{}');fs.writeFileSync(p.join(__dirname,'signed-out'),'');}send({type:'assistant',usage_report:mode==='unavailable'?{rate_limits:null}:{...${JSON.stringify(sample)},private:'private-native-token',session:{total_cost_usd:999,private:'private-native-token'}},message:{content:[]}});send({type:'result',subtype:'success',is_error:false,local_command:mode==='wrong-result'?'other':'usage',num_turns:mode==='model-turn'?1:0});}
});`);
  return {directory,command:{command:process.execPath,prefix:[file],path:file},env:{...process.env,AIROOM_APP_ROOT:directory,AIROOM_CLAUDE_HOME:path.join(directory,'home')},
    cleanup:async()=>{assert.ok(path.basename(directory).startsWith('AIROOM-claude-usage-'));await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}};
}
test('Claude startup fetches native quota without a model turn, tools, costs or credentials',async()=>{
  const f=await fixture();try{
    const info=await new ClaudeAdapter().probe({...DEFAULT_SETTINGS,paths:{claude:f.command.path}},f.env);
    assert.equal(info.available,true);assert.equal(info.auth,'subscription');assert.ok(info.quotaCheckedAt);
    const quota=quotaReport('claude',info.quota,info.quotaCheckedAt!,'probe')!;
    assert.deepEqual(quota.windows.map(row=>[row.id,row.usedPercent]),[['five_hour',23],['seven_day',7]]);
    assert.equal(JSON.stringify(info).includes('private-native-token'),false);assert.equal(JSON.stringify(info).includes('total_cost_usd'),false);
    const requests=(await fs.readFile(path.join(f.directory,'requests.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(requests.filter(packet=>packet.type==='user').map(packet=>packet.message.content),['/usage']);
    const args=JSON.parse(await fs.readFile(path.join(f.directory,'argv.json'),'utf8'));assert.ok(args.includes('--no-session-persistence'));assert.equal(args[args.indexOf('--tools')+1],'');assert.ok(args.includes('--restricted'));
  }finally{await f.cleanup();}
});
for(const mode of ['custom','wrong-id','wrong-result','model-turn','timeout'])test(`quota refuses an unverified built-in, unrelated response or model result: ${mode}`,async()=>{
  const f=await fixture(mode);try{assert.equal(await claudeAccountUsage(f.command,f.env,f.directory,1500),undefined);const lines=await fs.readFile(path.join(f.directory,'requests.jsonl'),'utf8');if(['custom','wrong-id','timeout'].includes(mode))assert.ok(!lines.includes('"type":"user"'));}finally{await f.cleanup();}
});
test('an unavailable native usage fetch keeps Claude connected and clears expired quota truthfully',async()=>{
  const f=await fixture('unavailable');try{
    const info=await new ClaudeAdapter().probe({...DEFAULT_SETTINGS,paths:{claude:f.command.path}},f.env);assert.equal(info.available,true);
    const previous=quotaReport('claude',{accountUsage:sample},'2026-10-03T01:00:00Z','probe')!,fresh=quotaReport('claude',info.quota,info.quotaCheckedAt!,'probe')!;
    assert.equal(fresh.queryStatus,'unavailable');assert.deepEqual(mergeQuota(previous,fresh).windows,[]);assert.equal(quotaPreference(fresh),1);
  }finally{await f.cleanup();}
});
test('manual quota refresh deduplicates, preserves connection and rejects an invalidated late account response',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM-claude-usage-engine-'));let reads=0,release!:(value:any)=>void;
  const adapter:Adapter={probe:async()=>{throw new Error('unused');},accountQuota:async()=>{reads++;return new Promise(done=>{release=done;});},start:async()=>{assert.fail('Quota refresh must not call a model');},stop:async()=>{}};
  const engine=new Engine(directory,()=>{},()=>{},()=>adapter);
  try{
    const first=engine.invoke('provider.quota',{provider:'claude'}),second=engine.invoke('provider.quota',{provider:'claude'});assert.equal(reads,1);
    release({payload:{accountUsage:sample},checkedAt:new Date().toISOString()});await Promise.all([first,second]);assert.equal(engine.snapshot().quotas?.claude?.windows[0].usedPercent,23);
    const late=engine.invoke('provider.quota',{provider:'claude'});await engine.invoke('internal.provider.invalidate',{provider:'claude'});release({payload:{accountUsage:sample},checkedAt:new Date().toISOString()});await late;
    assert.deepEqual(engine.snapshot().quotas?.claude?.windows,[]);assert.equal(reads,2);
  }finally{await engine.close();assert.ok(path.basename(directory).startsWith('AIROOM-claude-usage-engine-'));await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test('a login the CLI drops while answering /usage is reported as signed out, not as connected',async()=>{
  const f=await fixture('signs-out');try{
    const info=await new ClaudeAdapter().probe({...DEFAULT_SETTINGS,paths:{claude:f.command.path}},f.env);
    assert.equal(info.available,false);assert.equal(info.auth,'none');assert.match(info.detail,/登录/);
  }finally{await f.cleanup();}
  const g=await fixture('signs-out');try{
    const result=await new ClaudeAdapter().accountQuota({...DEFAULT_SETTINGS,paths:{claude:g.command.path}},g.env);
    assert.equal(result.signedOut,true);assert.deepEqual(result.payload,{accountUsage:null});
  }finally{await g.cleanup();}
});
test('a quota refresh that finds Claude signed out checks the connection again',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM-claude-usage-engine-'));let probes=0;
  const adapter:Adapter={probe:async()=>{probes++;return {id:'claude',name:'Claude',available:false,auth:'none',detail:'Claude 未确认订阅登录（none）',capabilities:{steer:false,cancel:'process',streaming:true,write:true,history:true}} as any;},
    accountQuota:async()=>({payload:{accountUsage:null},checkedAt:new Date().toISOString(),signedOut:true}),start:async()=>{assert.fail('Quota refresh must not call a model');},stop:async()=>{}};
  const engine=new Engine(directory,()=>{},()=>{},()=>adapter);
  try{
    await engine.invoke('provider.quota',{provider:'claude'});
    assert.equal(probes,1);assert.equal(engine.snapshot().providers.find(info=>info.id==='claude')?.auth,'none');
  }finally{await engine.close();assert.ok(path.basename(directory).startsWith('AIROOM-claude-usage-engine-'));await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
