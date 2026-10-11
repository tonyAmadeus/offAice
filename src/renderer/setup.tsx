import { useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, CircleDashed, FolderPlus, KeyRound, LoaderCircle, RefreshCw, Settings2, UserRound, X } from 'lucide-react';
import type { ProviderId, ProviderInfo, Snapshot } from '../shared/types';
import { quotaFresh } from '../shared/quota';
import { Avatar, type Team, type TeamMember } from './members';
import type { SettingsTab } from './settings';
import { providerSummary, runnable, versionText, type Invoke } from './ui';

type Tone = 'ok' | 'todo' | 'warn';
/** The pending items the user chose to ignore; a different set of pending items shows the list again. */
const DISMISSED_KEY = 'airoom.setup.dismissed';
interface Check { tone: Tone; text: string; action?: 'probe' | 'login' | 'settings' | 'download' }

/** What a member still needs before it can work, in words the user can act on. */
export function memberCheck(info: ProviderInfo | undefined, snapshot: Snapshot): Check {
  if (!info) return { tone: 'todo', text: '还没检查过连接', action: 'probe' };
  if(info.installationRequired)return {tone:'todo',text:'需要下载官方程序',action:'download'};
  if (info.stale) return { tone: 'todo', text: info.available ? '上次已连接，正在重新确认' : '正在重新确认连接', action: 'probe' };
  if (!info.available) {
    if (info.auth === 'none') return { tone: 'todo', text: '需要登录', action: 'login' };
    return { tone: 'warn', text: `没有连上：${info.detail.split('\n')[0].slice(0, 80) || '原因未知'}`, action: 'settings' };
  }
  if (!runnable(info)) return { tone: 'warn', text: info.auth === 'api' ? '正在用 API 计费，需要改成订阅登录' : providerSummary(info), action: 'settings' };
  const windows = snapshot.quotas?.[info.id]?.windows.filter(window => quotaFresh(window)) ?? [];
  const spent = windows.find(window => window.exhausted || (window.usedPercent ?? 0) >= 100);
  if (spent) return { tone: 'warn', text: `${spent.label}额度已用完${spent.resetsAt ? `，${new Date(spent.resetsAt * 1000).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 恢复` : ''}` };
  return { tone: 'ok', text: `已就绪 · ${providerSummary(info)}${info.version ? ` · ${versionText(info)}` : ''}` };
}

const ICON: Record<Tone, ReactNode> = { ok: <CheckCircle2 size={15} />, todo: <CircleDashed size={15} />, warn: <AlertCircle size={15} /> };

/** The home page's "before we start" list: every member's connection and login, the user's name and a first project. */
export function SetupChecklist({ snapshot, team, invoke, onSettings, onProject }: { snapshot: Snapshot; team: Team; invoke: Invoke; onSettings: (tab: SettingsTab, focus?: string) => void; onProject: () => void }) {
  const [probing, setProbing] = useState<string | null>(null);
  const members = team.members.map(member => ({ member, check: memberCheck(snapshot.providers.find(item => item.id === member.executor), snapshot) }));
  const named = Boolean(snapshot.profile.name && snapshot.profile.name !== '你');
  const project = snapshot.projects.some(item => !item.kind);
  const done = members.filter(item => item.check.tone === 'ok').length + Number(named) + Number(project);
  const total = members.length + 2;
  const [open, setOpen] = useState(done < total);
  // What is still pending, e.g. "claude:todo|profile": ignoring this exact state hides the list.
  const pending = [...members.filter(item => item.check.tone !== 'ok').map(item => `${item.member.id}:${item.check.tone}:${item.check.text}`), ...(named ? [] : ['profile']), ...(project ? [] : ['project'])].join('|');
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(DISMISSED_KEY) ?? ''; } catch { return ''; } });
  function dismiss() { setDismissed(pending); try { localStorage.setItem(DISMISSED_KEY, pending); } catch {} }
  async function probe(member: TeamMember) {
    setProbing(member.id);
    try { await invoke('provider.probe', { provider: member.executor as ProviderId }); } catch {} finally { setProbing(null); }
  }
  if (done === total || dismissed === pending) return null;
  return <section className="setup-checklist" aria-label="开工前检查">
    <div className="setup-head-row">
      <button type="button" className="setup-head" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <strong>开工前检查</strong><span className="setup-progress" aria-label={`已完成 ${done} 项，共 ${total} 项`}><i style={{ width: `${Math.round(done / total * 100)}%` }} /></span><small>{done}/{total} 已就绪</small>
      </button>
      <button type="button" className="icon-button setup-dismiss" title="先不管：有新问题时再提醒" aria-label="忽略开工前检查" onClick={dismiss}><X size={15} /></button>
    </div>
    {open && <ul>
      {members.map(({ member, check }) => <li key={member.id} className={`setup-item ${check.tone}`}>
        <span className="setup-icon">{ICON[check.tone]}</span><Avatar member={member} size={24} ring={false} />
        <span className="setup-text"><strong>{member.name}</strong><small>{check.text}</small></span>
        {check.action==='download'&&<button type="button" className="button small primary" onClick={()=>onSettings('members','catalog')}>下载并配置</button>}
        {check.action === 'probe' && <button type="button" className="button small secondary" disabled={!snapshot.backendReady || probing === member.id} onClick={() => void probe(member)}>{probing === member.id ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}检测</button>}
        {check.action === 'login' && <button type="button" className="button small primary" onClick={() => onSettings('members', member.executor)}><KeyRound size={13} />去登录</button>}
        {check.action === 'settings' && <><button type="button" className="button small quiet" disabled={!snapshot.backendReady || probing === member.id} onClick={() => void probe(member)}>{probing === member.id ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}重新检测</button>
          <button type="button" className="button small secondary" onClick={() => onSettings('members', member.executor)}><Settings2 size={13} />去设置</button></>}
      </li>)}
      <li className={`setup-item ${named ? 'ok' : 'todo'}`}>
        <span className="setup-icon">{ICON[named ? 'ok' : 'todo']}</span><span className="setup-glyph"><UserRound size={14} /></span>
        <span className="setup-text"><strong>你的称呼</strong><small>{named ? `成员会叫你「${snapshot.profile.name}」` : '告诉大家怎么称呼你'}</small></span>
        {!named && <button type="button" className="button small secondary" onClick={() => onSettings('profile')}>去填写</button>}
      </li>
      <li className={`setup-item ${project ? 'ok' : 'todo'}`}>
        <span className="setup-icon">{ICON[project ? 'ok' : 'todo']}</span><span className="setup-glyph"><FolderPlus size={14} /></span>
        <span className="setup-text"><strong>第一个项目</strong><small>{project ? '已经有工作项目了' : '选一个文件夹，成员就能在里面帮你干活'}</small></span>
        {!project && <button type="button" className="button small secondary" disabled={!snapshot.backendReady} onClick={onProject}>添加项目</button>}
      </li>
    </ul>}
  </section>;
}
