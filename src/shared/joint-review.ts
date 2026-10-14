import type { AllowedAction, Evidence, FlowRecord, ReviewFinding, VersionRef } from './project-flow';

export const JOINT_READS=['projectFlow.jointReview.list','projectFlow.jointReview.get','projectFlow.jointReview.subjects','projectFlow.jointReview.artifact.files','projectFlow.jointReview.artifact.read','projectFlow.jointReview.artifact.diff'] as const;
export const JOINT_WRITES=['projectFlow.jointReview.start','projectFlow.jointReview.cancel','projectFlow.jointReview.pause','projectFlow.jointReview.resume','projectFlow.jointReview.decide','projectFlow.jointReview.resolve'] as const;
export type JointStage='independent'|'peer'|'author'|'summary'|'verification'|'decision';
export type JointSubject=string|{submissionId:string;version:VersionRef}|{integrationId:string;version:VersionRef}|{runId:string;version:VersionRef}|{snapshot:true;version:VersionRef}|{runId:string;textHash:string;answerArtifactId?:string};
export interface JointCost {baseCalls:number;completedCalls:number;additionalCalls:number;description:string;usage?:import('./call-usage').CallUsage}
export interface JointFinding extends ReviewFinding,PeerFindingTarget {memberId:string;slotId:string}
export interface JointOpinion {summary:string;userSummary?:string;proposal?:string;findings:(ReviewFinding&PeerFindingTarget)[];unverifiedItems:string[];evidence:Evidence[];version?:VersionRef;replyNotes?:string[]}
export interface AuthorResponse {findingId:string;stance:'agree'|'dispute'|'fixed-new-version';reason:string;evidence:string;newSubmissionId?:string}
export interface JointDisposition {findingId:string;action:'accept'|'defer'|'reject';reason:string}
export interface JointDisagreement {findingIds:string[];reason:string;affectsAcceptance:boolean}
export interface JointVerificationRequest {findingIds:string[];instruction:string;memberId?:string}
export interface JointSummary {summary:string;userSummary?:string;dispositions:JointDisposition[];disagreements:JointDisagreement[];verificationRequests:JointVerificationRequest[];recommendedSlotId?:string;synthesis?:string;version?:VersionRef;replyNotes?:string[]}
export interface JointVerification {findingIds:string[];outcome:'confirmed'|'refuted'|'inconclusive';evidence:Evidence[];summary:string;reportedOutcome?:'confirmed'|'refuted';replyNotes?:string[]}
export interface JointSlot extends FlowRecord {
  jointReviewId:string;stage:Exclude<JointStage,'decision'>;memberId:string;
  status:'queued'|'running'|'completed'|'skipped'|'recoverable'|'blocked'|'cancelled';
  operationId?:string;sessionId?:string;runId?:string;attempt:number;error?:string;
  previousAttempts?:{operationId?:string;sessionId?:string;runId?:string;disposableArtifactId?:string;error?:string;at:string}[];
  skippedByUser?:{evidence:string;at:string};acceptedByUser?:{runId:string;evidence:string;at:string};
  recovery?:{canRetry:boolean;needsDuplicateConfirmation:boolean;canSkip:boolean;canAdopt:boolean;canRecover:boolean};
  disposableArtifactId?:string;version?:VersionRef;findingIds?:string[];instruction?:string;
  inputLimits?:string[];
  /** Stable, per-reviewer letters. The reviewer sees only letters; the app resolves them to members for display. */
  peerMap?:{letter:string;slotId:string}[];
  opinion?:JointOpinion;responses?:AuthorResponse[];summary?:JointSummary;verification?:JointVerification;
}
export interface JointDecision extends FlowRecord {
  jointReviewId:string;kind:'candidate'|'disagreement';title:string;reason:string;
  findingIds:string[];candidateSlotIds:string[];status:'open'|'answered'|'cancelled';
  answer?:{choice:string;opinion:string;slotId?:string};allowedActions?:AllowedAction[];
}
export interface JointReview extends Omit<FlowRecord,'flowId'> {
  writeBoundary?:import('./types').WriteBoundary;
  flowId?:string;kind:'proposal'|'artifact'|'answer';subject:JointSubject;
  mode:'comparison'|'candidates';selection:'user'|'lead';deliverablePath?:string;
  reviewerMemberIds:string[];leadMemberId:string;authorMemberId?:string;
  memberConfigs?:Record<string,import('./executor-config').RequestedRunConfig>;
  peerReview:boolean;authorReply:boolean;roomId:`project:${string}`|`roundtable:${string}`;threadId:string;
  roundtableTopicId?:string;attachments?:import('./types').Attachment[];source?:import('./roundtable').RoundtableSource;
  status:'preparing'|'active'|'awaiting_author'|'awaiting_verification'|'awaiting_decision'|'completed'|'stale'|'blocked'|'cancelled';
  stage:JointStage;dispatchMode:'running'|'paused';slotIds:string[];
  lockedVersion?:VersionRef;baseVersion?:VersionRef;answerText?:string;
  findings:JointFinding[];responses:AuthorResponse[];dispositions:JointDisposition[];
  decisionIds:string[];cost:JointCost;authorSkippedReason?:string;staleReason?:string;error?:string;
  quotaWaitMemberIds?:string[];
  conclusion?:JointSummary;selectedSlotId?:string;
  outcome?:'ready'|'changes_requested'|'inconclusive';allowedActions?:AllowedAction[];
}
export interface JointReviewDetail {review:JointReview;slots:JointSlot[];decisions:JointDecision[]}
export function peerReviewTargets(slot:JointSlot,slots:readonly JointSlot[]){
  return (slot.peerMap??[]).flatMap(target=>{
    const candidate=slots.find(s=>s.id===target.slotId&&s.jointReviewId===slot.jointReviewId&&s.stage==='independent'&&s.memberId!==slot.memberId);
    return candidate?[{...target,memberId:candidate.memberId}]:[];
  });
}
/** Which anonymous candidate a peer finding is about: the letter the reviewer gave, or one named unambiguously. */
export interface PeerFindingTarget {candidate?:string;targetSlotId?:string}
// Capital letters only: "Options" must not read as a mention of candidate S.
const LETTER_MENTION=/(?:方案|候选|版本|稿件?|[Pp]roposal|[Cc]andidate|[Oo]ption)\s*([A-Z])(?![A-Za-z])/g;
export function peerFindingTarget(finding:Pick<ReviewFinding,'location'|'evidence'|'request'>&PeerFindingTarget,peerMap:readonly {letter:string;slotId:string}[]):PeerFindingTarget{
  const given=finding.candidate?.trim().toUpperCase(),mentioned=new Set([finding.location,finding.evidence,finding.request].flatMap(text=>[...(text??'').matchAll(LETTER_MENTION)].map(m=>m[1].toUpperCase())));
  const letter=given&&peerMap.some(p=>p.letter===given)?given:peerMap.length===1?peerMap[0].letter:mentioned.size===1?[...mentioned][0]:undefined;
  const target=peerMap.find(p=>p.letter===letter);
  return target?{candidate:target.letter,targetSlotId:target.slotId}:{};
}
/** Display only: "方案 A" becomes "方案 A（成员名）" for this reviewer's own letters. Saved text is unchanged. */
export function labelPeerLetters(text:string,targets:readonly {letter:string;memberId:string}[],name:(id:string)=>string){
  if(!targets.length)return text;
  return text.replace(LETTER_MENTION,(match,letter:string,offset:number,whole:string)=>{
    const target=targets.find(t=>t.letter===letter.toUpperCase());
    return target&&!/^\s*[（(]/.test(whole.slice(offset+match.length))?`${match}（${name(target.memberId)}）`:match;
  });
}
export interface JointSubjectOption {id:string;kind:'artifact'|'answer';label:string;authorMemberId?:string;subject:Exclude<JointSubject,string>;currentCopy?:boolean}
export const JOINT_STAGE_LABELS:Record<JointStage,string>={independent:'独立产出',peer:'互评',author:'作者答复',summary:'汇总',verification:'验证分歧',decision:'待你决定'};
export function jointCost(count:number,kind:JointReview['kind'],peerReview=kind==='proposal',authorReply=kind!=='proposal'):JointCost{
  const baseCalls=count*(peerReview?2:1)+1+(authorReply&&kind!=='proposal'?1:0);
  return {baseCalls,completedCalls:0,additionalCalls:0,description:`预计 ${baseCalls} 次调用；格式补正和分歧验证另计。`};
}
