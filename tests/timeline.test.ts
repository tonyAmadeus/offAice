import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { prettyCommand, supplements, thinkingSegments } from '../src/renderer/timeline';
import type { TimelineEvent } from '../src/shared/types';

let sequence = 0;
const event = (kind: TimelineEvent['kind'], text: string, seconds: number, data?: unknown): TimelineEvent => ({
  id: String(++sequence), runId: 'r', sessionId: 's', provider: 'claude', kind, text, data, fidelity: 'native',
  at: new Date(Date.UTC(2026, 9, 3, 12, 0, seconds)).toISOString(),
});


test('streamed reasoning chunks merge into segments split by other activity', () => {
  const events = [
    event('reasoning', '先读 ', 0), event('reasoning', 'README。', 2), event('tool', '调用：Read', 4),
    event('reasoning', '', 5), event('reasoning', '再看 src。', 6), event('delta', '答案', 9),
  ];
  const result = thinkingSegments(events);
  assert.deepEqual(result.segments, ['先读 README。', '再看 src。']);
  assert.equal(result.seconds, 9); // first reasoning → first event after the last segment
});

test('no reasoning means no thinking block', () => {
  assert.deepEqual(thinkingSegments([event('delta', 'x', 0)]), { segments: [], seconds: 0 });
});


test('supplements, structured questions and wrapped commands are recognised', () => {
  const events = [
    event('message', '原任务', 0, { role: 'user' }), event('message', '测试放在 tests/', 5, { role: 'user' }),
    event('message', '要加校验吗？', 6, { type: 'agentMessage', questions: [{ title: '要加校验吗？', options: ['要', '不要'] }] }),
    event('delta', '等你回答。', 7),
  ];
  assert.deepEqual(supplements(events).map(item => item.text), ['测试放在 tests/']);
  assert.equal(prettyCommand('"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command \'git status\''), 'git status');
  assert.equal(prettyCommand('"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command Get-ChildItem'), 'Get-ChildItem');
  assert.equal(prettyCommand('ls -la'), 'ls -la');
});


