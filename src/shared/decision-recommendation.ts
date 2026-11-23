import type { Decision } from './project-flow';

export type DecisionRecommendation = { choice: string; why: string; memberId?: string; opinion?: string };

/** The button a non-programmer should press, from what the card already says. Only an option the card offers is ever named. */
export function recommendDecision(d: Pick<Decision, 'kind' | 'options' | 'reason'> & { eligibleMemberIds?: string[] }): DecisionRecommendation | undefined {
  const has = (choice: string | undefined) => choice !== undefined && d.options.includes(choice) ? choice : undefined;
  const pick = (part: string) => d.options.find(option => option.includes(part));
  const member = d.eligibleMemberIds?.[0], reason = d.reason ?? '';
  const done = (choice: string | undefined, why: string, extra: Partial<DecisionRecommendation> = {}) => choice ? { choice, why, ...extra } : undefined;
  if (d.kind === 'unresolved-review') {
    if (/文件不存在/.test(reason)) return done(has('我来判断'), '缺的是资料文件，换人检查也一样看不到', { opinion: '缺少需要的文件，这一项留到下一轮补上后再检查。' });
    if (/没有执行权限|额度用完/.test(reason)) return done(pick('换'), '换一位能执行的成员来检查', { memberId: member });
    if (/指令执行失败|→ 失败|超时/.test(reason)) return done(has('我来判断'), '指令实际跑失败了，需要修正', { opinion: '指令执行失败，请修正后再检查。' });
    if (/检查者没有说明/.test(reason)) return done(pick('重新'), '检查者可能没有实际执行，先再查一次');
    return done(pick('换'), '换一位成员再确认一次', { memberId: member });
  }
  if (d.kind === 'quota-wait') return done(has('换人接手'), '额度恢复可能要很久，换人比较快', { memberId: member });
  if (has('重新安排')) return done('重新安排', '按卡片上列出的问题再修一次', { memberId: member, opinion: '只修正上面列出未通过的项目，其他内容不要动。' });
  return undefined;
}
