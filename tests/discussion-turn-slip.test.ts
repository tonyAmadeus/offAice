import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiscussionReply } from '../src/shared/discussion';

const turn = 'd0e00ccc-48df-4450-8bc9-569703eee85c';
const reply = (fields: Record<string, unknown>) => JSON.stringify({ version: 1, turn, revision: 7, action: 'speak', body: 'hi', ...fields });

test('a reply whose turn id has a few miscopied characters is accepted with a warning', () => {
  // The exact slip GPT made on 2026-11-22: two characters in the middle.
  const parsed = parseDiscussionReply(reply({ turn: 'd0e00ccc-48df-4450-8da9-569703eee85c' }), turn, 7);
  assert.equal(parsed.turn, turn);
  assert.equal(parsed.formatWarnings?.length, 1);
  assert.equal(parseDiscussionReply(reply({}), turn, 7).formatWarnings?.length, 0);
});

test('a reply for another turn or revision is still refused', () => {
  const refused = (fields: Record<string, unknown>) => assert.throws(() => parseDiscussionReply(reply(fields), turn, 7), /不符/);
  refused({ turn: '72a8d751-dcfb-41e8-9532-51279416c8ea' }); // a different turn
  refused({ turn: 'd0e00ccc-48df-4450-8da9-569703eee85c', revision: 6 }); // right turn, old revision
  refused({ turn: 'd0e00ccc' + 'x'.repeat(28) }); // matching start, the rest made up
  refused({ turn: 'd0e00ccc-48df-4450-9635-6c12819e9b3b' }); // more than 4 characters wrong
});
