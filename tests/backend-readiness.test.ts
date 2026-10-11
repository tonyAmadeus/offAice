import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BackendReadiness } from '../src/main/backend-readiness';

test('state reads wait for startup while actions fail immediately', async () => {
  const gate = new BackendReadiness(), generation = gate.start();
  let delivered = false;
  const read = gate.wait(generation, 1000).then(() => { delivered = true; });
  await Promise.resolve();
  assert.equal(delivered, false);
  assert.throws(() => gate.assertReady(generation), /尚未就绪/);
  gate.markReady(generation);
  await read;
  assert.equal(delivered, true);
  assert.doesNotThrow(() => gate.assertReady(generation));
});

test('restart cancels old reads instead of replaying them against the replacement', async () => {
  const gate = new BackendReadiness(), old = gate.start();
  const cancelled = assert.rejects(gate.wait(old, 1000), /重新启动/);
  const current = gate.start();
  await cancelled;
  assert.equal(gate.markReady(old), false);
  assert.equal(gate.fail(old, 'late old exit'), false);
  assert.throws(() => gate.assertReady(current), /尚未就绪/);
  gate.markReady(current);
  assert.equal(gate.fail(old, 'late old exit'), false);
  assert.doesNotThrow(() => gate.assertReady(current));
  await assert.rejects(gate.wait(old, 1000), /已切换/);
});

test('worker failure releases waiting reads and a late ready message cannot revive it', async () => {
  const gate = new BackendReadiness(), generation = gate.start();
  const failed = assert.rejects(gate.wait(generation, 1000), /初始化失败/);
  gate.fail(generation, '初始化失败');
  await failed;
  assert.equal(gate.markReady(generation), false);
  assert.throws(() => gate.assertReady(generation), /初始化失败/);
  await assert.rejects(gate.wait(generation, 1000), /初始化失败/);
});

test('a timed out read stays failed but a later explicit read can use a ready worker', async () => {
  const gate = new BackendReadiness(), generation = gate.start();
  await assert.rejects(gate.wait(generation, 5), /启动超时/);
  gate.markReady(generation);
  await gate.wait(generation, 1000);
  gate.fail(generation, '执行服务已退出');
  assert.throws(() => gate.assertReady(generation), /已退出/);
});
