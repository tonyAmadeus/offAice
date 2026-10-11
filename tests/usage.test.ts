import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { usageOf } from '../src/renderer/usage';
import type { TimelineEvent } from '../src/shared/types';

const event = (provider: TimelineEvent['provider'], data: unknown): TimelineEvent => ({ id: Math.random().toString(36), runId: 'r', sessionId: 's', provider, at: '2026-10-04T00:00:00Z', kind: 'status', text: '', data, fidelity: 'native' });

test('usage comes from the members\' own quota reports', () => {
  // Shapes recorded from real runs: Codex turn/completed rateLimits, Claude rate_limit_event.
  const codex = event('codex', { rateLimits: { limitId: 'codex', primary: { usedPercent: 23, windowDurationMins: 10080, resetsAt: 1791598471 } } });
  const claude = event('claude', { status: 'running', rateLimit: { status: 'allowed', resetsAt: 1791069000, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1791069000 } } } });
  assert.deepEqual(usageOf([codex, claude], 'codex'), { percent: 23, window: '本周', resetsAt: 1791598471, exhausted: false });
  assert.deepEqual(usageOf([codex, claude], 'claude'), { percent: 10, window: '5 小时', resetsAt: 1791069000, exhausted: false });
  assert.equal(usageOf([codex], 'dsh'), undefined);
  const rejected = event('claude', { rateLimit: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 5 } });
  assert.equal(usageOf([claude, rejected], 'claude')!.exhausted, true, 'the latest report wins');
});
