import { spawn } from 'node:child_process';
import path from 'node:path';

/** A check criterion whose text names one command in backticks, e.g. "執行 `python -B tools/x.py a.json` 能正常跑完". */
export interface AutoCheck { criterion: string; command: string; exitCode: number | null; timedOut: boolean; output: string; ms: number }

// Only commands that start with a known runner are executed; prose or shell plumbing in backticks is left to the reviewer.
const RUNNER = /^(?:python3?|py|node|npx|npm|bun|bunx|pytest|deno|go|cargo|dotnet|pwsh|powershell)(?:\.exe)?\s/i;
const UNSAFE = /[;&|<>`]|\$\(|\b(?:rm|del|Remove-Item|format|shutdown|curl|wget|Invoke-WebRequest|iwr)\b/i;

export function checkCommands(criteria: string[]): { criterion: string; command: string }[] {
  const found: { criterion: string; command: string }[] = [];
  for (const criterion of criteria) {
    const commands = [...criterion.matchAll(/`([^`\n]{3,400})`/g)].map(m => m[1]!.trim()).filter(c => RUNNER.test(c) && !UNSAFE.test(c));
    if (commands.length === 1) found.push({ criterion, command: commands[0]! });
  }
  return found;
}

/** One line per command for the owner's card: what AIROOM actually ran and how it ended. */
export function autoCheckSummary(checks: AutoCheck[]): string {
  if (!checks.length) return '';
  return '\nAIROOM 已自动执行：\n' + checks.map(c => `• ${c.command} → ${c.timedOut ? '超时' : c.exitCode === 0 ? '成功（exit 0）' : `失败（exit ${c.exitCode}）`}` +
    (c.exitCode === 0 ? '' : '\n  ' + (c.output.split('\n').filter(Boolean).slice(-3).join(' / ').slice(0, 200) || '没有输出'))).join('\n');
}

/** Run one command with PowerShell in `cwd` (a throwaway copy), with a time limit; keep the tail of the output. */
export function runCheck(command: string, cwd: string, timeoutMs = 120_000): Promise<Omit<AutoCheck, 'criterion'>> {
  const started = Date.now();
  return new Promise(resolve => {
    const shell = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'sh';
    const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $env:PYTHONIOENCODING='utf-8'; ${command}; exit $LASTEXITCODE`] : ['-c', command];
    let output = '', timedOut = false;
    const child = spawn(shell, args, { cwd, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    const keep = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-6000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); resolve({ command, exitCode: null, timedOut, output: String(error.message), ms: Date.now() - started }); });
    child.once('close', code => { clearTimeout(timer); resolve({ command, exitCode: timedOut ? null : code, timedOut, output: output.trim(), ms: Date.now() - started }); });
  });
}
