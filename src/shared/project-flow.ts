import { RESULT_READS } from './round-results';
import { LOG_READS } from './work-log';
import {WORKBENCH_READS,WORKBENCH_WRITES,type TaskAddition} from './project-workbench';
import {PROGRESS_READS} from './project-progress';
import {JOINT_READS,JOINT_WRITES,type JointReview} from './joint-review';
import type { Artifact, RunStatus } from './types';

export const FLOW_LIMITS = { replyBytes: 128 * 1024, rounds: 20, tasks: 200, findings: 100, returns: 2, disputeReturnWaivers: 2, integrationFixes: 2 } as const;
export type ReviewLevel='high'|'medium'|'low';
export const REVIEW_LEVEL_LABELS:Record<ReviewLevel,string>={high:'深入复核：任务和每轮成果都核对',medium:'标准复核：只核对每轮汇总成果',low:'快速推进：每轮由我选择复核或验收'};
export const REVIEW_LEVEL_HINTS:Record<ReviewLevel,string>={
  high:'适合跨文件修改或需要充分验证的工作。每项任务及每轮汇总都安排复核，调用较多。',
  medium:'适合目标和验收条件清楚的常规工作。个人任务不逐项自动复核，每轮汇总后统一核对。',
  low:'适合试做、草稿和由你直接判断的工作。不自动安排例行复核，每轮汇总后由你选择检查或验收。',
};
export const reviewLevel=(flow:Pick<ProjectFlow,'reviewLevel'>):ReviewLevel=>flow.reviewLevel??'high';
export const roundLead=(flow:Pick<ProjectFlow,'leadMemberId'>,round?:Pick<Round,'leadMemberId'>)=>round?.leadMemberId??flow.leadMemberId;
export const roundReviewLevel=(flow:Pick<ProjectFlow,'reviewLevel'>,round?:Pick<Round,'reviewLevel'>):ReviewLevel=>round?.reviewLevel??reviewLevel(flow);
export interface FlowRecord { id:string; projectId:string; flowId:string; schemaVersion:1; revision:number; createdAt:string; updatedAt:string }
export interface AllowedAction { name:string; enabled:boolean; reason?:string }
export interface VersionRef { artifactId:string; fingerprint:string; baselineId:string }
export type CriterionKind='check'|'judge'|'owner';
export type CompletionCriterion=string|{text:string;kind:CriterionKind};
export const criterionText=(criterion:CompletionCriterion)=>typeof criterion==='string'?criterion:criterion.text;
export const criterionKind=(criterion:CompletionCriterion):CriterionKind=>typeof criterion==='string'?'check':criterion.kind;
export interface CriterionAssessment {criterion:string;rating:'meets'|'partly'|'not';reason:string}
export interface Evidence { kind:'command'|'quote'|'inspection'|'source'; description:string; command?:string; exitCode?:number; result:string; eventIds:string[]; source:'observed'|'reported' }
export interface Evidence {title?:string;location?:string;excerpt?:string;sourceVerification?:'unverified'|'verified'|'mismatch';sourceNote?:string}
export interface Evidence {exitCodeSource?:'observed'|'reported';observedExitCode?:number;executionStatus?:'completed'|'failed'}
export interface ReviewFinding { id:string; location:string; kind:'verified'|'suspected'|'suggestion'; severity:'blocking'|'should-fix'|'optional'; evidence:string; request:string;previousFindingId?:string;disposition?:'requires-fix'|'advice' }
export interface FindingCheck {findingId:string;resolved:boolean;evidence:string}
export interface Dispute {findingId:string;reason:string}
export interface DisputeRuling {findingId:string;verdict:'uphold-author'|'uphold-review'|'inconclusive';reason:string}
export interface DisputeReturnAccounting {refunded:boolean;used:number;limit:number}
export interface UserChangeRequest {id:string;integrationId:string;opinion:string;at:string;taskId?:string}
export interface RoundSpec { key:string; title:string; goal:string; requiresUserAcceptance:boolean;completionCriteria?:CompletionCriterion[];reviewLevel?:ReviewLevel }
export interface TaskSpec { key:string; roundKey:string; title:string; memberId:string; goal:string; inputs:string[]; completionCriteria:CompletionCriterion[]; dependencies:string[]; allowedPaths:string[];reviewerMemberId?:string;review?:boolean;reuse?:string }
export interface PlanPayload { objective:string; scope:string; deliverables:string[]; acceptanceCriteria:CompletionCriterion[]; rounds:RoundSpec[]; tasks:TaskSpec[] }
export interface FlowDiscussionContext { roomId:string; threadId:string; capturedAt:string; minutesMessageId?:string; background?:string; minutes?:{id:string;author:string;text:string}; messages:{id:string;author:string;text:string}[] }
export interface ProjectFlow extends FlowRecord { leadMemberId:string; memberIds:string[]; activePlanId?:string; roomId:string; threadId?:string; topic?:string; discussionContext?:FlowDiscussionContext; dispatchMode:'running'|'paused'|'stopping'; status:'planning'|'awaiting_plan'|'active'|'completed'|'cancelled'; blockedReasons:string[]; currentRoundId?:string }
export interface ProjectFlow {reviewLevel?:ReviewLevel}
export interface ProjectFlow {memberConfigs?:Record<string,import('./executor-config').RequestedRunConfig>}
export interface ProjectFlow {previousRecord?:{flowId:string;summary:string};memberNames?:Record<string,string>}
export interface ProjectFlow {sourceJointReviewId?:string}
export interface ProjectFlow {sourceRoundtable?:{topicId:string;conclusionId:string;messageId:string}}
export interface ProjectFlow {writeBoundary?:import('./types').WriteBoundary}
export interface Plan extends FlowRecord, PlanPayload { version:number; parentPlanId?:string; proposedByRunId?:string; status:'draft'|'awaiting_confirmation'|'confirmed'|'superseded'|'rejected'; notes:string[]; confirmedAt?:string; allowedActions?:AllowedAction[] }
export interface Plan {sourceJointReviewId?:string}
export interface Plan {sourceRoundtable?:ProjectFlow['sourceRoundtable']}
export type PlanSummary = Pick<Plan,'id'|'projectId'|'flowId'|'revision'|'version'|'parentPlanId'|'status'|'objective'|'scope'|'deliverables'|'createdAt'|'updatedAt'> & {roundCount:number;taskCount:number};
export interface RoundReport { summary:string; completedTaskKeys:string[]; deliverables:string[]; validationSummary:string; remainingIssues:string[]; nextRoundSummary:string; userDecisionNeeded:string }
export interface MeetingResponse {messageId:string;disposition:'noted'|'answered'|'in-scope-fix'|'scope-change'|'needs-user';summary:string;paths:string[];fixTaskId?:string;resolvedAt?:string}
export interface RoundReport {systemNotes?:import('./round-results').ReportSystemNote[];meetingResponses?:MeetingResponse[]}
export interface Round extends FlowRecord, RoundSpec { planId:string; index:number; taskIds:string[]; predecessorRoundId?:string; baseVersion?:VersionRef; integrationId?:string; acceptanceId?:string; integrationFixCount:number; report?:RoundReport; status:'pending'|'executing'|'integrating'|'checking'|'awaiting_acceptance'|'accepted'|'changes_requested'|'blocked'; allowedActions?:AllowedAction[] }
export interface Round {startedAt?:string;meetingReadIds?:string[];meetingHandledIds?:string[];meetingResponses?:MeetingResponse[];reportRunId?:string;reportedAt?:string}
export interface ManualRedo {decisionId:string;memberId:string;previousMemberId:string;opinion:string;at:string;status:'pending'|'passed'|'failed'}
export interface Round {leadMemberId?:string;requiresPeerReview?:boolean;peerReviewerMemberId?:string;manualRedos?:ManualRedo[];manualAcceptance?:{decisionId:string;reason:string};deferredUserCriteria?:string[]}
export interface Round {userChangeRequests?:UserChangeRequest[]}
export interface NextTaskAdjustment {taskId:string;goal?:string;inputs?:string[];completionCriteria?:CompletionCriterion[]}
export interface NextRoundRecommendation {mode:'as-planned'|'adjusted'|'replan';summary:string;taskAdjustments:NextTaskAdjustment[];completionCriteria?:CompletionCriterion[]}
export interface Round {nextConfirmation?:{previousRoundId:string;acceptanceId:string;status:'suggesting'|'ready'|'confirmed';recommendation?:NextRoundRecommendation;decisionId?:string;runId?:string;choice?:string}}
export type TaskStatus='pending'|'ready'|'queued'|'running'|'awaiting_review'|'correcting'|'review_passed'|'review_skipped'|'integrated'|'accepted'|'escalated'|'blocked'|'cancelled';
export interface Task extends FlowRecord, Omit<TaskSpec,'roundKey'> { planId:string; roundId:string; kind:'implementation'|'integration-fix'|'verification'; reviewerMemberId:string; sessionId?:string; activeRunId?:string; latestSubmissionId?:string; returnCount:number; rearrangeCount:number; earlyDecisionId?:string; startBase?:VersionRef; executionBase?:VersionRef; lastActivity?:{text:string;at:string}; status:TaskStatus; statusBeforeBlock?:TaskStatus; blockedReason?:string; originTaskId?:string; findingIds:string[]; allowedActions?:AllowedAction[] }
export interface TaskSupplement { id:string; requestId:string; text:string; createdAt:string; source:'task-card'|'meeting'|'report'; sourceMessageId?:string; requirementsRevision?:number; status:'pending'|'delivering'|'delivered'|'submitted'|'applied'|'unknown'|'awaiting_scope'|'dismissed'|'replanned'; delivery?:'current'|'next-turn'; deliveryOperationId?:string; deliveredRunId?:string; appliedRunId?:string; withdrawnSubmissionId?:string; decisionId?:string; requestedPaths:string[] }
export interface Task { requirementsRevision?:number; supplements?:TaskSupplement[] }
export interface Task {manualRedos?:ManualRedo[];reviewLevelAtSubmission?:ReviewLevel;reviewRequested?:boolean;reviewSkipped?:'configured'|'round-fix'}
export interface Task {userChangeRequestId?:string}
export interface Task {disputeReturnWaiverCount?:number}
export interface Task {reviewerChanges?:{previousMemberId:string;memberId:string;reason:string;at:string}[];reusedFromTaskId?:string}
export interface Task {effectiveReviewLevel?:ReviewLevel}
export interface Task {additionId?:string;sourceMessageId?:string;confirmedAt?:string}
export interface Round {effectiveReviewLevel?:ReviewLevel}
export interface Round {peerReviewerChanges?:{previousMemberId:string;memberId:string;reason:string;at:string}[]}
export interface FileChange { path:string; kind:'added'|'modified'|'deleted' }
export interface Submission extends FlowRecord { taskId:string; sequence:number; runId:string; sessionId:string; version:VersionRef; changes:FileChange[]; evidence:Evidence[]; completionResults?:CriteriaResult[]; outOfScopeChanges:FileChange[]; scopeExplanation?:string; summary:string; status:'capturing'|'submitted'|'superseded'|'stale'|'invalid'; changedFileCount?:number; evidenceCount?:number; outOfScopeCount?:number; allowedActions?:AllowedAction[] }
export interface Submission { userSummary?:string; requirementsRevision?:number; staleReason?:string }
export interface Submission {disputes?:Dispute[];disputeRulings?:DisputeRuling[];disputeRunId?:string;disputeDecisionId?:string}
export interface Submission {disputeReturnAccounting?:DisputeReturnAccounting}
export interface CriteriaResult { criterion:string; verified:boolean; evidence:string }
export interface ReviewPayload { verdict:'pass'|'changes_requested'|'inconclusive'; verificationComplete:boolean; criteriaResults:CriteriaResult[]; findings:Omit<ReviewFinding,'id'>[]; evidence:Evidence[];previousFindingChecks?:FindingCheck[] }
export interface ReviewPayload {assessments?:CriterionAssessment[];strengths?:string[]}
export interface SubmissionPayload { userSummary?:string; summary:string; evidence:Evidence[]; completionResults:CriteriaResult[]; outOfScopeExplanation?:string;disputes?:Dispute[] }
export interface Review extends FlowRecord { taskId:string; submissionId:string; reviewerMemberId:string; runId?:string; disposableArtifactId?:string; reviewedVersion:VersionRef; verdict?:ReviewPayload['verdict']; criteriaResults?:CriteriaResult[]; findings:ReviewFinding[]; evidence:Evidence[]; verificationComplete:boolean; staleReason?:string; status:'queued'|'running'|'passed'|'changes_requested'|'inconclusive'|'stale'|'blocked'; findingCounts?:Record<string,number>; allowedActions?:AllowedAction[] }
export interface Review { requirementsRevision?:number }
export interface Review {assessments?:CriterionAssessment[];strengths?:string[]}
export interface Integration {assessments?:CriterionAssessment[];strengths?:string[]}
export interface RequestedRoundCheck {assessments?:CriterionAssessment[];strengths?:string[]}
export interface Review {outcome?:ReviewPayload['verdict'];outcomeReasons?:string[];deferredUserCriteria?:string[]}
export interface Review {previousFindingChecks?:FindingCheck[];returnCounted?:boolean;returnWaivedBySubmissionId?:string}
export interface Integration extends FlowRecord { roundId:string; sequence:number; baseVersion:VersionRef; includedSubmissionIds:string[]; version?:VersionRef; workspaceArtifactId:string; checkRunId?:string; checkEvidence:Evidence[]; findings:ReviewFinding[]; conflicts:{path:string;reason:string}[]; status:'assembling'|'checking'|'ready'|'conflict'|'changes_requested'|'stale'|'blocked'|'accepted'; conflictCount?:number; checkSummary?:string; allowedActions?:AllowedAction[] }
export interface Integration {reviewLevel?:ReviewLevel;reviewChoice?:'lead'|'user';verdict?:ReviewPayload['verdict'];outcome?:ReviewPayload['verdict'];outcomeReasons?:string[];verificationComplete?:boolean;criteriaResults?:CriteriaResult[];deferredUserCriteria?:string[];peerReview?:{assessments?:CriterionAssessment[];strengths?:string[];memberId:string;runId:string;verdict:ReviewPayload['verdict'];outcome:ReviewPayload['verdict'];outcomeReasons:string[];criteriaResults:CriteriaResult[];findings:ReviewFinding[];evidence:Evidence[];verificationComplete:boolean}}
export interface Integration {previousFindingChecks?:FindingCheck[];advisoryFindings?:ReviewFinding[]}
export interface Integration {reportDraft?:RoundReport;draftMeetingIds?:string[];nextRoundDraft?:NextRoundRecommendation}
export interface RequestedRoundCheck extends FlowRecord {roundId:string;integrationId:string;memberId:string;version:VersionRef;runId?:string;criteriaResults?:CriteriaResult[];findings?:ReviewFinding[];evidence?:Evidence[];verdict?:ReviewPayload['verdict'];outcome?:ReviewPayload['verdict'];outcomeReasons?:string[];status:'pending'|'running'|'completed'|'blocked'}
export interface Round {requestedCheckId?:string}
export interface ProjectFlowSnapshot {requestedChecks?:RequestedRoundCheck[]}
export interface Acceptance extends FlowRecord { roundId:string; integrationId:string; version:VersionRef; actor:'user'|'lead'; opinion:string; requiresApply:boolean; applyOperationId?:string; appliedPaths:string[]; conflictPaths:string[]; acceptedAt?:string; status:'requested'|'applying'|'accepted'|'conflict'|'changes_requested'|'recovery_required'; allowedActions?:AllowedAction[] }
export interface Decision extends FlowRecord { kind:'early-start'|'scope-change'|'replan'|'unresolved-review'|'unknown-result'|'meeting-request'|'review-choice'|'review-dispute'|'quota-wait'|'next-round'; roundId?:string; taskId?:string; title:string; reason:string; options:string[]; eligibleTaskIds:string[]; sourceVersions:VersionRef[]; answer?:{choice:string;taskIds:string[];opinion?:string;memberId?:string}; status:'open'|'answered'|'expired'|'cancelled'; allowedActions?:AllowedAction[] }
export interface Decision { supplementId?:string }
export interface Decision {additionId?:string}
export interface Decision {stage?:'task'|'task-review'|'integration-fix'|'integration-check'|'peer-review';integrationId?:string;eligibleMemberIds?:string[];currentMemberId?:string}
export interface Decision {submissionId?:string;quotaWaitId?:string}
export interface Decision {disputeItems?:{finding:ReviewFinding;reason:string}[]}
export interface Decision {disputeReturnAccounting?:DisputeReturnAccounting}
export interface FlowArtifact extends FlowRecord { purpose:'base'|'task-base'|'submission'|'review'|'integration'; root:string; fingerprint:string; baselineId:string; baseArtifactId?:string; transient:boolean; status:'capturing'|'ready'|'cleanup'|'removed'; sessionId?:string }
export interface FlowOperation extends FlowRecord { kind:string; targetId:string; targetRevision:number; submissionId?:string; sessionId?:string; runId?:string; correctionRunId?:string; state:'prepared'|'running'|'done'|'blocked'; error?:string; result?:unknown; allowedActions?:AllowedAction[] }
export interface FlowOperation { requirementsRevision?:number; supplementId?:string }
export interface FlowOperation {recovery?:'completed'|'interrupted';resumeRequested?:boolean;continuedByOperationId?:string;recoveredFromRunId?:string}
export interface FlowOperation {jointReviewId?:string;connectionRetryRunIds?:string[]}
export interface TaskSupplementResult { requestId:string; entityId:string; revision:number; pending:boolean; disposition:'recorded'|'current'|'next-turn'|'scope-change'|'unknown'|'new-task-required'; supplementId?:string; decisionId?:string; operationId?:string; nextAction?:'projectFlow.task.add'; requiresNewFlow?:boolean; draft?:{originTaskId:string;flowId:string;roundId:string;memberId:string;goal:string;allowedPaths:string[];sourceMessageId?:string} }
export interface QuotaWait extends FlowRecord {targetId:string;memberId:string;stage:'task'|'review'|'integration-check'|'peer-review'|'round-report'|'adjudication'|'next-round'|'requested-check';startedAt:string;status:'waiting'|'decision'|'resolved';decisionId?:string}
export const QUOTA_STAGE_LABELS:Record<QuotaWait['stage'],string>={task:'执行任务',review:'个人任务复核','integration-check':'整合检查','peer-review':'整轮他人复核','round-report':'本轮汇报',adjudication:'异议裁定','next-round':'下一轮调整建议','requested-check':'用户指定的整轮检查'};
export interface FlowStage {kind:'planning'|'executing'|'reviewing'|'integrating'|'checking'|'peer-review'|'reporting'|'decision'|'acceptance'|'quota'|'paused'|'blocked'|'completed'|'idle';label:string;roundId?:string;leadMemberId?:string}
export interface ProjectFlowSnapshot { projectId:string; revision:number; flow:ProjectFlow|null; plan:Plan|null; plans:PlanSummary[]; rounds:Round[]; tasks:Task[]; submissions:Submission[]; reviews:Review[]; integrations:Integration[]; acceptances:Acceptance[]; decisions:Decision[]; jointReviews:JointReview[]; overview:{working:number;remaining:number;needsUser:number;stage?:FlowStage}; allowedActions:AllowedAction[] }
export interface FlowOverview { projectId:string; flowId:string; revision?:number; status:ProjectFlow['status']; dispatchMode:ProjectFlow['dispatchMode']; working:number; remaining:number; needsUser:number }
export interface ProjectFlowSnapshot {quotaWaits?:QuotaWait[]}
export interface ProjectFlowSnapshot {blockedOperations?:FlowOperation[]}
export interface ProjectFlowSnapshot {taskAdditions?:TaskAddition[]}
export interface OperationResult { runId:string; status:RunStatus; text:string }
export type FlowArtifactFiles = Omit<Artifact,'path'>[];
export class FlowError extends Error { constructor(public code:string,message:string){ super(message); this.name='FlowError'; } }
export const PROJECT_FLOW_READS=[...JOINT_READS,...PROGRESS_READS,...WORKBENCH_READS,...RESULT_READS,...LOG_READS,'projectFlow.get','projectFlow.history','projectFlow.detail','projectFlow.artifact.files','projectFlow.artifact.read','projectFlow.artifact.diff'] as readonly string[];
export const PROJECT_FLOW_METHODS=[...JOINT_WRITES,...WORKBENCH_WRITES,...PROJECT_FLOW_READS,'projectFlow.log.write','projectFlow.start','projectFlow.plan.revise','projectFlow.plan.confirm','projectFlow.review.configure','projectFlow.round.accept','projectFlow.round.requestChanges','projectFlow.round.requestCheck','projectFlow.acceptance.recover','projectFlow.decision.answer','projectFlow.pause','projectFlow.resume','projectFlow.task.reassign','projectFlow.task.supplement','projectFlow.unknown.resolve','projectFlow.cancel'] as readonly string[];
/** Electron IPC drops custom Error properties; return data and reconstruct it in the renderer. */
export function unwrapProjectFlowReply<T>(reply:T):T {const failure=(reply as {__airoomFlowError?:{code:string;message:string}}|null)?.__airoomFlowError;if(failure)throw new FlowError(failure.code,failure.message);return reply;}
