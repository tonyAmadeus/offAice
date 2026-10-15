import { criterionText, type PlanPayload } from './project-flow';

const lines = (items: readonly (string | Parameters<typeof criterionText>[0])[]) => items.map(item => typeof item === 'string' ? item : criterionText(item)).join('\n');

/** What a revised plan changed against the version it replaces, in plain words: plan level first, then each task. */
export function planChanges(previous: PlanPayload, next: PlanPayload, name: (memberId: string) => string = id => id): string[] {
  const changes: string[] = [];
  if (previous.objective !== next.objective) changes.push('目标改了');
  if (previous.scope !== next.scope) changes.push('范围改了');
  if (lines(previous.deliverables) !== lines(next.deliverables)) changes.push('交付内容改了');
  if (lines(previous.acceptanceCriteria) !== lines(next.acceptanceCriteria)) changes.push('验收标准改了');
  if (previous.rounds.length !== next.rounds.length) changes.push(`轮次从 ${previous.rounds.length} 轮改成 ${next.rounds.length} 轮`);
  const before = new Map(previous.tasks.map(task => [task.key, task]));
  for (const task of next.tasks) {
    const old = before.get(task.key);
    before.delete(task.key);
    if (!old) { changes.push(`新增任务「${task.title}」，交给 ${name(task.memberId)}`); continue; }
    const parts: string[] = [];
    if (old.title !== task.title) parts.push(`标题（原「${old.title}」）`);
    if (old.memberId !== task.memberId) parts.push(`负责成员（${name(old.memberId)} → ${name(task.memberId)}）`);
    if (old.roundKey !== task.roundKey) parts.push('所在轮次');
    if (old.goal !== task.goal) parts.push('目标');
    if (lines(old.allowedPaths) !== lines(task.allowedPaths)) parts.push(`可改文件（${old.allowedPaths.join('、') || '无'} → ${task.allowedPaths.join('、') || '无'}）`);
    if (lines(old.completionCriteria) !== lines(task.completionCriteria)) parts.push('完成标准');
    if (lines(old.dependencies) !== lines(task.dependencies)) parts.push('先后顺序');
    if (parts.length) changes.push(`「${task.title}」改了${parts.join('、')}`);
  }
  for (const task of before.values()) changes.push(`去掉任务「${task.title}」`);
  return changes;
}
