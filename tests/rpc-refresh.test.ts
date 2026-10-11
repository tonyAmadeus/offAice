import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshAfterRpc} from '../src/shared/rpc-refresh';
import {rpcTimeoutMessage,rpcTimeout} from '../src/main/rpc-timeouts';
test('background login and installation polls never request another full snapshot',()=>{
  for(const method of ['composer.draft.get','composer.draft.save','catalog.list','catalog.installation','executor.loginStatus','member.versions','member.installation','settings.save','room.get','roundtable.list'])assert.equal(refreshAfterRpc(method),false,method);
  for(const method of ['team.delete','catalog.install','project.create'])assert.equal(refreshAfterRpc(method),true,method);
  assert.match(rpcTimeoutMessage('catalog.installation'),/读取下载进度/);assert.match(rpcTimeoutMessage('executor.loginStatus'),/读取登录状态/);assert.equal(rpcTimeout('catalog.install'),20*60_000);
});
