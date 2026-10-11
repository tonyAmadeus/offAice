import type { RoundReport, Submission } from './project-flow';
import type { ReportSystemNote } from './round-results';

export const memberUserSummary = (submission: Pick<Submission, 'userSummary'|'summary'>) => submission.userSummary?.trim() || submission.summary;

/** Old reports remain unchanged on disk. Only recognized system lines move out of prose. */
export function reportForDisplay(report: RoundReport): RoundReport {
  if (report.systemNotes) return report;
  const notes: ReportSystemNote[]=[];
  function system(line:string) {
    const kind:ReportSystemNote['kind']|undefined=/^个人任务按配置/.test(line)?'review-skipped':/^(?:本轮 AI 复核|本轮成果未经)/.test(line)?'unverified':/^退出码未核实/.test(line)?'exit-code':/^留待用户验收/.test(line)?'user-check':undefined;
    if(!kind)return false;
    notes.push({kind,text:kind==='exit-code'?line.replace(/（[\s\S]*）；成员填写/,'；成员填写'):line});return true;
  }
  const validationSummary=report.validationSummary.split('\n').filter(line=>!system(line)).join('\n');
  const remainingIssues=report.remainingIssues.filter(line=>!system(line));
  return {...report,validationSummary,remainingIssues,systemNotes:notes};
}
