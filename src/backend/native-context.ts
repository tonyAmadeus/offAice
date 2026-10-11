import type { Session } from '../shared/types';

// Bound how long identity, memory and room rules depend on native history alone.
export const NATIVE_CONTEXT_REFRESH_TURNS = 4;
export const NATIVE_CONTEXT_REFRESH_CHARS = 24_000;
export const CURRENT_PERSONA_NOTICE = '以下为最新完整设定，替换此前全部设定；未列出的旧记忆不再适用。';

export function nativeContextNeedsRefresh(session: Session, inputChars = 0): boolean {
  const state = session.nativeContext;
  return !session.nativeId || !state || state.nativeId !== session.nativeId
    || state.refreshRequired === true
    || state.turnsSinceRefresh >= NATIVE_CONTEXT_REFRESH_TURNS
    || state.inputCharsSinceRefresh + inputChars >= NATIVE_CONTEXT_REFRESH_CHARS;
}

export function latestPersona(persona?: string): string {
  return `[AIROOM 人物与记忆更新]\n${CURRENT_PERSONA_NOTICE}\n${persona || '当前没有额外人物设定或长期记忆。'}`;
}

/** Call only after a positively confirmed successful turn. Unknown results never advance it. */
export function acknowledgedNativeContext(session: Session, inputChars: number, refreshed: boolean, compacted: boolean): Session['nativeContext'] {
  if (!session.nativeId) return;
  const previous = session.nativeContext?.nativeId === session.nativeId ? session.nativeContext : undefined;
  return {
    nativeId: session.nativeId,
    turnsSinceRefresh: (refreshed ? 0 : previous?.turnsSinceRefresh ?? 0) + 1,
    inputCharsSinceRefresh: (refreshed ? 0 : previous?.inputCharsSinceRefresh ?? 0) + inputChars,
    refreshRequired: compacted,
  };
}
