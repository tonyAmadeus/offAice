import { useEffect, useState, type ReactNode } from 'react';
import { PROVIDER_NAMES, isAcpId } from '../shared/defaults';
import type {AcpExecutor, ProviderId, ProviderInfo, Run, Session, Settings } from '../shared/types';

export type Invoke = <T = unknown>(method: string, params?: unknown, success?: string, options?:{background?:boolean}) => Promise<T>;
export type Notify = (text: string, error?: boolean) => void;
export type Perform = (method: string, params?: unknown, success?: string) => void;

/** Executors in team order. The DeepSeek API stand-in is retired: DSH runs on its own account. */
export const PROVIDERS: ProviderId[] = ['claude', 'codex', 'dsh'];
export const RUN_LABELS: Record<Run['status'], string> = {
  queued: '排队中', running: '进行中', waiting_user: '等你回应', rate_limited: '额度受限',
  stopping: '正在停止', stopped: '已停止', ended: '完成 · 待验收', completed: '已验收',
  interrupted: '运行中断', unknown: '状态待核对', failed: '没能完成',
};
/** A finished run awaits acceptance only when its file changes are still in place; an answer is simply done. */
export const runLabel = (run: Pick<Run, 'status' | 'workspaceUndo'>) => run.status === 'ended' && run.workspaceUndo?.status !== 'available' ? '已完成' : RUN_LABELS[run.status];
const ACTIVE_RUNS = new Set<Run['status']>(['running', 'waiting_user', 'rate_limited', 'stopping']);
export const isActiveRun = (run: Run) => ACTIVE_RUNS.has(run.status) && !run.completedAt;

export function statusClass(status: Run['status']) {
  if (status === 'completed') return 'success';
  if (status === 'failed' || status === 'unknown' || status === 'interrupted') return 'danger';
  if (status === 'ended' || status === 'waiting_user' || status === 'rate_limited') return 'attention';
  return ACTIVE_RUNS.has(status) ? 'active' : 'muted';
}
export function time(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}
/** Month, day and minute: enough to tell list rows apart without a full timestamp. */
export function shortDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
export function dateTime(value?: string) {
  if (!value) return '尚未检查';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
export function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1048576).toFixed(1)} MB`;
}
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
export function providerSummary(provider?: ProviderInfo) {
  if (!provider) return '尚未检查';
  if(provider.installationRequired)return '需要下载';
  if (provider.stale) return provider.available ? '上次已连接 · 待复核' : '上次未就绪 · 待复核';
  if (!provider.available) return provider.auth === 'none' ? '需要登录' : '未就绪';
  if (provider.auth === 'subscription') return '订阅登录';
  if (provider.auth === 'account') return isAcpId(provider.id) ? '已连接' : '独立账号已登录';
  if (provider.auth === 'api') return provider.id === 'codex' ? '需改为订阅' : 'API 计费';
  if (provider.auth === 'none') return '需要登录';
  return '认证待确认';
}
/** A member program's version for display: DSH reports a bare number, so its name is added. */
export function versionText(provider?: ProviderInfo) {
  const version = provider?.version?.trim();
  if (!version) return '';
  return provider!.id === 'dsh' && !/harness/i.test(version) ? `DeepSeek Harness ${version}` : version;
}
export function runnable(provider?: ProviderInfo) {
  if (!provider?.available || provider.stale) return false;
  // External programs may report an account or an explicitly identified subscription.
  if (isAcpId(provider.id)) return provider.auth === 'account' || provider.auth === 'subscription';
  return provider.id === 'claude' ? ['subscription','api'].includes(provider.auth) : provider.id === 'codex' ? provider.auth === 'subscription' : provider.id === 'dsh' ? provider.auth === 'account' : provider.auth === 'api';
}

const DEFAULT_TITLE = /^(Codex|Claude|DeepSeek Harness|DeepSeek · DSH|DeepSeek API|DeepSeek)\s*(对话|会话)$/;
/** Sessions created without a name take the first task as their title. */
export function sessionTitle(session: Session, firstInput?: string) {
  if (!(session.autoTitle || DEFAULT_TITLE.test(session.title)) || !firstInput?.trim()) return session.title;
  const line = firstInput.trim().split('\n')[0].replace(/\s+/g, ' ');
  return line.length > 22 ? `${line.slice(0, 22)}…` : line;
}

export type AccessLevel = { label: string; tone: 'full' | 'workspace' | 'readonly'; detail: string };
/** The permission level a session's next turn runs with, from the session and the member's settings. */
export function accessLevel(session: Session, settings: Settings, executors: AcpExecutor[] = []): AccessLevel {
  if (!session.writeMode || session.provider === 'deepseek') return { label: '只读', tone: 'readonly', detail: '这个会话只读：可以阅读和讨论，不修改文件。' };
  const connected = executors.find(item => item.id === session.provider);
  if (connected) return { label: `外接程序${connected.permissions.commands === 'ask' ? ' · 操作需审批' : connected.permissions.commands === 'deny' ? ' · 不执行命令' : ''}`, tone: 'workspace', detail: '在本次会话的工作副本里工作；AIROOM 只能处理它主动发来的操作请求，它自己的工具规则仍然有效。' };
  const permissions = settings.permissions[session.provider];
  const strict = permissions.commands === 'ask' ? ' · 命令需审批' : permissions.commands === 'deny' ? ' · 不执行命令' : '';
  if (permissions.fileScope === 'any') return { label: `完全访问${strict}`, tone: 'full', detail: '以你的 Windows 用户权限工作，可以修改工作副本以外的文件；不申请管理员权限。' };
  return { label: `工作区${strict}`, tone: 'workspace', detail: '文件修改限制在本次会话的工作区内。' };
}

export function greeting(date = new Date()) {
  const hour = date.getHours();
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 13) return '中午好';
  if (hour < 18) return '下午好';
  if (hour < 23) return '晚上好';
  return '夜深了';
}

/** Re-render every `ms` while `active`; used for live timers. */
export function useTicker(active: boolean, ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [active, ms]);
  return now;
}

export function IconButton({ label, children, onClick, disabled, className = '' }: {
  label: string; children: ReactNode; onClick?: () => void; disabled?: boolean; className?: string;
}) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>;
}
export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return <div className="small-empty"><span className="empty-symbol">{icon}</span><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}
export const providerName = (id: ProviderId) => PROVIDER_NAMES[id];
