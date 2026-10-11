import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Check, FileText, FolderOpen, GitBranch, Info, LoaderCircle, Play, Plus, Users, X } from 'lucide-react';
import { PROVIDER_NAMES } from '../shared/defaults';
import type { Project, ProviderId, Snapshot } from '../shared/types';
import { Avatar, Portrait, useTeam } from './members';
import { IconButton, PROVIDERS, providerSummary, runnable, type Invoke } from './ui';
import { projectMembers } from './project-members';
import type { ConfigSelection } from '../shared/executor-config';
import { MemberConfigFields } from './member-config';

export function Modal({ title, subtitle, children, onClose, className = '' }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; className?: string }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = container.current;
    const target = node?.querySelector<HTMLElement>('[autofocus], input, textarea, button');
    target?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab' || !node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')).filter(item => item.offsetParent !== null);
      if (!items.length) return;
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    };
    document.addEventListener('keydown', handle);
    return () => { document.removeEventListener('keydown', handle); previous?.focus(); };
  }, []);
  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={`modal ${className}`} ref={container} role="dialog" aria-modal="true" aria-label={title}>
      <header className="modal-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><IconButton label="关闭对话框" onClick={onClose}><X size={18} /></IconButton></header>
      {children}
    </div>
  </div>;
}

export function ProjectModal({ invoke, onClose, onCreate }: { invoke: Invoke; onClose: () => void; onCreate: (params: { name: string; directory: string }) => Promise<void> }) {
  const [name, setName] = useState(''); const [directory, setDirectory] = useState(''); const [busy, setBusy] = useState(false); const [manual, setManual] = useState(false);
  async function browse() { try { const path = await invoke<string | null>('dialog.directory'); if (path) { setDirectory(path); if (!name) setName(path.split(/[\\/]/).filter(Boolean).at(-1) ?? '新项目'); } } catch {} }
  async function submit() { setBusy(true); try { await onCreate({ name: name.trim(), directory: directory.trim() }); } catch {} finally { setBusy(false); } }
  return <Modal title="添加工作项目" subtitle="选一个本机文件夹，大家会在这里一起工作。" onClose={onClose}>
    <div className="modal-body">
      <button type="button" className={`folder-pick ${directory ? 'chosen' : ''}`} onClick={() => void browse()}>
        <FolderOpen size={22} />
        <span><strong>{directory ? '已选择文件夹' : '选择项目文件夹'}</strong><small>{directory || '打开系统的文件夹选择窗口'}</small></span>
        <ArrowRight size={16} />
      </button>
      {manual ? <label className="field">手动填写路径<input value={directory} onChange={event => setDirectory(event.target.value)} placeholder="例如 C:\Users\你\Desktop\项目" spellCheck={false} /></label>
        : <button type="button" className="link-button" onClick={() => setManual(true)}>没法选择？手动填写完整路径</button>}
      <label className="field">项目名称<input value={name} onChange={event => setName(event.target.value)} placeholder="给这个项目起个名字" /></label>
      <div className="info-card"><GitBranch size={18} /><p>写入任务会先建立独立工作副本。你的原始文件和未提交改动都会保留，由你检查后再决定是否采用。</p></div>
    </div>
    <div className="modal-footer"><button className="button quiet" onClick={onClose}>取消</button><button className="button primary" disabled={!name.trim() || !directory.trim() || busy} onClick={() => void submit()}>{busy ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}添加项目</button></div>
  </Modal>;
}

