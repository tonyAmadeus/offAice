import test from 'node:test';
import assert from 'node:assert/strict';
import {failureMessage,isConnectionFailure} from '../src/backend/adapter-failure';

test('1113 explains account entitlement before a generic 429 frequency message',()=>{
  const text=failureMessage('HTTP 429 {"code":"1113","message":"Insufficient balance or no resource package"}','rate_limited');
  assert.match(text,/1113.*登录地区.*套餐通道/);assert.doesNotMatch(text,/请求频率/);
  const localized='ZCode BigModel 中国区套餐不可用（1113：余额不足或没有可用资源包）。';assert.equal(failureMessage(localized,'blocked'),localized);
});

test('a permission refusal does not claim the login has expired or imply a transport retry',()=>{
  for(const raw of ['Failed to authenticate. API Error: 403 Request not allowed','permission_error: denied']){
    assert.match(failureMessage(raw),/服务端拒绝/);assert.doesNotMatch(failureMessage(raw),/登录已失效/);
    assert.equal(isConnectionFailure(raw),false);
  }
  assert.match(failureMessage('401 Invalid authentication credentials'),/登录已失效/);
});

test('workspace routing timeouts explain account initialization and distinguish unsent from unknown delivery',()=>{
  const raw='workspace routing discovery timed out';
  assert.equal(isConnectionFailure(raw),true);
  assert.match(failureMessage(raw,undefined,'prepared'),/账号.*初始化.*未发出/);
  assert.doesNotMatch(failureMessage(raw,undefined,'unknown'),/未发出|直接重试/);
  assert.match(failureMessage('workspace routing discovery failed: 401 Unauthorized',undefined,'prepared'),/登录已失效/);
  assert.doesNotMatch(failureMessage('workspace routing discovery failed',undefined,'prepared'),/超时/);
});
