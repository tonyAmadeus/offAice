import type { TimelineEvent } from '../shared/types';

/** Consecutive reasoning chunks form one segment; any other event (tool call, output…) starts the next. */
export function thinkingSegments(events: TimelineEvent[]) {
  const segments: { text: string; startedAt: string; endedAt: string }[] = [];
  let current: (typeof segments)[number] | undefined;
  let endAt: string | undefined;
  for (const event of events) {
    if (event.kind === 'reasoning') {
      if (!event.text) continue;
      if (current) { current.text += event.text; current.endedAt = event.at; }
      else segments.push(current = { text: event.text, startedAt: event.at, endedAt: event.at });
      endAt = undefined;
    } else if (current || segments.length) {
      current = undefined;
      endAt ??= event.at;
    }
  }
  const startedAt = segments[0]?.startedAt;
  const finishedAt = endAt ?? segments.at(-1)?.endedAt;
  const seconds = startedAt && finishedAt ? Math.max(1, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000)) : 0;
  return { segments: segments.map(segment => segment.text.trim()).filter(Boolean), seconds };
}

/**
 * Seconds from the start of the turn until the answer began (or until now while still thinking).
 * Some members deliver their reasoning summary only after thinking ends, so segment timestamps undercount.
 */
export function thinkingSeconds(runStartedAt: string, events: TimelineEvent[], now = Date.now()) {
  const start = Date.parse(runStartedAt);
  const answer = events.find(event => event.kind === 'delta' || (event.kind === 'message' && !isUserEcho(event)));
  const lastReasoning = [...events].reverse().find(event => event.kind === 'reasoning');
  const end = answer ? Date.parse(answer.at) : lastReasoning ? Math.max(Date.parse(lastReasoning.at), Math.min(now, Date.parse(lastReasoning.at) + 1000)) : now;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(1, Math.round((end - start) / 1000)) : 0;
}

export function isUserEcho(event: TimelineEvent) {
  return (event.data as { role?: string } | undefined)?.role === 'user';
}

/** Tool work between two answer chunks means the member started a new message. */
const SEPARATORS = new Set<TimelineEvent['kind']>(['tool', 'output', 'approval', 'question']);

export function assistantText(events: TimelineEvent[]) {
  let text = '';
  let separated = false;
  let item: unknown;
  for (const event of events) {
    if (event.kind === 'delta') {
      // A new native message id (Codex itemId) is a new message even without tool work in between.
      const id = (event.data as { itemId?: unknown } | undefined)?.itemId;
      if (id !== undefined && item !== undefined && id !== item) separated = true;
      if (id !== undefined) item = id;
      if (separated && text && !text.endsWith('\n')) text += '\n\n';
      separated = false;
      text += event.text;
    }
    // The engine records the user's own input (and supplements) as message events; they are not member output.
    // A structured question is shown as its own card, not repeated inside the answer.
    else if (event.kind === 'message' && !isUserEcho(event) && !Array.isArray((event.data as { questions?: unknown } | undefined)?.questions)) {
      separated = false;
      // Some backends finish a stream with its complete text; keep a single copy.
      if (text && event.text.startsWith(text.trimEnd())) text = event.text;
      else if (event.text && event.text !== text.trimEnd()) text += `${text ? '\n\n' : ''}${event.text}`;
    } else if (SEPARATORS.has(event.kind) || (event.kind === 'message' && !isUserEcho(event))) separated = true;
  }
  return text;
}

/** What the user added while the run was going: every user echo after the original task. */
export function supplements(events: TimelineEvent[]) {
  return events.filter(isUserEcho).slice(1);
}

export interface MemberQuestion { title: string; options: string[] }
/** Codex can finish a turn with a structured question (agentMessage.questions); the answer comes next turn. */
export function memberQuestions(events: TimelineEvent[]): MemberQuestion[] {
  const result: MemberQuestion[] = [];
  for (const event of events) {
    const questions = (event.data as { questions?: unknown } | undefined)?.questions;
    if (event.kind !== 'message' || !Array.isArray(questions)) continue;
    for (const raw of questions) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as { title?: unknown; question?: unknown; options?: unknown };
      const title = String(item.title ?? item.question ?? '').trim();
      const options = Array.isArray(item.options) ? item.options.map(option => typeof option === 'string' ? option : String((option as { label?: unknown })?.label ?? '')).filter(Boolean) : [];
      if (title) result.push({ title, options });
    }
  }
  return result;
}

/** `"C:\…\powershell.exe" -Command 'git status'` → `git status`; other text is returned unchanged. */
export function prettyCommand(text: string) {
  const match = text.match(/^\s*"?[^"]*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+([\s\S]+)$/i);
  if (!match) return text;
  const body = match[1].trim();
  if ((body.startsWith("'") && body.endsWith("'")) || (body.startsWith('"') && body.endsWith('"'))) return body.slice(1, -1).replace(/''/g, "'").replace(/\\"/g, '"');
  return body;
}
