import type {Acceptance,CompletionCriterion,CriterionAssessment,FlowRecord,ReviewFinding,VersionRef} from './project-flow';
export const WORKBENCH_READS=['projectFlow.memberReports','projectFlow.record','projectFlow.round.report.export','projectFlow.task.proposal'] as const;
export const WORKBENCH_WRITES=['projectFlow.task.prepare','projectFlow.task.add','projectFlow.record.write'] as const;
export interface TaskAddition extends FlowRecord {
  planId:string;roundId:string;memberId:string;title:string;goal:string;completionCriteria:CompletionCriterion[];
  allowedPaths:string[];dependencies:string[];sourceMessageId?:string;source:'meeting'|'report'|'task-card';
  status:'preparing'|'ready'|'confirmed'|'scope-change'|'blocked';operationId?:string;taskId?:string;decisionId?:string;
  sourceRoundtable?:{topicId:string;conclusionId:string;messageId:string};
  expectedPlanRevision:number;confirmedAt?:string;error?:string;inScope?:boolean;scopeReason?:string;
}
export interface MemberReport {
  id:string;projectId:string;flowId:string;planId:string;roundId:string;memberId:string;memberName:string;role:'author'|'reviewer'|'lead';
  title:string;at:string;flowStatus:string;planStatus:string;roundStatus:string;summary:string[];
  tasks:{id:string;title:string;status:string;sessionId?:string;submissionId?:string;version?:VersionRef;files:string[]}[];
  checks:{id:string;taskId?:string;status:string;findings:ReviewFinding[];assessments:CriterionAssessment[];strengths:string[]}[];
  remaining:string[];next:string[];integrationId?:string;acceptances:Pick<Acceptance,'id'|'status'|'opinion'|'actor'>[];
}
export interface MemberReportPage {members:{id:string;name:string;historical:boolean;count:number}[];items:MemberReport[];total:number;hasMore:boolean;cursor?:string;scope:string}
export interface ProjectRecord {id:string;projectId:string;flowId:string;title:string;markdown:string;summary:string;generatedAt:string;status:string;receipt?:RecordReceipt}
export interface RecordReceipt {id:string;projectId:string;flowId:string;state:'prepared'|'written'|'failed';path:string;contentHash:string;updatedAt:string;error?:string}
