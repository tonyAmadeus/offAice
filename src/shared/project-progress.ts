import type {ProjectFlow,Plan,Round,Task,Integration,Acceptance,PlanSummary,FlowRecord,VersionRef} from './project-flow';
export const PROGRESS_READS=['projectFlow.timeline','projectFlow.progress.detail'] as const;
export type ProgressSection='plans'|'rounds'|'tasks'|'results'|'acceptances';
export interface ProjectProgressCounts {
  flows:{total:number;active:number;completed:number;cancelled:number};
  allSaved:{plans:number;rounds:number;tasks:number;results:number;acceptances:number};
  latestPlans:{rounds:number;acceptedRounds:number;tasks:number;acceptedTasks:number;cancelledTasks:number};
}
export interface FlowTimelineItem {
  id:string;projectId:string;projectName?:string;projectPath?:string[];objective:string;status:ProjectFlow['status'];dispatchMode:ProjectFlow['dispatchMode'];
  createdAt:string;updatedAt:string;leadMemberId:string;leadName:string;stage:string;
  plan?:PlanSummary;adoptedPlanId?:string;adoptedPlanVersion?:number;planCount:number;rounds:{total:number;accepted:number};tasks:{total:number;accepted:number;cancelled:number};
  resultCount:number;resultVersions?:{integrationId:string;roundId:string;sequence:number;status:Integration['status'];version:VersionRef}[];lastAcceptedAt?:string;reportSummary?:string;
}
export interface FlowTimelinePage {
  projectId:string;projectIds?:string[];includeChildren?:boolean;scope:string;countScope:string;capturedAt:string;counts:ProjectProgressCounts;
  items:FlowTimelineItem[];total:number;hasMore:boolean;cursor?:string;
}
export interface FlowProgressDetail {
  projectId:string;flowId:string;section:ProgressSection;scope:string;total:number;hasMore:boolean;cursor?:string;
  items:(Plan|Round|Task|Integration|Acceptance|UserChangeHistory)[];
}
export interface UserChangeHistory extends FlowRecord {recordedVia:'user-change';roundId:string;integrationId:string;actor:'user';opinion:string;status:'changes_requested';version?:VersionRef;appliedPaths:string[];conflictPaths:string[];acceptedAt?:string}
