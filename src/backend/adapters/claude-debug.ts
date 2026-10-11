import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Debug logs kept: the newest files up to these limits. */
export const CLAUDE_DEBUG_FILES = 40, CLAUDE_DEBUG_BYTES = 50 * 1024 * 1024;

/** Where AIROOM keeps the Claude CLI's own debug logs: data/logs/claude-debug, beside its login folder data/native/claude. */
export function claudeDebugDirectory(env: NodeJS.ProcessEnv) {
  return env.AIROOM_CLAUDE_HOME ? join(resolve(env.AIROOM_CLAUDE_HOME), '..', '..', 'logs', 'claude-debug') : undefined;
}

function prune(directory: string) {
  const files = readdirSync(directory).filter(name => name.endsWith('.log')).map(name => {
    const file = join(directory, name); try { const info = statSync(file); return { file, size: info.size, at: info.mtimeMs }; } catch { return undefined; }
  }).filter((item): item is { file: string; size: number; at: number } => Boolean(item)).sort((a, b) => b.at - a.at);
  let total = 0;
  files.forEach((item, index) => { total += item.size; if (index >= CLAUDE_DEBUG_FILES || total > CLAUDE_DEBUG_BYTES) rmSync(item.file, { force: true }); });
}

/** Diagnosis (2026-10-05): AIROOM's Claude login has been dropped at its first renewal, twice, with the cause unknown.
 *  Every Claude process AIROOM starts writes the CLI's own debug log (the CLI redacts tokens), so whichever process
 *  renews the login next leaves a record of why it failed. AIROOM_CLAUDE_DEBUG=0 turns this off. */
export function claudeDebugArgs(env: NodeJS.ProcessEnv, purpose: string): string[] {
  const directory = claudeDebugDirectory(env);
  if (!directory || env.AIROOM_CLAUDE_DEBUG === '0') return [];
  try { mkdirSync(directory, { recursive: true }); prune(directory); }
  catch { return []; /* Diagnosis never blocks the member. */ }
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${purpose.replace(/[^a-z0-9-]/gi, '') || 'run'}-${randomUUID().slice(0, 6)}.log`;
  return ['--debug-file', join(directory, name)];
}
