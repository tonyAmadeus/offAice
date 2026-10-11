export interface DiscussionCallLimit {
  mode: 'unlimited' | 'per-member' | 'custom';
  calls: number;
}
export interface DiscussionCallLimits {
  chat: DiscussionCallLimit;
  work: DiscussionCallLimit;
}
export const DEFAULT_DISCUSSION_LIMITS: DiscussionCallLimits = {
  chat: {mode:'unlimited', calls:8},
  work: {mode:'per-member', calls:8},
};
/** Persist only valid choices; omitted settings from older installations use the new defaults. */
export function discussionCallLimits(raw:unknown): DiscussionCallLimits {
  const source=raw as Partial<DiscussionCallLimits>|undefined;
  const result={} as DiscussionCallLimits;
  for(const style of ['chat','work'] as const){
    const choice=source?.[style]??DEFAULT_DISCUSSION_LIMITS[style];
    if(!choice||!['unlimited','per-member','custom'].includes(choice.mode)||!Number.isInteger(choice.calls)||choice.calls<1||choice.calls>1000)
      throw new Error('调用次数请选择默认、无限制，或填写 1–1000 的整数。');
    result[style]={mode:choice.mode,calls:choice.calls};
  }
  return result;
}
export function discussionAllowance(style:'chat'|'work',members:number,raw?:DiscussionCallLimits){
  const choice=discussionCallLimits(raw)[style];
  return choice.mode==='unlimited'?0:choice.mode==='per-member'?members*2:choice.calls;
}
