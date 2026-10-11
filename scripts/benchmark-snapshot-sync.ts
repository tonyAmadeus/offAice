// Read-only transport benchmark. Never constructs Engine or modifies the daily profile.
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { MessageChannel } from 'node:worker_threads';
import path from 'node:path';
import { SnapshotPublisher, applySnapshotPatch } from '../src/shared/snapshot-sync';
import type { Snapshot } from '../src/shared/types';

const directory = process.argv[process.argv.indexOf('--data-dir') + 1];
if (!process.argv.includes('--data-dir') || !directory) throw new Error('Supply --data-dir explicitly.');
const db = new DatabaseSync(path.join(path.resolve(directory), 'airoom.sqlite'), { readOnly: true });
const list = (entity: string) => (db.prepare('SELECT value FROM entities WHERE entity=?').all(entity) as { value: string }[]).map(row => JSON.parse(row.value));
const projects = list('projects'), sessions = list('sessions'), runs = list('runs');
const speaking = new Set(list('room_messages').filter(message => message.status === 'speaking').map(message => message.runId));
const active = runs.filter(run => speaking.has(run.id) || !run.completedAt && ['queued', 'running', 'waiting_user', 'stopping', 'rate_limited'].includes(run.status)).map(run => run.id);
const events = (active.length ? db.prepare('SELECT value FROM events WHERE run_id IN (SELECT value FROM json_each(?)) ORDER BY sequence').all(JSON.stringify(active)) : []) as { value: string }[];
const totalEvents = Number((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n);
// Persisted primary collections represent the real daily data scale. Computed
// flow/attention/provider views are omitted; do not label this an exact Engine snapshot.
const base = {
  projects, sessions, runs, events: events.map(row => JSON.parse(row.value)),
  approvals: list('approvals'), collaborations: list('collaborations'),
  members: list('members'), executors: list('executors'), providers: [], rooms: [],
  settings: list('settings')[0] ?? {}, profile: list('profile')[0] ?? {},
  dataDirectory: directory, backendReady: true, deepseekKeyConfigured: false,
} as Snapshot;
db.close();
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const publisher = new SnapshotPublisher('read-only-benchmark');
const first = publisher.publish(base)!;
let current = publisher.current!;
const timings: number[] = [], sizes: number[] = [], ipcTimes: number[] = [], fullTimes: number[] = [];
const { port1, port2 } = new MessageChannel();
port2.on('message', value => port2.postMessage(value));
try {
  for (let index = 0; index < 100; index++) {
    const next = { ...base, projects: base.projects.map((project, i) => i ? project : { ...project, name: `benchmark-${index}` }) };
    if (!next.projects.length) throw new Error('Benchmark needs at least one persisted project.');
    const fullStarted = performance.now(); JSON.stringify({ type: 'snapshot', snapshot: next }); fullTimes.push(performance.now() - fullStarted);
    const started = performance.now(), patch = publisher.publish(next)!;
    const encoded = JSON.stringify(patch);
    if (patch.type !== 'snapshot-patch') throw new Error('Expected a patch.');
    current = applySnapshotPatch(current, patch)!;
    if (!current || current.projects[0].name !== `benchmark-${index}`) throw new Error('Patch lost a change.');
    timings.push(performance.now() - started); sizes.push(Buffer.byteLength(encoded));
    const sent = performance.now();
    await new Promise<void>(resolve => { port1.once('message', () => resolve()); port1.postMessage(patch); });
    ipcTimes.push(performance.now() - sent);
  }
  console.log(JSON.stringify({
    scope: 'Read-only persisted primary collections; computed Engine views omitted. Node MessageChannel is a transport proxy, not Electron paint latency.',
    counts: { projects: projects.length, sessions: sessions.length, runs: runs.length, historicalEvents: totalEvents, activeEvents: events.length },
    fullBytes: bytes(first), patchBytes: { min: Math.min(...sizes), max: Math.max(...sizes) },
    diffSerializeApplyMs: { p50: percentile(timings, .5), p95: percentile(timings, .95) },
    fullSerializeMs: { p50: percentile(fullTimes, .5), p95: percentile(fullTimes, .95) },
    nodeMessageRoundTripMs: { p50: percentile(ipcTimes, .5), p95: percentile(ipcTimes, .95) },
    iterations: timings.length,
  }, null, 2));
} finally { port1.close(); port2.close(); }
