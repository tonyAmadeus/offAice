import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import type {ProviderInfo} from '../src/shared/types';
import {runnable} from '../src/renderer/ui';

const connected=(id:ProviderInfo['id'],auth:ProviderInfo['auth']):ProviderInfo=>({id,name:id,available:true,auth,detail:'fixture',capabilities:{streaming:false,write:true,history:true,cancel:'native',steer:false}});

test('connected external programs accept official subscription login as well as account login',()=>{
  for(const id of ['acp-catalogzcode','acp-catalogcursor'] as const){
    assert.equal(runnable(connected(id,'subscription')),true,`${id}: official subscription`);
    assert.equal(runnable(connected(id,'account')),true,`${id}: official account`);
  }
});

test('external subscription login still requires an available, current connection and confirmed authentication',()=>{
  const info=connected('acp-catalogzcode','subscription');
  assert.equal(runnable({...info,available:false}),false);
  assert.equal(runnable({...info,stale:true}),false);
  for(const auth of ['none','unknown','api'] as const)assert.equal(runnable({...info,auth}),false);
  assert.equal(runnable(),false);
});

test('external subscription support preserves built-in executor account and billing requirements',()=>{
  assert.equal(runnable(connected('codex','subscription')),true);
  assert.equal(runnable(connected('codex','account')),false);
  assert.equal(runnable(connected('codex','api')),false);
  assert.equal(runnable(connected('claude','subscription')),true);
  assert.equal(runnable(connected('claude','api')),true);
  assert.equal(runnable(connected('dsh','account')),true);
  assert.equal(runnable(connected('dsh','subscription')),false);
  assert.equal(runnable(connected('deepseek','api')),true);
});
