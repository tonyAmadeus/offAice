import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/backend/store';
import { Engine } from '../src/backend/engine';

const temp = (name: string) => mkdtemp(path.join(os.tmpdir(), `AIROOM ${name}-`));

test('reopening drops the duplicated task text from run receipts but keeps supplement text', async () => {
  const root = await temp('outbox');
  try {
    const first = new Store(root);
    first.put('outbox', 'run-1', { runId: 'run-1', sessionId: 's', text: '整段任务', delivery: 'confirmed' });
    first.put('outbox', 'steer-1', { runId: 'run-1', sessionId: 's', text: '补充要求', kind: 'steer', delivery: 'unknown' });
    first.close();
    const reopened = new Store(root);
    try {
      assert.deepEqual(reopened.get('outbox', 'run-1'), { runId: 'run-1', sessionId: 's', delivery: 'confirmed' });
      assert.equal(reopened.get<{ text: string }>('outbox', 'steer-1')?.text, '补充要求');
    } finally { reopened.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('receipt retention keeps the newest records in creation order and leaves other entities alone', async () => {
  const root = await temp('retention');
  const store = new Store(root);
  try {
    for (let i = 0; i < 8; i++) store.put('flow_requests', `r${i}`, { key: `k${i}` });
    store.put('flow_requests', 'r1', { key: 'k1', result: 'late result' }); // An update keeps its original position.
    for (let i = 0; i < 4; i++) store.put('projects', `p${i}`, { id: `p${i}` });
    store.retainNewest({ flow_requests: 3, roundtable_requests: 3 });
    assert.deepEqual(store.list<{ key: string }>('flow_requests').map(item => item.key), ['k5', 'k6', 'k7']);
    assert.equal(store.list('projects').length, 4);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('compaction reclaims a mostly free file without changing record order', async () => {
  const root = await temp('compact');
  const store = new Store(root);
  try {
    const filler = 'x'.repeat(20_000);
    store.transaction(() => { for (let i = 0; i < 600; i++) store.put('scratch', `s${i}`, { filler }); });
    for (let i = 0; i < 5; i++) store.put('projects', `p${i}`, { id: `p${i}`, order: i });
    store.transaction(() => { for (let i = 0; i < 600; i++) store.delete('scratch', `s${i}`); });
    const order = store.list<{ id: string }>('projects').map(item => item.id);
    const before = (await stat(path.join(root, 'airoom.sqlite'))).size;
    const result = store.compact();
    assert.ok(result && result.afterPages < result.beforePages / 2, JSON.stringify(result));
    assert.deepEqual(store.list<{ id: string }>('projects').map(item => item.id), order);
    assert.equal(store.compact(), undefined, 'a compact file is left alone');
    store.close();
    assert.ok((await stat(path.join(root, 'airoom.sqlite'))).size < before / 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the engine applies receipt retention when it opens the data folder', async () => {
  const root = await temp('engine-retention');
  const seed = new Store(root);
  for (let i = 0; i < 320; i++) seed.put('roundtable_requests', `q${i}`, { hash: 'h', result: i });
  seed.put('personal_read_tokens', 'global:t', { roomId: 'global', threadId: 't', token: 't' });
  seed.close();
  const offline = () => ({ probe: async () => { throw new Error('offline'); }, start: async () => { throw new Error('offline'); }, stop: async () => {} }) as never;
  const engine = new Engine(root, () => {}, () => {}, offline, { maintenanceOnly: true });
  try {
    const kept = engine.store.list<{ result: number }>('roundtable_requests');
    assert.equal(kept.length, 300); assert.equal(kept[0].result, 20);
    assert.equal(engine.store.list('personal_read_tokens').length, 1);
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});
