import { ConfigurationHint, useProviderConfiguration } from './provider-configuration';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';
import { PROVIDER_NAMES } from '../shared/defaults';
import type { Approval, RunSummary, Session, Snapshot } from '../shared/types';
import { Avatar, useTeam, type Team } from './members';
import { shortDateTime, runLabel, isActiveRun, sessionTitle } from './ui';
import { isConversationSession } from '../shared/session-classification';

/* ───────── Context menu ───────── */
export type MenuItem = { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean } | 'separator';
export type MenuState = { x: number; y: number; items: MenuItem[] } | null;

export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const node = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (!menu) return;
    const rect = node.current?.getBoundingClientRect();
    const width = rect?.width ?? 200, height = rect?.height ?? 200;
    setPosition({ x: Math.min(menu.x, window.innerWidth - width - 8), y: Math.min(menu.y, window.innerHeight - height - 8) });
    node.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const close = (event: Event) => { if (event instanceof KeyboardEvent ? event.key === 'Escape' : !node.current?.contains(event.target as Node)) onClose(); };
    const timer = window.setTimeout(() => { document.addEventListener('mousedown', close); document.addEventListener('keydown', close); window.addEventListener('blur', onClose); window.addEventListener('resize', onClose); }, 0);
    return () => { window.clearTimeout(timer); document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); window.removeEventListener('blur', onClose); window.removeEventListener('resize', onClose); };
  }, [menu, onClose]);
  if (!menu) return null;
  return <div className="context-menu" ref={node} role="menu" style={{ left: position.x, top: position.y }} onKeyDown={event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...(node.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }}>
    {menu.items.map((item, index) => item === 'separator' ? <hr key={index} /> : <button type="button" role="menuitem" key={index} className={item.danger ? 'danger' : ''} disabled={item.disabled} onClick={() => { onClose(); item.onSelect(); }}>{item.icon}<span>{item.label}</span></button>)}
  </div>;
}

/* ───────── Quick switcher (Ctrl+K) ───────── */
export function QuickSwitcher({ snapshot, firstInput, onPick, onClose }: { snapshot: Snapshot; firstInput: (id: string) => string | undefined; onPick: (session: Session) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const team = useTeam();
  const projects = useMemo(() => new Map(snapshot.projects.map(project => [project.id, project])), [snapshot.projects]);
  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return [...snapshot.sessions].filter(session => isConversationSession(session,snapshot.runs)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).filter(session => {
      const text = `${sessionTitle(session, firstInput(session.id))} ${team.ofSession(session).name} ${PROVIDER_NAMES[session.provider]} ${projects.get(session.projectId)?.name ?? ''}`.toLowerCase();
      return words.every(word => text.includes(word));
    }).slice(0, 30);
  }, [query, snapshot.sessions, projects, firstInput, team]);
  useEffect(() => setIndex(0), [query]);
  return <div className="modal-overlay switcher-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="switcher" role="dialog" aria-modal="true" aria-label="快速切换会话">
      <label className="switcher-search"><Search size={16} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索会话、成员或项目…" aria-label="搜索会话"
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); onClose(); }
          else if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(value => Math.min(value + 1, results.length - 1)); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(value => Math.max(value - 1, 0)); }
          else if (event.key === 'Enter' && results[index]) { event.preventDefault(); onPick(results[index]); }
        }} /><kbd>Esc</kbd></label>
      <div className="switcher-list" role="listbox">
        {!results.length && <div className="switcher-empty">没有找到匹配的会话</div>}
        {results.map((session, position) => <button type="button" role="option" aria-selected={position === index} key={session.id} className={`switcher-item member-${team.ofSession(session).id} ${position === index ? 'active' : ''}`} onMouseEnter={() => setIndex(position)} onClick={() => onPick(session)}>
          <Avatar member={team.ofSession(session)} size={28} ring={false} />
          <span><strong>{sessionTitle(session, firstInput(session.id))}</strong><small>{team.ofSession(session).name} · {projects.get(session.projectId)?.name ?? '项目'} · {shortDateTime(session.updatedAt)}{session.archived ? ' · 已归档' : ''}</small></span>
          {position === index && <CornerDownLeft size={14} />}
        </button>)}
      </div>
      <div className="switcher-hint"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 打开</span><span><kbd>Ctrl</kbd>+<kbd>N</kbd> 新会话</span><span><kbd>Ctrl</kbd>+<kbd>,</kbd> 设置</span></div>
    </div>
  </div>;
}

/* ───────── Desktop notifications ───────── */
export const NOTIFY_KEY = 'airoom.notify';
export const notificationsEnabled = () => { try { return localStorage.getItem(NOTIFY_KEY) !== 'off'; } catch { return true; } };

