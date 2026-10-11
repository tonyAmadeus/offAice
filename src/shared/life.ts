import type { MemberProfile, MemberRelation, RoutinePeriod } from './types';

/** The four parts of a day a member's routine describes; hours are local and `night` wraps past midnight. */
export const ROUTINE_PERIODS: { id: RoutinePeriod; label: string; from: number; to: number; example: string }[] = [
  { id: 'morning', label: '早上', from: 6, to: 11, example: '泡一壶茶，翻翻新闻' },
  { id: 'afternoon', label: '白天', from: 11, to: 17, example: '埋头干活，偶尔起来伸个懒腰' },
  { id: 'evening', label: '傍晚', from: 17, to: 22, example: '整理今天的笔记' },
  { id: 'night', label: '深夜', from: 22, to: 6, example: '该睡了，或者窝着看书' },
];
export const QUIRKS_MAX = 8, QUIRK_LIMIT = 40, ROUTINE_LIMIT = 60, RELATION_LIMIT = 120;

/** Which part of the day a local hour falls in. */
export function routinePeriod(hour: number): RoutinePeriod {
  return ROUTINE_PERIODS.find(period => period.from < period.to ? hour >= period.from && hour < period.to : hour >= period.from || hour < period.to)!.id;
}

const text = (value: unknown, max: number) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';

/** Accept routine, quirks and relations from the renderer; empty values are dropped, sizes bounded. */
export function normalizeLife(source: Record<string, unknown>, selfId: string): Pick<MemberProfile, 'routine' | 'quirks' | 'relations'> {
  const routineSource = source.routine && typeof source.routine === 'object' ? source.routine as Record<string, unknown> : {};
  const routine = Object.fromEntries(ROUTINE_PERIODS.map(period => [period.id, text(routineSource[period.id], ROUTINE_LIMIT)]).filter(([, value]) => value)) as MemberProfile['routine'];
  const quirks = [...new Set((Array.isArray(source.quirks) ? source.quirks : []).map(item => text(item, QUIRK_LIMIT)).filter(Boolean))].slice(0, QUIRKS_MAX);
  const seen = new Set<string>();
  const relations = (Array.isArray(source.relations) ? source.relations : []).flatMap(item => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const memberId = typeof record.memberId === 'string' && /^[\w-]{1,64}$/.test(record.memberId) ? record.memberId : '';
    const value = text(record.text, RELATION_LIMIT);
    if (!memberId || memberId === selfId || !value || seen.has(memberId)) return [];
    seen.add(memberId); return [{ memberId, text: value } satisfies MemberRelation];
  });
  return { ...(routine && Object.keys(routine).length ? { routine } : {}), ...(quirks.length ? { quirks } : {}), ...(relations.length ? { relations } : {}) };
}

/** Relations to members still on the team, as persona lines; removed members are skipped. */
export function relationLines(member: MemberProfile, team: MemberProfile[]): string[] {
  return (member.relations ?? []).flatMap(relation => {
    const other = team.find(item => item.id === relation.memberId);
    return other ? [`- ${other.name}：${relation.text}`] : [];
  });
}
