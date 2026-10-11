import type { TimelineEvent } from '../shared/types';

export interface Usage { percent: number; window: string; resetsAt?: number; exhausted: boolean }
const windowName = (minutes?: number, type?: string) => type === 'seven_day' || (minutes ?? 0) >= 10080 ? '本周' : type === 'five_hour' || minutes === 300 ? '5 小时' : (minutes ?? 0) >= 1440 ? '今日' : minutes ? `${Math.round(minutes / 60)} 小时` : '当前窗口';
/** Latest quota usage a member reported (Codex rateLimits, Claude rate_limit_event); undefined when none arrived yet. */
export function usageOf(events: TimelineEvent[], provider: string): Usage | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.provider !== provider || !event.data || typeof event.data !== 'object') continue;
    const data = event.data as { rateLimits?: { primary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } }; rateLimit?: { status?: string; rateLimitType?: string; resetsAt?: number; unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> } };
    const primary = data.rateLimits?.primary;
    if (primary && typeof primary.usedPercent === 'number') return { percent: Math.round(primary.usedPercent), window: windowName(primary.windowDurationMins), resetsAt: primary.resetsAt, exhausted: primary.usedPercent >= 100 };
    const limit = data.rateLimit;
    if (limit) {
      const current = limit.rateLimitType ? limit.unifiedWindows?.[limit.rateLimitType] : undefined;
      if (typeof current?.utilization === 'number') return { percent: Math.round(current.utilization * 100), window: windowName(undefined, limit.rateLimitType), resetsAt: current.resetsAt ?? limit.resetsAt, exhausted: limit.status === 'rejected' };
      if (limit.status === 'rejected') return { percent: 100, window: windowName(undefined, limit.rateLimitType), resetsAt: limit.resetsAt, exhausted: true };
    }
  }
}
export const resetText = (seconds?: number) => seconds ? `，${new Date(seconds * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} 重置` : '';
