import { routinePeriod } from '../shared/life';
import type { MemberProfile, RoutinePeriod } from '../shared/types';

/** Small things anyone might be doing when the card says nothing about this part of the day. */
const EVERYDAY: Record<RoutinePeriod, string[]> = {
  morning: ['泡了杯茶', '在翻今天的新闻', '伸了个懒腰', '在给窗台的绿植浇水'],
  afternoon: ['在整理桌面', '翻着笔记', '起来倒了杯水', '在窗边发了会儿呆'],
  evening: ['在整理今天的笔记', '窝在沙发上', '看着窗外的晚霞', '在听歌'],
  night: ['窝着看书', '打了个哈欠', '准备休息了', '在台灯下写点东西'],
};
/** The scene changes every so often, not on every render. */
export const ACTIVITY_MINUTES = 20;

function hash(text: string) { let value = 2166136261; for (const char of text) { value ^= char.codePointAt(0)!; value = Math.imul(value, 16777619); } return value >>> 0; }

/** What an idle member is up to right now: their own routine for this part of the day, now and then one of their quirks,
 *  otherwise an everyday activity. Stable within a time slot and different between members; never touches any account. */
export function idleActivity(card: Pick<MemberProfile, 'id' | 'routine' | 'quirks'>, at: Date) {
  const period = routinePeriod(at.getHours()), slot = Math.floor(at.getTime() / (ACTIVITY_MINUTES * 60_000));
  const pick = hash(`${card.id}:${slot}`), quirks = card.quirks ?? [];
  if (quirks.length && pick % 4 === 0) return { period, text: quirks[(pick >>> 2) % quirks.length], source: 'quirk' as const };
  const routine = card.routine?.[period];
  if (routine) return { period, text: routine, source: 'routine' as const };
  const everyday = EVERYDAY[period];
  return { period, text: everyday[(pick >>> 2) % everyday.length], source: 'everyday' as const };
}
