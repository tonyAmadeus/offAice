import type { Attachment, RoomId, RoomMessage } from './types';
import type { VersionRef } from './project-flow';
import type { JointReviewDetail, JointCost } from './joint-review';

export const ROUNDTABLE_READS=['roundtable.list','roundtable.get','roundtable.material','roundtable.export','roundtable.artifact.files','roundtable.artifact.read','roundtable.artifact.diff'] as const;
export const ROUNDTABLE_WRITES=['roundtable.open','roundtable.select','roundtable.rename','roundtable.archive','roundtable.delete','roundtable.pause','roundtable.resume','roundtable.decide','roundtable.resolve','roundtable.discuss','roundtable.confirm','roundtable.end','roundtable.handoff','project.toRoundtable'] as const;
/** Older versions saved the first prepared material as a user message. Correct its read projection only. */
export function roundtableContextMessage(message:RoomMessage,roomId:RoomId):RoomMessage {
  if(!roomId.startsWith('roundtable:')||message.author!=='user'||!message.discussionId||message.discussionRevision!==1||!message.text.startsWith('围绕议题「'))return message;
  const marker='」审议下面已保存的意见。每人回答一次后等用户，用户点整理会议纪要才结束。保留分歧、未核实事项及跳过记录；用户确认采用的回复不代表程序确认结束。项目文件不会被修改。\n\n{"requirement":';
  if(!message.text.includes(marker)||!message.text.includes('"opinions":['))return message;
  return {...message,author:'system',authorName:'系统',system:true,contextOnly:true};
}
export type RoundtableKind='review'|'candidates'|'proposals';
export interface RoundtableSource {projectId:string;planId?:string;roundId?:string;integrationId?:string;submissionId?:string;runId?:string;path?:string;version?:VersionRef}
export interface RoundtableMaterial {text?:string;attachments?:Attachment[];directory?:string;source?:RoundtableSource}
export interface RoundtableTopic {
  id:string;title:string;kind:RoundtableKind;roomId:Extract<RoomId,`roundtable:${string}`>;projectId:string;revision:number;createdAt:string;updatedAt:string;
  status:'preparing'|'reviewing'|'discussing'|'conclusion'|'confirmed'|'ended'|'blocked';archivedAt?:string;error?:string;restoredHistoryOnly?:boolean;inputLimits?:string[];pauseRequested?:boolean;openingRequestId?:string;
  material:RoundtableMaterial;materialVersion?:VersionRef;reviewId?:string;memberIds:string[];leadMemberId:string;handRaise:boolean;hostPick:boolean;
  authorMemberId?:string;discussionId?:string;revealedAt?:string;conclusion?:{id:string;discussionId:string;messageId?:string;body:string;at:string;reviewRevision:number};
  /** Readable provenance for the hidden discussion material; no model call is needed to render it. */
  discussionMaterial?: { members: { id:string; name:string; opinions:number }[]; findings:number; skipped:{ memberId:string; name:string; stage:string; reason:string }[]; truncated:boolean };
  confirmedConclusionId?:string;handoffs?:{requestId:string;projectId:string;as:'material'|'task'|'plan';messageId:string;result?:unknown;at:string}[];
}
export interface RoundtableOverview extends Pick<RoundtableTopic,'id'|'title'|'kind'|'roomId'|'revision'|'status'|'archivedAt'|'createdAt'|'updatedAt'|'error'|'openingRequestId'> {
  reviewId?:string;
  completed:number;total:number;revealed:boolean;reviewRevision:number;roomRevision:number;dispatchMode?:'running'|'paused';cost?:JointCost;
}
export interface RoundtableDetail {topic:RoundtableTopic;review?:JointReviewDetail;revealed:boolean;completed:number;total:number;needsEndAcknowledgement:boolean;callUsage?:import('./call-usage').CallUsage}
