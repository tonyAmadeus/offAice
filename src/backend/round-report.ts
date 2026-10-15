import type { Evidence, RoundReport, Task, Integration, Round } from '../shared/project-flow';
import type { ReportSystemNote } from '../shared/round-results';
import { commandEvidenceProblem } from '../shared/project-flow-review';

/** Facts are generated from persisted evidence; prose never upgrades a verification result. */
export function presentRoundReport(report: RoundReport, round: Round, integration: Integration, tasks: Task[], evidence: Evidence[]): RoundReport {
  const notes: ReportSystemNote[] = [];
  const unverified = integration.reviewLevel === 'low' && !integration.checkRunId || Boolean(round.manualAcceptance);
  if (tasks.some(t => t.reviewSkipped === 'configured')) notes.push({ kind: 'review-skipped', text: '个人任务按配置省略单独复核。' });
  if (unverified) notes.push({ kind: 'unverified', text: '本轮 AI 复核尚未通过，由你查看成品后决定。' });
  for (const criterion of integration.deferredUserCriteria ?? []) notes.push({ kind: 'user-check', text: '需要你确认：' + criterion });
  for (const e of evidence) {
    if (e.kind !== 'command') continue;
    const problem = commandEvidenceProblem(e);
    if (problem === 'failed-execution' || problem === 'exit-code-mismatch') notes.push({ kind: 'evidence-conflict', text: `检查结果需核对：${e.description}；成员说明与实际执行记录不一致。`, eventIds: e.eventIds });
    if (e.source === 'observed' && e.exitCodeSource === 'reported' && e.exitCode !== undefined) notes.push({ kind: 'exit-code', text: `退出码未核实：${e.description}；成员填写 ${e.exitCode}，` + (e.observedExitCode !== undefined ? `原生记录为 ${e.observedExitCode}。` : e.executionStatus === 'failed' ? '原生记录显示执行失败，但未提供退出码。' : '原生记录确认命令已完成，但未提供退出码。'), eventIds: e.eventIds });
  }
  const conflict = notes.some(n => n.kind === 'evidence-conflict');
  const uncertainCode = notes.some(n => n.kind === 'exit-code');
  const numericClaim = /退出码|exit\s*code/i;
  const fallback = `本轮已提交：${tasks.map(t => t.title).join('、')}。下面可以查看本轮文件；检查中的待确认事项列在验证细节中。`;
  return { ...report,
    summary: conflict || uncertainCode && numericClaim.test(report.summary) ? fallback : report.summary,
    validationSummary: (round.manualAcceptance?.ownerNote ? '用户实测/反馈：'+round.manualAcceptance.ownerNote+'\n\n' : '') + (conflict ? '检查说明与实际记录存在差异，请按下方提示核对。' : uncertainCode && numericClaim.test(report.validationSummary) ? '检查已留下记录，部分退出码没有得到确认。' : report.validationSummary),
    systemNotes: notes.filter((n, i) => notes.findIndex(other => other.kind === n.kind && other.text === n.text) === i),
  };
}
