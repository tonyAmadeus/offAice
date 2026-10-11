import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { byActivity } from '../src/renderer/session-order';
import type { Run, Session } from '../src/shared/types';

const session = (id: string, createdAt: string, updatedAt = createdAt): Session => ({ id, projectId: 'p', provider: 'claude', title: id, createdAt, updatedAt, revision: 1, writeMode: false });
const run = (sessionId: string, updatedAt: string): Run => ({ id: `${sessionId}-${updatedAt}`, sessionId, projectId: 'p', provider: 'claude', revision: 1, status: 'ended', input: 'x', createdAt: updatedAt, updatedAt, bootId: 'b', delivery: 'confirmed' });

test('sessions are ordered by their latest activity, newest first', () => {
  const sessions = [
    session('renamed-yesterday', '2026-10-01T00:00:00Z', '2026-10-05T09:00:00Z'), // renamed today, last talked to on Oct 2
    session('talked-today', '2026-10-01T00:00:00Z'),
    session('new-and-empty', '2026-10-04T00:00:00Z'),
  ];
  const runs = [run('renamed-yesterday', '2026-10-02T00:00:00Z'), run('talked-today', '2026-10-03T00:00:00Z'), run('talked-today', '2026-10-05T08:00:00Z')];
  assert.deepEqual(byActivity(sessions, runs).map(item => item.id), ['talked-today', 'new-and-empty', 'renamed-yesterday']);
});
