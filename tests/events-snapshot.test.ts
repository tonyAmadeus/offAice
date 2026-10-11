import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/backend/store';
import { Engine } from '../src/backend/engine';
import type { RoomMessage, Run, Session, TimelineEvent } from '../src/shared/types';

const at = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString();
function run(id: string, sessionId: string, status: Run['status'], done: boolean): Run {
  return { id, sessionId, projectId: 'p', provider: 'claude', revision: 1, status, input: '任务', createdAt: at(0), updatedAt: at(0), bootId: 'b', delivery: 'confirmed', ...(done ? { completedAt: at(1) } : {}) };
}
const event = (id: string, runId: string, sessionId: string, n: number, data?: unknown): TimelineEvent => ({ id, runId, sessionId, provider: 'claude', at: at(n), kind: data ? 'status' : 'delta', text: `第 ${n} 段输出 `.repeat(8), data, fidelity: 'native' });

test('snapshots carry live events and the latest usage only; full session history loads on demand', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'airoom-events-'));
  let store: Store | undefined;
  try {
    store = new Store(directory);
    // 40 finished sessions with 250 events each, one running turn, and usage reports along the way.
    let n = 0;
    for (let s = 0; s < 40; s++) {
      const sessionId = `s${s}`, runId = `r${s}`;
      store.put('sessions', sessionId, { id: sessionId, projectId: 'p', provider: 'claude', title: 't', createdAt: at(0), updatedAt: at(0), revision: 1, writeMode: true } satisfies Session);
      store.put('runs', runId, run(runId, sessionId, 'ended', true));
      for (let e = 0; e < 250; e++) store.appendEvent(event(`${runId}-e${e}`, runId, sessionId, ++n, e === 100 ? { rateLimit: { status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: s / 100 } } } } : undefined));
    }
    store.put('runs', 'live', run('live', 's0', 'running', false));
    for (let e = 0; e < 5; e++) store.appendEvent(event(`live-e${e}`, 'live', 's0', ++n));
    const started = performance.now();
    const snapshot = store.snapshot();
    const elapsed = performance.now() - started;
    assert.deepEqual(snapshot.events.map(item => item.id), ['r39-e100', 'live-e0', 'live-e1', 'live-e2', 'live-e3', 'live-e4'], 'only the newest usage report and the running turn');
    assert.equal(store.listEvents('s7').length, 250, 'a finished session still has its full record on demand');
    const full = JSON.stringify(store.listEvents()).length, sent = JSON.stringify(snapshot).length;
    assert.ok(sent < full / 50, `snapshot shrank from about ${full} to ${sent} bytes`);
    assert.ok(elapsed < 250, `snapshot took ${elapsed.toFixed(1)} ms`);
    console.log(`events: ${n}; full event list ${(full / 1024).toFixed(0)} KiB vs snapshot ${(sent / 1024).toFixed(1)} KiB; snapshot built in ${elapsed.toFixed(1)} ms`);
    store.close(); store = undefined;
    // After a restart the usage report is found again from the database.
    const reopened = new Store(directory);
    try { assert.deepEqual(reopened.snapshot().events.map(item => item.id), ['r39-e100', 'live-e0', 'live-e1', 'live-e2', 'live-e3', 'live-e4']); } finally { reopened.close(); }
  } finally { store?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('session.events returns a session record and rejects unknown sessions', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'airoom-events-engine-'));
  const engine = new Engine(path.join(directory, 'data'), () => {}, () => {});
  try {
    const project = await engine.invoke('project.create', { directory: await fs.mkdtemp(path.join(directory, 'p-')) }) as { id: string };
    const session = engine.createSession(project.id, 'claude');
    engine.store.appendEvent(event('x1', 'r', session.id, 1));
    assert.deepEqual((await engine.invoke('session.events', { sessionId: session.id }) as TimelineEvent[]).map(item => item.id), ['x1']);
    await assert.rejects(engine.invoke('session.events', { sessionId: 'missing' }), /不存在/);
  } finally { await engine.close(); await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); }
});

test('room reply events survive native completion until the same message commits its final body',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'airoom-events-room-finish-'));
  const store=new Store(directory);
  try{
    const threadId=store.currentRoomThread().id;
    for(const status of ['ended','stopped','unknown'] as const){
      const id=`reply-${status}`,runId=`run-${status}`;
      store.put('runs',runId,run(runId,'s','running',false));
      const message:RoomMessage={id,threadId,author:'claude',text:'',status:'speaking',at:at(0),runId};
      store.put('room_messages',id,message);
      store.appendEvent({...event(`${id}-text`,runId,'s',1),text:'同一条回复的生成内容'});
      assert.equal(store.snapshot().events.filter(e=>e.runId===runId).length,1);
      store.put('runs',runId,run(runId,'s',status,true));
      assert.equal(store.snapshot().events.filter(e=>e.runId===runId).length,1,`${status}: no blank frame between native and room completion`);
      const done={...message,status:status==='ended'?'done':status==='stopped'?'stopped':'failed',text:status==='ended'?'同一条回复的生成内容':''} satisfies RoomMessage;
      store.put('room_messages',id,done);
      assert.equal(store.snapshot().events.filter(e=>e.runId===runId).length,0,'committed room messages do not retain their live event payload');
      assert.equal(store.roomMessages().filter(m=>m.runId===runId).length,1,'one persisted message per reply');
    }
  }finally{store.close();await fs.rm(directory,{recursive:true,force:true});}
});
