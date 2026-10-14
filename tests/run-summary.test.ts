import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Engine } from '../src/backend/engine';
import { Store } from '../src/backend/store';
import { RUN_INPUT_PREVIEW, runSummary } from '../src/shared/run-summary';
import type { Project, Run, Session, TimelineEvent } from '../src/shared/types';

const at = '2026-10-13T08:00:00.000Z';
const project: Project = { id: 'p', name: '项目', directory: 'C:\\proj', createdAt: at, collaborationPaused: false };
const session = { id: 's', projectId: 'p', provider: 'codex', title: '会话', createdAt: at, updatedAt: at, revision: 1, writeMode: false } as Session;
const longInput = `任务开头${'细节'.repeat(200)}\n任务结尾：务必保留这一行`;
const run = (id: string, input: string): Run => ({ id, sessionId: 's', projectId: 'p', provider: 'codex', revision: 1, status: 'stopped', input, createdAt: at, updatedAt: at, bootId: 'boot', nativeTurnId: 'turn', delivery: 'confirmed', executorIdentity: { adapterVersion: '1', protocol: 'codex-app-server', path: 'C:\\codex.exe', digest: 'x' } });

test('a run summary keeps a short preview and drops the prompt body and executor internals', () => {
  const summary = runSummary(run('r', longInput));
  assert.equal([...summary.inputPreview].length, RUN_INPUT_PREVIEW + 1, 'preview plus one ellipsis');
  assert.ok(summary.inputPreview.startsWith('任务开头') && summary.inputPreview.endsWith('…'));
  assert.equal(summary.inputLength, [...longInput].length);
  for (const key of ['input', 'executorIdentity', 'bootId', 'nativeTurnId']) assert.equal(key in summary, false, key);
  assert.equal(runSummary(run('short', '短任务')).inputPreview, '短任务');
});

test('the workbench snapshot carries previews while run.inputs and internal.lookup return exact records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'AIROOM run-summary-'));
  const offline = () => ({ probe: async () => { throw new Error('offline'); }, start: async () => { throw new Error('offline'); }, stop: async () => {} }) as never;
  const engine = new Engine(root, () => {}, () => {}, offline, { maintenanceOnly: true });
  try {
    engine.store.put('projects', 'p', project); engine.store.put('sessions', 's', session);
    engine.store.put('runs', 'long', run('long', longInput)); engine.store.put('runs', 'short', run('short', '短任务'));
    const snapshot = engine.snapshot();
    const long = snapshot.runs.find(item => item.id === 'long')!;
    assert.equal('input' in long, false); assert.equal(long.inputLength, [...longInput].length);
    assert.ok(JSON.stringify(snapshot).length < JSON.stringify(longInput).length + 20_000);
    assert.deepEqual(await engine.invoke('run.inputs', { runIds: ['long', 'short', 'missing'] }), { long: longInput, short: '短任务' });
    const found = await engine.invoke('internal.lookup', { sessionId: 's', executors: true }) as { session?: Session; project?: Project; executors?: unknown[] };
    assert.equal(found.session?.id, 's'); assert.equal(found.project?.directory, 'C:\\proj'); assert.deepEqual(found.executors, []);
    assert.deepEqual(await engine.invoke('internal.lookup', { projectId: 'missing' }), { session: undefined, project: undefined });
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test('event log lines are batched but every stored event reaches the daily log', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'AIROOM event-log-'));
  const store = new Store(root);
  try {
    const events = Array.from({ length: 5 }, (_, index): TimelineEvent => ({ id: `e${index}`, runId: 'r', sessionId: 's', provider: 'codex', at, kind: 'delta', text: `片段${index} sk-ant-abcdefghijklmnop`, fidelity: 'native' }));
    const stored = events.map(event => store.appendEvent(event));
    assert.ok(stored.every(event => event.text.includes('[credential redacted]') && !event.text.includes('sk-ant')), 'appendEvent returns the redacted record');
    store.appendEvent(events[0]);
    store.flushLog();
    const lines = (await readFile(path.join(root, 'logs', '2026-10-13.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as TimelineEvent);
    assert.deepEqual(lines.map(line => line.id), ['e0', 'e1', 'e2', 'e3', 'e4'], 'ordered, duplicates ignored');
    store.appendEvent({ ...events[0], id: 'late' });
  } finally { store.close(); }
  const after = (await readFile(path.join(root, 'logs', '2026-10-13.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(JSON.parse(after.at(-1)!).id, 'late', 'closing flushes pending lines');
  await rm(root, { recursive: true, force: true });
});

test('a run without task text still summarizes instead of failing the whole snapshot', () => {
  const legacy = { ...run('legacy', ''), input: undefined } as unknown as Run;
  assert.deepEqual([runSummary(legacy).inputPreview, runSummary(legacy).inputLength], ['', 0]);
});
