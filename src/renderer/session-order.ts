import type { Run, Session } from '../shared/types';

/** Newest activity first: a session's latest turn, or its creation when it has none. Renaming,
 *  pinning or changing its model does not move it. */
export function byActivity(sessions: Session[], runs: Run[]): Session[] {
  const latest = new Map<string, string>();
  for (const run of runs) if ((latest.get(run.sessionId) ?? '') < run.updatedAt) latest.set(run.sessionId, run.updatedAt);
  const activity = (session: Session) => latest.get(session.id) ?? session.createdAt;
  return [...sessions].sort((a, b) => activity(b).localeCompare(activity(a)));
}
