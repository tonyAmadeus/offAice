import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMember, personaInstructions } from '../src/shared/defaults';
import { normalizeLife, routinePeriod } from '../src/shared/life';
import type { MemberProfile } from '../src/shared/types';

test('the day splits into four parts, and night wraps past midnight', () => {
  assert.deepEqual([5, 6, 10, 11, 16, 17, 21, 22, 23, 0].map(routinePeriod), ['night', 'morning', 'morning', 'afternoon', 'afternoon', 'evening', 'evening', 'night', 'night', 'night']);
});

test('routine, habits and relations are cleaned: empty and duplicate values dropped, none toward oneself', () => {
  const life = normalizeLife({
    routine: { morning: '  泡一壶茶  ', afternoon: '', night: 'x'.repeat(80), bogus: '不会保留' },
    quirks: ['转笔', '', '转笔', '托腮看窗外', 42],
    relations: [{ memberId: 'codex', text: '搭档' }, { memberId: 'codex', text: '重复' }, { memberId: 'claude', text: '自己' }, { memberId: '../x', text: '坏 id' }, { memberId: 'dsh', text: ' ' }],
  }, 'claude');
  assert.deepEqual(life.routine, { morning: '泡一壶茶', night: 'x'.repeat(60) });
  assert.deepEqual(life.quirks, ['转笔', '托腮看窗外']);
  assert.deepEqual(life.relations, [{ memberId: 'codex', text: '搭档' }]);
  assert.deepEqual(normalizeLife({}, 'claude'), {}, 'nothing set, nothing stored');
});

test('relations reach the persona with current names; routine and habits do not', () => {
  const team: MemberProfile[] = [
    normalizeMember({ id: 'claude', name: 'Claudia', routine: { morning: '翻书' }, quirks: ['转笔'], relations: [{ memberId: 'codex', text: '搭档，常互相吐槽' }, { memberId: 'm-gone', text: '已经离开的人' }] }),
    normalizeMember({ id: 'codex', name: 'Gptia' }),
  ];
  const persona = personaInstructions(team[0], { name: '阿潘' }, team);
  assert.match(persona, /你和团队里其他成员的关系（用户设定）：\n- Gptia：搭档，常互相吐槽/);
  assert.doesNotMatch(persona, /已经离开的人/);
  assert.doesNotMatch(persona, /翻书|转笔/, 'routine and habits are display data, not claims');
  assert.doesNotMatch(personaInstructions(team[0], { name: '阿潘' }), /关系/, 'without the team there are no names to show');
});
