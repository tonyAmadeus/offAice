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


export function isUserEcho(event: TimelineEvent) {
  return (event.data as { role?: string } | undefined)?.role === 'user';
}

/** What the user added while the run was going: every user echo after the original task. */
export function supplements(events: TimelineEvent[]) {
  return events.filter(isUserEcho).slice(1);
}

/** `"C:\…\powershell.exe" -Command 'git status'` → `git status`; other text is returned unchanged. */
export function prettyCommand(text: string) {
  const match = text.match(/^\s*"?[^"]*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+([\s\S]+)$/i);
  if (!match) return text;
  const body = match[1].trim();
  if ((body.startsWith("'") && body.endsWith("'")) || (body.startsWith('"') && body.endsWith('"'))) return body.slice(1, -1).replace(/''/g, "'").replace(/\\"/g, '"');
  return body;
}
