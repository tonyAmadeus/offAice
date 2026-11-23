import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProjectIdle, assertProjectSerial } from '../src/backend/project-access';
import { captureFlowDiscussion } from '../src/backend/project-flow-discussion';
import type { Store } from '../src/backend/store';

test('a draft does not occupy the execution scope, but a confirmed round still does', () => {
  const projects = ['a', 'b'].map(id => ({ id, name: id, directory: process.cwd() }));
  const flow = { projectId: 'a', status: 'planning', currentRoundId: undefined as string | undefined };
  const store = {
    get: (_: string, id: string) => projects.find(project => project.id === id),
    list: (table: string) => table === 'projects' ? projects : table === 'project_flows' ? [flow] : [],
  } as unknown as Store;
  assert.doesNotThrow(() => assertProjectSerial(store, 'b'));
  assert.throws(() => assertProjectIdle(store, 'a'), { code: 'PROJECT_ACTIVE' });
  flow.status = 'awaiting_plan';
  assert.doesNotThrow(() => assertProjectSerial(store, 'b'));
  flow.status = 'active';
  assert.throws(() => assertProjectSerial(store, 'b'), { code: 'PROJECT_DIRECTORY_BUSY' });
  flow.status = 'planning';
  flow.currentRoundId = 'existing-round';
  assert.throws(() => assertProjectSerial(store, 'b'), { code: 'PROJECT_DIRECTORY_BUSY' });
});

test('long planning discussion retains the summary and latest message without altering chat', () => {
  const latest = 'latest requirement';
  const messages = [
    { id: 'old', author: 'user', text: 'x'.repeat(70000) },
    { id: 'new', author: 'user', text: latest },
  ];
  const store = {
    currentRoomThread: () => ({ id: 'thread', summary: { text: 'Existing summary' } }),
    allRoomMessages: () => messages,
    roomState: () => ({}),
  } as unknown as Store;
  const draft = captureFlowDiscussion(store, 'a', {});
  assert.equal(draft.background, 'Existing summary');
  assert.deepEqual(draft.messages.map(message => message.text), [latest]);
  assert.ok(draft.contextLimitNote);
  assert.ok(JSON.stringify(draft).length <= 60000);
  assert.equal(messages[0].text.length, 70000);
  messages[1].text = '\\'.repeat(70000);
  assert.ok(JSON.stringify(captureFlowDiscussion(store, 'a', {})).length <= 60000);
});
