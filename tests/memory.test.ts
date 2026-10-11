import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMember, personaInstructions } from '../src/shared/defaults';
import { MEMORY_TEXT_LIMIT, activeMemoryText, memoryEntries } from '../src/shared/memory';
import type { MemberProfile } from '../src/shared/types';

const profile = { name: '阿潘' };

test('a card saved with one memory text becomes one handwritten entry, and the text stays for older readers', () => {
  const card = normalizeMember({ id: 'claude', name: 'Claudia', memory: '  喜欢简洁的结论  ' });
  assert.equal(card.memories?.length, 1);
  assert.deepEqual({ text: card.memories![0].text, source: card.memories![0].source }, { text: '喜欢简洁的结论', source: 'manual' });
  assert.equal(card.memory, '喜欢简洁的结论');
  // A stored card from before entries existed is read the same way without being saved again.
  const legacy = { id: 'codex', executor: 'codex', name: 'Gptia', memory: '周末不讨论工作', createdAt: '2026-10-01T00:00:00.000Z' } as MemberProfile;
  assert.deepEqual(memoryEntries(legacy).map(entry => entry.text), ['周末不讨论工作']);
  assert.match(personaInstructions(legacy, profile), /长期记住的事：\n- 周末不讨论工作/);
  assert.equal(normalizeMember({ id: 'dsh', name: 'Deepseek' }).memories, undefined, 'no memory, no entries');
});

test('entries are cleaned: empty ones dropped, unknown sources made manual, duplicate ids replaced, switched-off ones never sent', () => {
  const card = normalizeMember({ id: 'claude', name: 'Claudia', memory: '旧文本会被条目取代', memories: [
    { id: 'a', text: '回答先给结论', source: 'manual', createdAt: '2026-10-02T08:00:00Z' },
    { id: 'a', text: '习惯用 TypeScript', source: 'imported', origin: 'Codex 记忆摘要' },
    { id: 'b', text: '  ', source: 'manual' },
    { id: 'c', text: '周末不讨论工作', source: 'whatever', off: true },
    'not an entry',
  ] });
  const entries = card.memories!;
  assert.deepEqual(entries.map(entry => entry.text), ['回答先给结论', '习惯用 TypeScript', '周末不讨论工作']);
  assert.equal(new Set(entries.map(entry => entry.id)).size, 3, 'ids stay unique');
  assert.deepEqual(entries.map(entry => entry.source), ['manual', 'imported', 'manual']);
  assert.equal(entries[1].origin, 'Codex 记忆摘要');
  assert.equal(entries[0].createdAt, '2026-10-02T08:00:00.000Z');
  assert.equal(card.memory, '回答先给结论\n习惯用 TypeScript', 'the joined text holds only entries that are on');
  const persona = personaInstructions(card, profile);
  assert.match(persona, /- 回答先给结论\n- 习惯用 TypeScript/);
  assert.doesNotMatch(persona, /周末不讨论工作/);
  // Deleting every entry clears the memory instead of falling back to the old text.
  const cleared = normalizeMember({ id: 'claude', name: 'Claudia', memory: '旧文本', memories: [] });
  assert.deepEqual(cleared.memories, []);assert.equal(cleared.memory, undefined);
  assert.doesNotMatch(personaInstructions(cleared, profile), /长期记住/);
});

test('oversized memory is refused rather than cut, but switched-off entries do not count', () => {
  const long = 'x'.repeat(1900);
  const many = Array.from({ length: 5 }, (_, index) => ({ id: `m${index}`, text: long + index, source: 'manual' }));
  assert.throws(() => normalizeMember({ id: 'claude', name: 'Claudia', memories: many }), /合计超过/);
  const card = normalizeMember({ id: 'claude', name: 'Claudia', memories: many.map((entry, index) => index === 4 ? { ...entry, off: true } : entry) });
  assert.ok(activeMemoryText(card.memories!).length <= MEMORY_TEXT_LIMIT);
  assert.throws(() => normalizeMember({ id: 'claude', name: 'Claudia', memories: [{ text: 'y'.repeat(2001) }] }), /每条长期记忆最多/);
});
