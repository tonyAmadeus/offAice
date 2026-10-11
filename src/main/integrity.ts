import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Mandatory integrity SID is language independent; group names are localized.
export function integrityRid(output: string): number {
  const levels = [...output.matchAll(/S-1-16-(\d+)\b/g)].map(match => Number(match[1]));
  if (levels.length !== 1) throw new Error('无法确认进程完整性级别，已停止启动。');
  return levels[0];
}

export function assertNormalIntegrity(platform = process.platform): void {
  if (platform !== 'win32') return;
  const result = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), ['/groups', '/fo', 'csv', '/nh'], {
    encoding: 'utf8', windowsHide: true, timeout: 5000,
  });
  if (result.error || result.status !== 0) throw new Error('无法检测运行权限，已停止启动。请在普通 Windows 会话重新运行。');
  if (integrityRid(result.stdout) < 8192) throw new Error('AIROOM 正在低完整性环境中运行，登录和保存数据可能失败，已停止启动。\n\n请退出本程序，让用户或 Claude 在沙箱外、项目根目录执行：\npowershell -NoProfile -ExecutionPolicy Bypass -File scripts\\deploy-runtime.ps1\n\n部署后从普通 Windows 会话双击 Start-AIROOM.cmd。不要从 Codex 沙箱部署或验证日常运行版。');
}
