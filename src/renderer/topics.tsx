import { useState } from 'react';
import { Archive, Download, Eraser, Eye, FileStack, LoaderCircle, MessageSquarePlus, Pencil, Sparkles, Trash2, X } from 'lucide-react';
import type { RoomThread, Snapshot } from '../shared/types';
import { Markdown } from './Markdown';
import { Modal } from './modals';
import type { TeamMember } from './members';
import { dateTime, type Invoke } from './ui';

const SUMMARIZER_KEY = 'airoom.room.summarizer';

/** Who writes topic summaries; remembered per viewer, falling back to the first member who is ready. */
export function useSummarizer(usable: TeamMember[]) {
  const [chosen, setChosen] = useState(() => { try { return localStorage.getItem(SUMMARIZER_KEY) ?? ''; } catch { return ''; } });
  const member = usable.find(item => item.id === chosen) ?? usable[0];
  const choose = (id: string) => { setChosen(id); try { localStorage.setItem(SUMMARIZER_KEY, id); } catch {} };
  return { member, choose };
}

function SummarizerSelect({ usable, member, onChange }: { usable: TeamMember[]; member?: TeamMember; onChange: (id: string) => void }) {
  if (!usable.length) return <span className="summarizer muted">没有可以整理摘要的成员</span>;
  return <label className="summarizer">由<select aria-label="由谁来压缩" value={member?.id} onChange={event => onChange(event.target.value)}>{usable.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>整理摘要</label>;
}

/** The summary a topic carries, folded by default. */
export function SummaryNote({ thread }: { thread: RoomThread }) {
  return <>
    {thread.inherited && <details className="topic-summary inherited"><summary>延续「{thread.inherited.title}」的摘要</summary><Markdown text={thread.inherited.text} /></details>}
    {thread.summary && <details className="topic-summary"><summary>已压缩 · {thread.summary.byName ?? '成员'} · {dateTime(thread.summary.at)} · 覆盖 {thread.summary.count} 条</summary><Markdown text={thread.summary.text} /></details>}
  </>;
}

/** Start a new topic: archive the current one, optionally carrying a summary of it (or of an archived topic). */
export function NewTopicDialog({ snapshot, current, from, usable, invoke, onClose, onDone, personal=false }: { snapshot: Snapshot; current: RoomThread; from?: RoomThread; usable: TeamMember[]; invoke: Invoke; onClose: () => void; onDone: () => void; personal?:boolean }) {
  const source = from ?? current;
  const hasMessages = (current.count ?? snapshot.room.messages.length) > 0;
  const [title, setTitle] = useState(personal||current.title === '当前话题' ? '' : current.title);
  const [inherit, setInherit] = useState(!personal);
  const [busy, setBusy] = useState(false);
  const summarizer = useSummarizer(usable);
  async function confirm() {
    setBusy(true);
    try {
      if(personal&&inherit)await invoke('room.compress',{threadId:current.id});
      await invoke('room.archive', { title: title.trim() || undefined, inherit: Boolean(from) || inherit, memberId: summarizer.member?.id, from: from?.id }, from ? `新话题会接着「${from.title}」聊。` : inherit ? '已归档，新话题会带上摘要。' : '已归档，开始新话题。');
      onDone();
    } catch {} finally { setBusy(false); }
  }
  const needsWriter = (Boolean(from) || inherit) && !source.summary;
  return <Modal title={from ? '接着这个话题聊' : '开新话题'} subtitle={from ? `新话题会带上「${from.title}」的摘要，成员从摘要继续。` : personal&&!current.id?'新话题将在当前文件夹创建。':'当前话题会归档保存，可以随时查看、导出或删除。'} onClose={() => { if (!busy) onClose(); }} className="topic-dialog">
    <div className="modal-body">
      {(hasMessages||personal) && <label className="field">{personal?'新话题名称':'给当前话题起个名字'}<input aria-label={personal?'新话题名称':'给当前话题起个名字'} value={title} maxLength={64} onChange={event => setTitle(event.target.value)} placeholder={personal?'当前话题':current.title} /><small>{personal?'当前话题会归档，历史里可继续原会话。':'留空就用第一句话作为名字。'}</small></label>}
      {personal&&<p className="panel-muted">新话题在当前文件夹创建。切换工作目录请使用工位顶部的“切换文件夹”。</p>}
      {!from && (!personal||current.id) && <label className="check-row"><input type="checkbox" checked={inherit} onChange={event => setInherit(event.target.checked)} /><span><strong>新话题继承压缩后的上下文</strong><small>成员在新话题里会先看到这段摘要，不需要从头讲起。</small></span></label>}
      {(from || inherit) && <div className="info-card"><Sparkles size={18} /><div>
        <p>{source.summary ? `「${source.title}」已有摘要；如果之后又有新消息，会先更新摘要。` : `会先把「${source.title}」压缩成摘要，这需要使用一次成员额度。`}</p>
        {(needsWriter || source.summary) && <SummarizerSelect usable={usable} member={summarizer.member} onChange={summarizer.choose} />}
      </div></div>}
    </div>
    <div className="modal-footer"><button type="button" className="button quiet" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="button primary" disabled={busy || ((from || inherit) && !summarizer.member) || !snapshot.backendReady} onClick={() => void confirm()}>{busy ? <LoaderCircle size={14} className="spin" /> : <MessageSquarePlus size={14} />}{busy && (from || inherit) ? '正在整理摘要…' : '开始新话题'}</button></div>
  </Modal>;
}

/** Every topic in one place: view, rename, compress, export, clear or delete. */
export function TopicPanel({ snapshot, selectedId, usable, invoke, busy, onSelect, onContinue, onExport, onClear, onClose,onChanged,personal=false,historyOnly=false }: {
  snapshot: Snapshot; selectedId: string; usable: TeamMember[]; invoke: Invoke; busy: boolean;
  onSelect: (id: string) => void; onContinue: (thread: RoomThread) => void; onExport: (id: string) => void; onClear: () => void; onClose: () => void;
  personal?:boolean; historyOnly?:boolean; onChanged?:()=>void;
}) {
  const threads = snapshot.room.threads ?? [];
  const currentId = snapshot.room.currentThreadId;
  const summarizer = useSummarizer(usable);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [deleting,setDeleting]=useState<RoomThread>();
  const locked = busy || Boolean(working) || snapshot.room.state.active || Boolean(snapshot.room.state.compressing) || !snapshot.backendReady;
  // Also refresh immediately after a local action while the backend revision reaches other views.
  async function run(id: string, action: () => Promise<unknown>) { setWorking(id); try { await action(); } catch {} finally { setWorking(null); onChanged?.(); } }
  const compress = (thread: RoomThread) => run(thread.id, () => invoke('room.compress', { threadId: thread.id, memberId: summarizer.member?.id }, thread.id === currentId ? '已压缩，成员接下来从摘要继续。' : '摘要已更新。'));
  const remove = (thread: RoomThread) => {if(personal)setDeleting(thread);else if(window.confirm(`删除归档话题「${thread.title}」？这段记录将永久删除，当前话题不受影响。`))void run(thread.id,()=>invoke('room.delete',{threadId:thread.id},'归档话题已删除。'));};
  const rename = () => { if (!renaming) return; const { id, title } = renaming; setRenaming(null); if (title.trim()) void run(id, () => invoke('room.rename', { threadId: id, title })); };
  return <aside className="topic-panel" aria-label="话题管理">
    <header><div><h2>话题</h2><p>共 {threads.length} 个 · 压缩后成员会从摘要继续，节省上下文</p></div><button type="button" className="icon-button" aria-label="关闭话题管理" title="关闭话题管理" onClick={onClose}><X size={16} /></button></header>
    <div className="topic-panel-tools"><SummarizerSelect usable={usable} member={summarizer.member} onChange={summarizer.choose} /></div>
    <ol className="topic-list">
      {threads.map(thread => {
        const current = thread.id === currentId, selected = thread.id === selectedId, empty = !thread.count;
        return <li key={thread.id} className={`topic-item ${current ? 'current' : ''} ${selected ? 'selected' : ''}`}>
          <div className="topic-item-head">
            {renaming?.id === thread.id ? <input className="topic-rename" autoFocus aria-label="话题名称" value={renaming.title} maxLength={64} onChange={event => setRenaming({ id: thread.id, title: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') rename(); if (event.key === 'Escape') setRenaming(null); }} onBlur={rename} />
              : <strong title={thread.title}>{thread.title}</strong>}
            <span className={`topic-badge ${current ? 'current' : ''}`}>{current ? '当前' : '归档'}</span>
          </div>
          <small className="topic-meta">{thread.count ?? 0} 条消息 · {current ? `开始于 ${dateTime(thread.createdAt)}` : `归档于 ${dateTime(thread.archivedAt)}`}</small>
          <SummaryNote thread={thread} />
          <div className="topic-actions">
            {!selected && <button type="button" className="button small quiet" disabled={personal&&locked} onClick={() => onSelect(thread.id)}><Eye size={13} />{personal?'打开话题':'查看'}</button>}
            <button type="button" className="button small quiet" disabled={locked} onClick={() => setRenaming({ id: thread.id, title: thread.title })}><Pencil size={13} />改名</button>
            <button type="button" className="button small quiet" disabled={locked || historyOnly || (personal&&!current) || (empty && !thread.inherited) || !summarizer.member} onClick={() => void compress(thread)}>{working === thread.id ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />}{thread.summary ? '更新摘要' : '压缩'}</button>
            <button type="button" className="button small quiet" disabled={locked || empty} onClick={() => onExport(thread.id)}><Download size={13} />导出</button>
            {current ? <><button type="button" className="button small quiet" disabled={locked || empty || historyOnly} onClick={onClear}><Eraser size={13} />清空</button>{personal&&<button type="button" className="button small quiet danger" disabled={locked} onClick={()=>remove(thread)}><Trash2 size={13}/>删除</button>}</>
              : <><button type="button" className="button small quiet" disabled={locked} onClick={() => onContinue(thread)}><FileStack size={13} />接着聊</button>
                <button type="button" className="button small quiet danger" disabled={locked} onClick={() => remove(thread)}><Trash2 size={13} />删除</button></>}
          </div>
        </li>;
      })}
    </ol>
    <p className="topic-panel-note"><Archive size={12} />{personal?'打开或接着聊会恢复这个话题的原生会话，话题之间不共享上下文。':'归档的话题只读；“接着聊”会开一个新话题并带上它的摘要。'}</p>
    {deleting&&<Modal title="删除话题" subtitle={'删除「'+deleting.title+'」的聊天记录？'} onClose={()=>{if(!working)setDeleting(undefined);}}><div className="modal-body"><p>这段记录将永久删除，工作文件保留。删除当前话题后会打开本文件夹最近的另一个话题；没有其他话题时显示空状态。</p></div><div className="modal-footer"><button type="button" className="button quiet" disabled={Boolean(working)} onClick={()=>setDeleting(undefined)}>取消</button><button type="button" className="button danger" disabled={locked} onClick={()=>void run(deleting.id,async()=>{await invoke('room.delete',{threadId:deleting.id},'话题已删除。');setDeleting(undefined);})}>确认删除</button></div></Modal>}
  </aside>;
}