/** Tell the user when a member finishes or needs them while AIROOM is in the background. */
export function useMemberNotifications(snapshot: Snapshot, firstInput: (id: string) => string | undefined, onOpen: (session: Session) => void, team: Team) {
  const previous = useRef<{ runs: Map<string, RunSummary['status']>; approvals: Set<string> } | null>(null);
  useEffect(() => {
    const runs = new Map(snapshot.runs.map(run => [run.id, run.status]));
    const approvals = new Set(snapshot.approvals.filter(approval => approval.state === 'pending').map(approval => approval.id));
    const before = previous.current;
    previous.current = { runs, approvals };
    if (!before || !snapshot.backendReady || document.hasFocus() || !notificationsEnabled()) return;
    const sessions = new Map(snapshot.sessions.map(session => [session.id, session]));
    const notices: { session: Session; title: string; body: string }[] = [];
    for (const run of snapshot.runs) {
      const was = before.runs.get(run.id);
      const session = sessions.get(run.sessionId);
      if (!session || !was || was === run.status) continue;
      const name = team.ofSession(session).name, topic = sessionTitle(session, firstInput(session.id));
      const room = snapshot.projects.find(project => project.id === session.projectId)?.kind === 'lounge';
      if (run.status === 'ended' && run.completedAt) notices.push({ session, title: room ? `${name} 在聊天室说话了` : `${name} 完成了`, body: room ? '点开茶歇室查看' : topic });
      else if (['failed', 'unknown', 'interrupted'].includes(run.status)) notices.push({ session, title: `${name} 没能完成`, body: `${topic} · ${runLabel(run)}` });
      else if (run.status === 'rate_limited' && run.completedAt) notices.push({ session, title: `${name} 的额度受限`, body: topic });
    }
    for (const approval of snapshot.approvals as Approval[]) {
      if (approval.state !== 'pending' || before.approvals.has(approval.id)) continue;
      const session = sessions.get(approval.sessionId); if (!session) continue;
      notices.push({ session, title: `${team.ofSession(session).name} 在等你回应`, body: approval.type === 'question' ? approval.detail || approval.title : approval.title });
    }
    if (!notices.length) return;
    void window.airoom?.invoke('window.attention').catch(() => {});
    for (const notice of notices.slice(0, 3)) {
      try {
        const shown = new Notification(notice.title, { body: notice.body.slice(0, 180), icon: team.ofSession(notice.session).art, tag: notice.session.id, silent: false });
        shown.onclick = () => { void window.airoom?.invoke('window.show').catch(() => {}); onOpen(notice.session); shown.close(); };
      } catch { /* Notifications unavailable: the taskbar flash still signals. */ }
    }
  }, [snapshot.runs, snapshot.approvals, snapshot.sessions, snapshot.projects, snapshot.backendReady, firstInput, onOpen, team]);
}

export const isBusy = (snapshot: Snapshot, sessionId: string) => snapshot.runs.some(run => run.sessionId === sessionId && (isActiveRun(run) || run.status === 'queued'));

/* ───────── Per-session model picker ───────── */
const EFFORT_NAMES: Record<string, string> = { on: '开启', none: '关闭', off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '超高' };
export function ModelPopover({ anchor, session, info, defaults, onSave, onSettings, onClose, invoke }: {
  invoke?: import('./ui').Invoke; anchor: DOMRect; session: Session; info?: import('../shared/types').ProviderInfo; defaults: { model?: string; effort?: string };
  onSave: (change: { model: string | null; effort: string | null }) => void; onSettings: () => void; onClose: () => void;
}) {
  const node = useRef<HTMLDivElement>(null);
  const [model, setModel] = useState(session.model ?? '');
  const [effort, setEffort] = useState(session.effort ?? '');
  useEffect(() => {
    const close = (event: Event) => { if (event instanceof KeyboardEvent ? event.key === 'Escape' : !node.current?.contains(event.target as Node)) onClose(); };
    const timer = window.setTimeout(() => { document.addEventListener('mousedown', close); document.addEventListener('keydown', close); }, 0);
    return () => { window.clearTimeout(timer); document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [onClose]);
  const configuration = useProviderConfiguration(session.provider, info, model || defaults.model, invoke);
  const { options, efforts } = configuration;
  const defaultModel = defaults.model || options.find(option => option.isDefault)?.label || info?.model || '成员默认';
  return <div className="model-popover" ref={node} role="dialog" aria-label="这个会话的模型" style={{ left: anchor.left, bottom: window.innerHeight - anchor.top + 8 }}>
    <strong>这个会话用哪个模型</strong>
    <label className="field compact">模型
      {options.length ? <select disabled={!configuration.modelConfigurable} value={model} onChange={event => setModel(event.target.value)}>
        <option value="">跟随成员默认（{defaultModel}）</option>
        {options.map(option => <option key={option.id} value={option.id}>{option.label}{option.isDefault ? ' · 默认' : ''}</option>)}
        {model && !options.some(option => option.id === model) && <option value={model}>{model}</option>}
      </select> : <input disabled={!configuration.modelConfigurable} value={model} onChange={event => setModel(event.target.value)} placeholder={`留空跟随成员默认（${defaultModel}）`} spellCheck={false} />}
    </label>
    <label className="field compact">思考程度
      <select disabled={configuration.checking} value={effort} onChange={event => setEffort(event.target.value)}>
        <option value="">跟随成员默认{defaults.effort ? `（${EFFORT_NAMES[defaults.effort] ?? defaults.effort}）` : ''}</option>
        {[...efforts, ...(effort && !efforts.includes(effort) ? [effort] : [])].map(value => <option key={value} value={value}>{EFFORT_NAMES[value] ?? value}（{value}）{!efforts.includes(value) ? '（需重新核对）' : ''}</option>)}
      </select>
    </label>
    <ConfigurationHint configuration={configuration} onDefault={model ? () => { setModel(''); setEffort(''); } : undefined} />
    <small>只影响这个会话，从下一轮开始生效。</small>
    <div className="model-popover-actions">
      <button type="button" className="link-button" onClick={() => { onClose(); onSettings(); }}>修改成员默认</button>
      <button type="button" className="button small primary" onClick={() => { onSave({ model: model || null, effort: effort || null }); onClose(); }}>保存</button>
    </div>
  </div>;
}
