import '../scripts/test-bootstrap.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Engine } from './helpers/seeded-engine';
import type { Adapter, Run, Session, Project } from '../src/shared/types';

for (const mode of ['accepted', 'unknown', 'unsupported'] as const) test(`run nudge ${mode}: one attempt, no extra run, other work preserved`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'AIROOM-nudge-'));
  let nudges = 0, starts = 0;
  const releases = new Set<() => void>();
  const factory = (id: Run['provider']): Adapter => ({
    probe: async () => ({ id, name: id, available: true, auth: 'subscription', detail: 'fixture', capabilities: { steer: mode !== 'unsupported', cancel: 'native', streaming: true, history: true, write: false } }),
    start: async ctx => { starts++; ctx.markDelivery('confirmed'); await new Promise<void>(resolve => releases.add(resolve)); return {}; },
    stop: async () => { for (const release of releases) release(); },
    steer: async text => { nudges++; assert.match(text, /如实说明/); if (mode === 'unknown') throw Error('lost acknowledgement'); return true; },
  });
  const engine = new Engine(path.join(root, 'data'), () => {}, () => {}, factory);
  try {
    await engine.probe(); const source = path.join(root, 'project'); await mkdir(source);
    const project = await engine.invoke('project.create', { directory: source }) as Project;
    const session = await engine.invoke('session.create', { projectId: project.id, provider: 'codex', writeMode: false }) as Session;
    await engine.invoke('session.send', { sessionId: session.id, text: 'work' });
    const until = Date.now() + 3000; let run: Run | undefined;
    while (!(run = engine.store.list<Run>('runs').find(run => run.status === 'running' && run.delivery === 'confirmed'))) {
      if (Date.now() > until) throw Error('run did not start'); await new Promise(resolve => setTimeout(resolve, 10));
    }
    const results = await Promise.all([engine.invoke('run.nudge', { runId: run.id }), engine.invoke('run.nudge', { runId: run.id })]);
    assert.equal((results[0] as {delivery:string}).delivery, mode === 'accepted' ? 'current' : mode === 'unknown' ? 'unknown' : 'next-turn');
    await engine.invoke('run.nudge', { runId: run.id });
    assert.equal(nudges, mode === 'unsupported' ? 0 : 1); assert.equal(starts, 1);
    assert.equal(engine.store.list<Run>('runs').length, 1); assert.equal(engine.store.get<Run>('runs', run.id)?.status, 'running');
    if (mode !== 'unsupported') assert.equal(engine.store.get<{delivery:string}>('outbox', `run-nudge:${run.id}`)?.delivery, mode === 'accepted' ? 'confirmed' : 'unknown');
  } finally { await engine.close(); await rm(root, {recursive:true, force:true, maxRetries:20, retryDelay:100}); }
});
