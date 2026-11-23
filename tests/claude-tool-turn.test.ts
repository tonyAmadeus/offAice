import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAdapter } from '../src/backend/adapters/claude';

// Frames in the order Claude Code 2.1.292 and 2.1.330 send them for a turn that uses one tool:
// only the first message carries the user UUID; the message after the tool result does not.
function reusedTurn() {
  const adapter: any = new ClaudeAdapter();
  const warnings: string[] = [], messages: string[] = [];
  adapter.context = { emit: (kind: string, text: string) => { if (kind === 'warning') warnings.push(text); if (kind === 'message') messages.push(text); }, markDelivery() {}, recordRuntime() {}, recordConfig() {}, recordTiming() {}, persistNativeSession() {} };
  adapter.closeTransport = async () => { warnings.push('closed'); };
  Object.assign(adapter, { strictTurn: true, inputUuid: 'turn-1', nativeSessionId: 's' });
  const send = (frame: any) => adapter.event({ session_id: 's', ...frame });
  send({ type: 'user', uuid: 'turn-1', parent_tool_use_id: null, message: { content: 'hi' } });
  send({ type: 'stream_event', user_message_uuid: 'turn-1', event: { type: 'message_start', message: { id: 'm1' } } });
  send({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tool-1', name: 'Grep' } } });
  send({ type: 'assistant', user_message_uuid: 'turn-1', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tool-1', name: 'Grep', input: {} }] } });
  send({ type: 'stream_event', event: { type: 'message_stop' } });
  const toolResult = (id: string, extra: any = {}) => send({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'found', ...extra }] } });
  const untagged = (id: string, text: string, parent: string | null = null) => {
    send({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'message_start', message: { id } } });
    send({ type: 'assistant', parent_tool_use_id: parent, message: { id, content: [{ type: 'text', text }] } });
    send({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'message_stop' } });
  };
  return { adapter, send, warnings, messages, toolResult, untagged };
}

test('a reused Claude turn keeps going after its own tool result, also when the tool failed', () => {
  for (const extra of [{}, { is_error: true }]) {
    const t = reusedTurn();
    t.toolResult('tool-1', extra);
    t.untagged('m2', 'done');
    assert.deepEqual(t.warnings, []);
    assert.deepEqual(t.messages, ['done']);
  }
});

test('untagged messages without a matching tool result are still refused', () => {
  const foreign = reusedTurn();
  foreign.toolResult('someone-elses-tool');
  foreign.untagged('m2', 'stray');
  assert.ok(foreign.warnings.includes('closed'));

  // One tool result lets exactly one message through, not a second one.
  const second = reusedTurn();
  second.toolResult('tool-1');
  second.untagged('m2', 'done');
  second.untagged('m3', 'stray');
  assert.ok(second.warnings.includes('closed'));

  // A main-stream tool result does not let a subagent stream through.
  const subagent = reusedTurn();
  subagent.toolResult('tool-1');
  subagent.untagged('s1', 'stray', 'task-9');
  assert.ok(subagent.warnings.includes('closed'));

  // A frame naming several user messages is not treated as untagged.
  const several = reusedTurn();
  several.toolResult('tool-1');
  several.send({ type: 'stream_event', user_message_uuids: ['turn-0', 'turn-1'], event: { type: 'message_start', message: { id: 'm2' } } });
  several.send({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'stray' }] } });
  assert.ok(several.warnings.includes('closed'));
});

test('a tool result after the turn ended opens nothing', () => {
  const t = reusedTurn();
  t.send({ type: 'result', subtype: 'success', user_message_uuid: 'turn-1', result: '' });
  t.toolResult('tool-1');
  assert.equal(t.adapter.toolContinues.size, 0);
});
