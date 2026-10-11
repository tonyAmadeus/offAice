import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {acpChatLaunch} from '../src/backend/adapters/acp-chat';
import {plainRoomSpeech} from '../src/backend/adapters/chat-policy';
import {catalogCandidate,managedCatalogEnvironment} from '../src/backend/executor-catalog';
import {buildDshEnvironment} from '../src/backend/adapters/dsh';
import type {AdapterContext} from '../src/shared/types';
const room=()=>({conversation:'room',session:{writeMode:false},run:{}} as AdapterContext);

test('tool-free optimization only applies to positively identified ordinary room speech',()=>{
  const context=room();assert.equal(plainRoomSpeech(context),true);
  for(const extra of [{conversation:'desk'},{conversation:undefined},{session:{writeMode:true}},{session:{purpose:'room-minutes'}},{run:{imageGeneration:true}},{run:{flowOperationId:'flow'}}])assert.equal(plainRoomSpeech({...context,...extra} as AdapterContext),false);
});

test('verified Qoder removes ordinary room tools per invocation and leaves tasks, reports, history and config untouched',()=>{
  for(const id of ['qoder'] as const){
    const executor=catalogCandidate(id,path.resolve('qoder.exe')),args=[...executor.args],env={QODER_CONFIG_DIR:'original',NODE_COMPILE_CACHE:'cache'};
    const launch=acpChatLaunch(executor,env,room());assert.equal(launch.args[launch.args.indexOf('--tools')+1],'');assert.deepEqual(JSON.parse(launch.args.at(-1)!),{mcpServers:{}});assert.deepEqual(executor.args,args);assert.equal(launch.env,env);
    for(const context of [undefined,{...room(),conversation:'desk'} as AdapterContext,{...room(),session:{purpose:'room-summary'}} as AdapterContext])assert.deepEqual(acpChatLaunch(executor,env,context).args,args);
  }
});

test('unverified OpenCode and Qoder CN retain native tools; malformed temporary config has a readable error',()=>{
  const executor=catalogCandidate('opencode',path.resolve('opencode.exe')),config={enabled_providers:['opencode-go'],provider:{'opencode-go':{options:{apiKey:'{env:OPENCODE_API_KEY}'}}},instructions:['MEMORY.md'],tools:{bash:true},permission:{bash:'allow'}};
  const env={OPENCODE_CONFIG_CONTENT:JSON.stringify(config)},launch=acpChatLaunch(executor,env,room()),actual=JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!);
  assert.deepEqual(actual,config);assert.equal(launch.env,env);assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT),config);
  assert.equal(acpChatLaunch(executor,env,{...room(),conversation:'desk'}).env,env);
  assert.throws(()=>acpChatLaunch(executor,{OPENCODE_CONFIG_CONTENT:'[]'},room()),/临时配置/);
  assert.throws(()=>acpChatLaunch(executor,{OPENCODE_CONFIG_CONTENT:'{broken'},room()),/临时配置无法解析.*任务尚未发送/);
  const cn=catalogCandidate('qodercn',path.resolve('qoder.exe'));
  assert.deepEqual(acpChatLaunch(cn,env,room()),{args:cn.args,env});
});

test('Kimi and Cursor retain native agents/history while Node compile caches stay inside the independent home',()=>{
  for(const id of ['kimi','cursor'] as const){
    const executor=catalogCandidate(id,path.resolve('agent.exe')),env={};assert.deepEqual(acpChatLaunch(executor,env,room()),{args:executor.args,env});
  }
  const home=path.resolve('tests/results/compile-home'),executor=catalogCandidate('kimi',path.resolve('kimi.mjs'));
  const source={NODE_COMPILE_CACHE:'outside',HOME:'original'};const env=managedCatalogEnvironment(executor,source,home);
  assert.equal(env.NODE_COMPILE_CACHE,path.join(home,'cache','node'));assert.equal(source.NODE_COMPILE_CACHE,'outside');
});

test('DSH startup cache is isolated without changing native account, permission or memory locations',()=>{
  const home=path.resolve('tests/results/dsh-chat'),source={NODE_COMPILE_CACHE:'outside',AIROOM_DSH_HOME:home};
  const env=buildDshEnvironment(source,home,false);assert.equal(env.NODE_COMPILE_CACHE,path.join(home,'cache','node'));assert.equal(env.DSH_HOME,home);assert.equal(env.DSH_PERMISSION_MODE,'read-only');assert.equal(source.NODE_COMPILE_CACHE,'outside');
});
