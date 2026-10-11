import type { Session, Run } from './types';

/** Positive domain ownership; unidentified legacy sessions remain accessible as history. */
export function classifySession(session:Session,runs:Pick<Run,'sessionId'|'flowOperationId'>[]=[]):'flow'|'room'|'conversation'|'history' {
  if(session.flowId||runs.some(r=>r.sessionId===session.id&&r.flowOperationId)||session.purpose?.startsWith('flow-'))return 'flow';
  if(session.roomId||session.roomThreadId||session.purpose?.startsWith('room-'))return 'room';
  return session.purpose?'history':'conversation';
}
export const isConversationSession=(session:Session,runs:Pick<Run,'sessionId'|'flowOperationId'>[]=[])=>['conversation','history'].includes(classifySession(session,runs));
