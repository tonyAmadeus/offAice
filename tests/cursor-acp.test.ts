import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {cursorPackage} from './fixtures/cursor-package';
import {AcpAdapter} from '../src/backend/adapters/acp';
import {catalogCandidate} from '../src/backend/executor-catalog';
import {DEFAULT_SETTINGS} from '../src/shared/defaults';
import type {AdapterContext} from '../src/shared/types';

const root=path.resolve('.test-cache/cursor-acp-tests');
async function fixture(mode='normal'){
  await mkdir(root,{recursive:true});const directory=await mkdtemp(path.join(root,'run-')),calls=path.join(directory,'calls.jsonl'),item=await cursorPackage(path.join(directory,'package'),'2026.10.01-e373342',{host:true,script:await readFile('tests/fixtures/fake-cursor-agent.mjs','utf8')}),executor=catalogCandidate('cursor',item.entry);
  executor.env={FIXTURE_CALLS:calls,FIXTURE_MODE:mode};
  const adapter=new AcpAdapter(executor),events:any[]=[],delivery:string[]=[],approvals:any[]=[];
  const context:AdapterContext={cwd:directory,env:{...process.env,AIROOM_ACP_HOME:path.join(directory,'homes'),CURSOR_API_KEY:'host-key',CURSOR_AUTH_TOKEN:'host-token',AIROOM_NODE_EXE:'must-not-use-wrong-node'},settings:{...DEFAULT_SETTINGS,models:{[executor.id]:'deep'},efforts:{}},run:{id:'run',sessionId:'session',projectId:'project',provider:executor.id,revision:1,status:'running',input:'hello',createdAt:'',updatedAt:'',bootId:'test',delivery:'prepared'},session:{id:'session',projectId:'project',provider:executor.id,revision:1,title:'Cursor test',writeMode:false,createdAt:'',updatedAt:''},persona:'人物卡内容',emit:(...args)=>events.push(args),approve:async request=>{approvals.push(request);return request.type==='question'?{choice:'answer',answers:{style:'简洁'}}:{choice:request.category==='plan'?'accept':'once'};},persistNativeSession:id=>{context.session.nativeId=id;},markDelivery:state=>{delivery.push(state);},registerProcess:()=>{}};
  return {adapter,context,events,delivery,approvals,packets:async()=>(await readFile(calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line)),cleanup:async()=>{await adapter.dispose();assert.equal(path.dirname(directory),root);await rm(directory,{recursive:true,force:true});}};
}

test('Cursor ACP selects the model, sends persona, handles extensions and streams one complete reply',async()=>{
  const f=await fixture();try{
    const result=await f.adapter.start(f.context,'开始检查');assert.equal(result.failure,undefined);assert.equal(result.unknown,undefined);assert.equal(f.context.session.nativeId,'cursor-session');assert.equal(f.events.filter(event=>event[0]==='delta').map(event=>event[1]).join(''),'Cursor 完成本轮回复。');assert.deepEqual(f.approvals.map(request=>request.type),['approval','question','approval']);
    const packets=await f.packets();assert.equal(packets.find(p=>p.method==='session/set_model').params.modelId,'deep');assert.match(packets.find(p=>p.method==='session/prompt').params.prompt[0].text,/人物卡内容/);assert.equal(packets.find(p=>p.id==='permission'&&p.result).result.outcome.optionId,'once');assert.deepEqual(packets.find(p=>p.id==='question'&&p.result).result,{outcome:{outcome:'answered',answers:[{questionId:'style',selectedOptionIds:['brief']}]}});assert.equal(packets.find(p=>p.id==='plan'&&p.result).result.outcome.outcome,'accepted');assert.equal(packets.filter(p=>p.method==='session/prompt').length,1);
    await f.adapter.start(f.context,'继续');assert.equal((await f.packets()).filter(p=>p.method==='session/load').length,1);
  }finally{await f.cleanup();}
});

for(const mode of ['quota','disconnect'])test(`Cursor ACP ${mode} keeps the delivery outcome and never retries automatically`,async()=>{
  const f=await fixture(mode);try{if(mode==='quota'){const result=await f.adapter.start(f.context,'错误测试');assert.equal(result.failure?.kind,'rate_limited');assert.equal(f.delivery.at(-1),'confirmed');}else{await assert.rejects(f.adapter.start(f.context,'错误测试'),/连接已关闭/);assert.equal(f.delivery.at(-1),'unknown');}assert.equal((await f.packets()).filter(p=>p.method==='session/prompt').length,1);}finally{await f.cleanup();}
});

test('Cursor stop during a question cancels the native prompt and discards a late answer',async()=>{
  const f=await fixture();let resolve!:(answer:{choice:string;answers:unknown})=>void;let asked!:()=>void;const question=new Promise<void>(done=>asked=done);
  f.context.approve=async request=>{if(request.type==='approval')return {choice:'once'};asked();return new Promise(done=>resolve=done);};
  try{const running=f.adapter.start(f.context,'等待用户');await question;await f.adapter.stop();assert.equal((await running).stopped,true);resolve({choice:'answer',answers:{style:'简洁'}});await new Promise(done=>setTimeout(done,30));assert.equal((await f.packets()).filter(p=>p.id==='question'&&p.result?.outcome?.outcome==='answered').length,0);}finally{await f.cleanup();}
});
