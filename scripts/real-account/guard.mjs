import { execFileSync } from 'node:child_process';

export function assertRealAccountConsent(args = process.argv) {
  if (!args.includes('--use-real-account') || !args.includes('--app-closed')) {
    throw new Error('这项测试会使用真实登录并消耗额度。请先取得主人同意、从托盘退出 AIROOM，再明确传入 --use-real-account --app-closed。普通 verify 不运行这项测试。');
  }
}
export function realAccountTestEnvironment(args = process.argv, base = process.env) {
  assertRealAccountConsent(args);
  if (process.platform === 'win32') {
    const command = "@(Get-CimInstance Win32_Process -Filter \"Name='AIROOM.exe' OR Name='electron.exe'\" | Where-Object { $_.Name -eq 'AIROOM.exe' -or $_.CommandLine -match 'AIROOM' }).Count";
    const count = execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true }).trim();
    if (count !== '0') throw new Error('检测到 AIROOM 仍在运行，请先从托盘彻底退出，避免同时续期同一登录。');
  }
  const env = { ...base };
  for (const key of Object.keys(env)) if (/^(?:CLAUDE|ANTHROPIC|CODEX|OPENAI)_|^CLAUDECODE$/i.test(key) && !['CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS'].includes(key.toUpperCase())) delete env[key];
  return env;
}
