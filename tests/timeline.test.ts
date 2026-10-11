import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantText, memberQuestions, prettyCommand, supplements, thinkingSeconds, thinkingSegments } from '../src/renderer/timeline';
import type { TimelineEvent } from '../src/shared/types';

let sequence = 0;
const event = (kind: TimelineEvent['kind'], text: string, seconds: number, data?: unknown): TimelineEvent => ({
  id: String(++sequence), runId: 'r', sessionId: 's', provider: 'claude', kind, text, data, fidelity: 'native',
  at: new Date(Date.UTC(2026, 9, 3, 12, 0, seconds)).toISOString(),
});

test('member output excludes the user input the engine records as a message event', () => {
  const events = [event('message', '请看一下 README', 0, { role: 'user' }), event('delta', '项目代号是青石。', 3)];
  assert.equal(assistantText(events), '项目代号是青石。');
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

test('answer chunks separated by tool work become separate paragraphs', () => {
  const events = [event('delta', '我先看看目录。', 0), event('tool', '调用：Read', 1), event('delta', '## 结果', 2), event('delta', '\n一切正常。', 3)];
  assert.equal(assistantText(events), '我先看看目录。\n\n## 结果\n一切正常。');
});

test('supplements, structured questions and wrapped commands are recognised', () => {
  const events = [
    event('message', '原任务', 0, { role: 'user' }), event('message', '测试放在 tests/', 5, { role: 'user' }),
    event('message', '要加校验吗？', 6, { type: 'agentMessage', questions: [{ title: '要加校验吗？', options: ['要', '不要'] }] }),
    event('delta', '等你回答。', 7),
  ];
  assert.deepEqual(supplements(events).map(item => item.text), ['测试放在 tests/']);
  assert.deepEqual(memberQuestions(events), [{ title: '要加校验吗？', options: ['要', '不要'] }]);
  assert.equal(assistantText(events), '等你回答。', 'the question is shown as its own card, not repeated in the answer');
  assert.equal(prettyCommand('"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command \'git status\''), 'git status');
  assert.equal(prettyCommand('"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command Get-ChildItem'), 'Get-ChildItem');
  assert.equal(prettyCommand('ls -la'), 'ls -la');
});

test('thinking time runs from the start of the turn to the first answer', () => {
  const start = new Date(Date.UTC(2026, 9, 3, 11, 59, 50)).toISOString();
  const events = [event('reasoning', '想一想', 0), event('delta', '好了', 4)];
  assert.equal(thinkingSeconds(start, events), 14);
  // Codex delivers its summary only after thinking; the turn start still anchors the count.
  assert.equal(thinkingSeconds(start, [event('reasoning', '摘要', 1)], Date.parse(start) + 60_000), 12);
});

test('deltas from different native messages are separate paragraphs', () => {
  const events = [event('delta', '口令是青石。', 0, { itemId: 'a' }), event('message', '要加注释吗？', 1, { questions: [{ title: '要加注释吗？' }] }), event('delta', '已发起', 2, { itemId: 'b' }), event('delta', '提问。', 3, { itemId: 'b' })];
  assert.equal(assistantText(events), '口令是青石。\n\n已发起提问。');
});
