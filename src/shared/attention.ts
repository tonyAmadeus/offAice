import type { ProviderId } from './types';

export const ATTENTION_KINDS=['question','approval','unknown','login','merge-conflict','acceptance','round-acceptance','decision'] as const;
export type AttentionKind=typeof ATTENTION_KINDS[number];
/** Navigation only. Opening an item must not answer, resend, merge, or accept it. */
export interface AttentionItem {
  id:string; kind:AttentionKind; title:string; detail:string; at:string;
  projectId?:string; sessionId?:string; runId?:string; provider?:ProviderId;
  memberId?:string; threadId?:string; messageId?:string; approvalId?:string;
  flowId?:string; roundId?:string; decisionId?:string;
  jointReviewId?:string;
  /** Identifies the currently displayed version; ignoring it never changes the source work. */
  fingerprint?:string;
  roomId?:import('./types').RoomId;
  action:{view:'session'|'room'|'member-settings'|'workspace'|'project-room';label:string};
}
export interface AttentionDismissal extends Pick<AttentionItem,'id'|'projectId'|'sessionId'|'runId'|'roomId'|'threadId'> {
  fingerprint:string; dismissedAt:string;
}
export interface AttentionSummary {
  items:AttentionItem[]; counts:Record<AttentionKind,number>; total:number; generatedAt:string;
}
/** The last observed apply failure, not a new automatic conflict check. */
export interface WorkspaceConflictNotice {
  sessionId:string; workspace:string; at:string; conflicts:{path:string;reason:string}[];
}
