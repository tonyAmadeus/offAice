import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_MINUTES, idleActivity } from '../src/renderer/life-status';

const at = (hour: number, minute = 0) => new Date(2026, 9, 6, hour, minute);
const SLOT = ACTIVITY_MINUTES * 60_000;

test('an idle member follows their own routine for the part of the day', () => {
  const card = { id: 'claude', routine: { morning: '泡一壶茶，翻翻新闻', night: '窝着看书' } };
  assert.deepEqual(idleActivity(card, at(8)), { period: 'morning', text: '泡一壶茶，翻翻新闻', source: 'routine' });
  assert.equal(idleActivity(card, at(2)).text, '窝着看书', 'night wraps past midnight');
  assert.equal(idleActivity(card, at(14)).source, 'everyday', 'a part of the day the card leaves empty falls back to everyday things');
});

test('the scene holds within a slot, changes over the day, differs between members, and quirks are occasional', () => {
  const card = { id: 'codex', quirks: ['转笔', '哼歌'] };
  const start = Math.floor(at(15, 7).getTime() / SLOT) * SLOT;
  assert.deepEqual(idleActivity(card, new Date(start)), idleActivity(card, new Date(start + SLOT - 60_000)), 'stable within a slot');
  const day = Array.from({ length: 72 }, (_, i) => idleActivity(card, new Date(at(0).getTime() + i * SLOT)));
  const quirks = day.filter(item => item.source === 'quirk').length;
  assert.ok(quirks > 0 && quirks < day.length / 2, `quirks are occasional (${quirks} of ${day.length})`);
  assert.ok(new Set(day.map(item => item.text)).size > 4, 'the day is not one line on repeat');
  const evening = (id: string) => Array.from({ length: 6 }, (_, i) => idleActivity({ id }, new Date(at(18).getTime() + i * SLOT)).text).join('|');
  assert.notEqual(evening('claude'), evening('dsh'), 'members are not in lockstep');
});