export function SessionModal({ snapshot, project, initialMember, onClose, onCreate }: { snapshot: Snapshot; project: Project; initialMember?: string; onClose: () => void; onCreate: (params: { provider: ProviderId; memberId: string; title: string; writeMode: boolean }) => Promise<void> }) {
  const team = useTeam();
  const readyMember = team.members.find(member => runnable(snapshot.providers.find(item => item.id === member.executor)));
  const [memberId, setMemberId] = useState<string>(team.members.find(member=>member.id===initialMember)?.id ?? readyMember?.id ?? team.members[0]?.id ?? '');
  const member = team.members.find(member=>member.id===memberId) ?? team.members[0];
  const [title, setTitle] = useState(''); const [writeMode, setWriteMode] = useState(snapshot.settings.defaultWriteMode); const [busy, setBusy] = useState(false);
  const info = snapshot.providers.find(item => item.id === member?.executor);
  // An unnamed session is titled from its first task, so leave the name empty by default.
  async function submit() { if(!member)return;setBusy(true); try { await onCreate({ provider: member.executor, memberId: member.id, title: title.trim(), writeMode: writeMode && Boolean(info?.capabilities.write) }); } catch {} finally { setBusy(false); } }
  if(!member)return <Modal title="开启一个会话" onClose={onClose}><div className="modal-body"><p>团队里还没有人物卡。请先在“设置与连接”中添加成员。</p></div><div className="modal-footer"><button type="button" className="button primary" onClick={onClose}>关闭</button></div></Modal>;
  return <Modal title="开启一个会话" subtitle={`项目：${project.name} · 每个会话有独立的上下文`} onClose={onClose} className="session-modal">
    <div className="modal-body">
      <div className="field">这次请谁来帮忙
        <div className="member-picker" role="radiogroup" aria-label="选择成员">{team.members.map(item => {
          const executor = snapshot.providers.find(provider => provider.id === item.executor);
          return <button type="button" role="radio" aria-checked={item.id === member.id} className={`member-choice member-${item.id} ${item.id === member.id ? 'selected' : ''}`} key={item.id} onClick={() => { setMemberId(item.id); if (!executor?.capabilities.write) setWriteMode(false); }}>
            <Avatar member={item} size={44} />
            <span className="member-choice-text"><strong>{item.name}</strong><small>{item.product}</small><em className={runnable(executor) ? 'ready' : ''}>{providerSummary(executor)}</em></span>
            {item.id === member.id && <Check size={15} className="member-choice-check" />}
          </button>;
        })}</div>
      </div>
      <div className={`member-intro member-${member.id}`}><Portrait member={member} className="mini" /><p><strong>{member.name}</strong>{member.motto ? <>：「{member.motto}」</> : <>（{member.product}）</>}</p></div>
      <label className="field">会话名称 <span className="optional">可选，留空会用第一条任务命名</span><input value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：整理登录流程" /></label>
      <label className="toggle-row"><span><strong>允许修改项目文件</strong><small>{info?.capabilities.write ? '会先建立独立工作副本，原项目由你验收。' : '这位成员目前只用于讨论、审阅和文本产物。'}</small></span><input type="checkbox" checked={writeMode && Boolean(info?.capabilities.write)} disabled={!info?.capabilities.write} onChange={event => setWriteMode(event.target.checked)} /></label>
      {info?.detail && !runnable(info) && <div className="inline-notice"><Info size={14} /><span>{info.detail}</span></div>}
    </div>
    <div className="modal-footer"><button className="button quiet" onClick={onClose}>取消</button><button className="button primary" disabled={busy || !snapshot.backendReady} onClick={() => void submit()}>{busy ? <LoaderCircle size={14} className="spin" /> : <ArrowRight size={14} />}创建会话</button></div>
  </Modal>;
}

export function InviteModal({ snapshot, invoke, initialProjectId, onClose, onCreateProject, onDone }: {
  snapshot: Snapshot; invoke: Invoke; initialProjectId?: string; onClose: () => void;
  onCreateProject: (params: { name: string; directory: string }) => Promise<Project | undefined>;
  onDone: (projectId: string, memberIds: string[]) => Promise<void> | void;
}) {
  const team = useTeam();
  const projects = snapshot.projects.filter(item => !item.kind);
  const ready = (id: string) => runnable(snapshot.providers.find(info => info.id === team.get(id)?.executor));
  const everyone = () => team.members.map(member => member.id).filter(ready);
  const rosterFor = (projectId: string) => { const project = projects.find(item => item.id === projectId); const saved = project ? projectMembers(project).filter(ready) : []; return saved.length ? saved : everyone(); };
  const [target, setTarget] = useState<string>(() => initialProjectId && projects.some(item => item.id === initialProjectId) ? initialProjectId : projects.at(-1)?.id ?? 'new');
  const [name, setName] = useState(''), [directory, setDirectory] = useState(''), [manual, setManual] = useState(false);
  const [members, setMembers] = useState<string[]>(() => target === 'new' ? everyone() : rosterFor(target));
  const [configs,setConfigs]=useState<Record<string,ConfigSelection>>(()=>projects.find(p=>p.id===target)?.memberConfigs??{});
  const [configRevision,setConfigRevision]=useState(()=>projects.find(p=>p.id===target)?.memberConfigRevision??0);
  const [busy, setBusy] = useState(false);
  function choose(projectId: string) { const project=projects.find(p=>p.id===projectId);setTarget(projectId);setConfigs(project?.memberConfigs??{});setConfigRevision(project?.memberConfigRevision??0); if (projectId !== 'new') setMembers(rosterFor(projectId)); }
  function toggle(id: string) { setMembers(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]); }
  async function browse() { try { const path = await invoke<string | null>('dialog.directory'); if (path) { setDirectory(path); if (!name) setName(path.split(/[\\/]/).filter(Boolean).at(-1) ?? '新项目'); } } catch {} }
  async function enter() {
    setBusy(true);
    try {
      const projectId = target === 'new' ? (await onCreateProject({ name: name.trim(), directory: directory.trim() }))?.id : target;
      if (projectId) {
        await invoke('project.update',{projectId,memberConfigs:Object.fromEntries(members.map(id=>[id,configs[id]??{}])),expectedConfigRevision:target==='new'?0:configRevision});
        await onDone(projectId, members);
      }
    } catch {} finally { setBusy(false); }
  }
  const creating = target === 'new', canEnter = members.length >= 2 && (!creating || Boolean(name.trim() && directory.trim()));
  return <Modal title="请大家一起来" subtitle="选好项目和参加的成员，就进入这个项目的会议室。" onClose={onClose} className="invite-modal">
    <div className="modal-body">
      <div className="field">在哪个项目
        <div className="invite-projects" role="radiogroup" aria-label="选择项目">
          {projects.map(item => <button type="button" role="radio" aria-checked={target === item.id} key={item.id} className={`invite-project ${target === item.id ? 'selected' : ''}`} onClick={() => choose(item.id)}>
            <FolderOpen size={16} /><span><strong>{item.name}</strong><small title={item.directory}>{item.directory}</small></span>{target === item.id && <Check size={14} className="invite-check" />}</button>)}
          <button type="button" role="radio" aria-checked={creating} className={`invite-project new ${creating ? 'selected' : ''}`} onClick={() => choose('new')}>
            <Plus size={16} /><span><strong>新建项目</strong><small>选一个本机文件夹</small></span>{creating && <Check size={14} className="invite-check" />}</button>
        </div>
        {creating && <div className="invite-new">
          <button type="button" className={`folder-pick ${directory ? 'chosen' : ''}`} onClick={() => void browse()}>
            <FolderOpen size={20} /><span><strong>{directory ? '已选择文件夹' : '选择项目文件夹'}</strong><small>{directory || '打开系统的文件夹选择窗口'}</small></span><ArrowRight size={16} />
          </button>
          {manual ? <label className="field">手动填写路径<input value={directory} onChange={event => setDirectory(event.target.value)} placeholder="例如 C:\Users\你\Desktop\项目" spellCheck={false} /></label>
            : <button type="button" className="link-button" onClick={() => setManual(true)}>没法选择？手动填写完整路径</button>}
          <label className="field">项目名称<input value={name} onChange={event => setName(event.target.value)} placeholder="给这个项目起个名字" /></label>
        </div>}
      </div>
      <div className="field">请谁参加<small className="field-note">至少两位，之后在会议室里也能调整</small>
        <div className="collaborator-picker" role="group" aria-label="参加的成员">{team.members.map(member => {
          const info = snapshot.providers.find(item => item.id === member.executor), on = members.includes(member.id), able = ready(member.id);
          return <div key={member.id} className={`collaborator-slot member-${member.id} ${on ? 'selected' : ''} ${able ? '' : 'unavailable'}`}><label className={`collaborator-choice member-${member.id} ${on ? 'selected' : ''} ${able ? '' : 'unavailable'}`}>
            <input type="checkbox" className="collaborator-input" checked={on} disabled={!able} onChange={() => toggle(member.id)} aria-label={`邀请 ${member.name}`} />
            <Avatar member={member} size={34} ring={false} />
            <span className="collaborator-text"><strong>{member.name}</strong><small>{member.product}</small><small className={able ? 'ready' : ''}>{able ? '可以参加' : providerSummary(info)}</small></span>
            <span className="collaborator-check" aria-hidden="true">{on && <Check size={13} />}</span>
          </label>{on&&<MemberConfigFields snapshot={snapshot} member={member.card} value={configs[member.id]??{}} invoke={invoke} onChange={value=>setConfigs(previous=>({...previous,[member.id]:value}))}/>}</div>;
        })}</div></div>
      <div className="info-card"><Users size={17} /><p>进入会议室后先一起讨论要做什么。讨论清楚了，再在会议室里选一位负责人起草方案；<strong>你确认方案后才开工</strong>。</p></div>
    </div>
    <div className="modal-footer"><button className="button quiet" onClick={onClose}>取消</button><button className="button primary" disabled={!canEnter || busy || !snapshot.backendReady} onClick={() => void enter()}>{busy ? <LoaderCircle size={14} className="spin" /> : <ArrowRight size={14} />}进入会议室</button></div>
  </Modal>;
}
