import { useMemo, useState } from 'react';
import { Briefcase, CheckCheck, CheckCircle2, History, LoaderCircle, SearchCheck, Undo2 } from 'lucide-react';
import type { RoomMessage, RunSummary, Snapshot } from '../shared/types';
import { Markdown } from './Markdown';
import { Modal } from './modals';
import { Avatar, useTeam } from './members';
import { runnable, sessionTitle, type Invoke } from './ui';

export interface HandoffSource { threadId: string; messageId?: string; text: string }

/** Hand a room conclusion to a project: pick the project and member, then a new or existing session. */
export function HandoffDialog({ snapshot, invoke, source, onClose, onDone }: { snapshot: Snapshot; invoke: Invoke; source: HandoffSource; onClose: () => void; onDone: (target: { projectId: string; sessionId: string }) => void }) {
  const team = useTeam();
  const projects = snapshot.projects.filter(project => !project.kind);
  const ready = team.members.filter(member => runnable(snapshot.providers.find(item => item.id === member.executor)));
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [memberId, setMemberId] = useState(ready[0]?.id ?? '');
  const sessions = useMemo(() => snapshot.sessions.filter(session => session.projectId === projectId && !session.archived && team.ofSession(session).id === memberId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [snapshot.sessions, projectId, memberId, team]);
  const [sessionId, setSessionId] = useState('');
  const [writeMode, setWriteMode] = useState(snapshot.settings.defaultWriteMode);
  const [text, setText] = useState(source.text);
  const [busy, setBusy] = useState(false);
  const firstInput = (id: string) => snapshot.runs.filter(run => run.sessionId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]?.inputPreview;
  const chosenSession = sessions.find(session => session.id === sessionId);
  const member = team.get(memberId);
  async function submit() {
    setBusy(true);
    try {
      const result = await invoke<{ projectId: string; sessionId: string }>('room.handoff', { projectId, memberId, sessionId: chosenSession?.id, writeMode, text, threadId: source.threadId, messageId: source.messageId }, `已交给 ${member?.name ?? '成员'}，完成后会在聊天室告诉你。`);
      onDone(result);
    } catch {} finally { setBusy(false); }
  }
  return <Modal title="交给项目" subtitle="把聊天室里的结论变成项目任务；完成后会回到这里告诉你。" onClose={() => { if (!busy) onClose(); }} className="handoff-dialog">
    <div className="modal-body">
      {!projects.length ? <div className="info-card"><Briefcase size={18} /><p>还没有工作项目。先在左侧“项目”里添加一个，再把任务交过去。</p></div> : <>
        <div className="card-field-row">
          <label className="field">项目<select aria-label="交给哪个项目" value={projectId} onChange={event => { setProjectId(event.target.value); setSessionId(''); }}>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <label className="field">成员<select aria-label="交给哪位成员" value={memberId} onChange={event => { setMemberId(event.target.value); setSessionId(''); }}>{ready.map(item => <option key={item.id} value={item.id}>{item.name} · {item.product}</option>)}</select>
            {!ready.length && <small>还没有可以工作的成员，请先在设置里检查连接。</small>}</label>
        </div>
        <div className="field">会话
          <div className="segmented" role="radiogroup" aria-label="会话">
            <button type="button" role="radio" aria-checked={!chosenSession} className={!chosenSession ? 'selected' : ''} onClick={() => setSessionId('')}>新建会话</button>
            <button type="button" role="radio" aria-checked={Boolean(chosenSession)} className={chosenSession ? 'selected' : ''} disabled={!sessions.length} onClick={() => setSessionId(sessions[0]?.id ?? '')}>接着已有会话{sessions.length ? `（${sessions.length}）` : ''}</button>
          </div>
          {chosenSession ? <select aria-label="选择已有会话" value={chosenSession.id} onChange={event => setSessionId(event.target.value)}>{sessions.map(session => <option key={session.id} value={session.id}>{sessionTitle(session, firstInput(session.id))}{session.writeMode ? '' : ' · 只读'}</option>)}</select>
            : <label className="check-row"><input type="checkbox" checked={writeMode} onChange={event => setWriteMode(event.target.checked)} /><span><strong>允许修改文件</strong><small>在独立工作副本里修改，由你检查后再决定是否采用。</small></span></label>}
        </div>
        <label className="field">任务内容<textarea aria-label="交给项目的任务" rows={8} value={text} maxLength={20000} onChange={event => setText(event.target.value)} /><small>可以先改一改，比如补充完成标准或限制。</small></label>
        {member && <div className="handoff-preview"><Avatar member={member} size={28} /><span>{member.name} 会在项目里{chosenSession ? '接着这个会话' : '开一个新会话'}完成它，进展可以随时在项目里查看。</span></div>}
      </>}
    </div>
    <div className="modal-footer"><button type="button" className="button quiet" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="button primary" disabled={busy || !projectId || !memberId || !text.trim() || !snapshot.backendReady} onClick={() => void submit()}>{busy ? <LoaderCircle size={14} className="spin" /> : <Briefcase size={14} />}交给 {member?.name ?? '成员'}</button></div>
  </Modal>;
}

/** A room note about project work. Outcome notes show the answer and let the user accept, send back or ask for a review. */
export function RoomNote({ message, snapshot, invoke, archived, onOpen }: { message: RoomMessage; snapshot: Snapshot; invoke: Invoke; archived: boolean; onOpen: (projectId: string, sessionId: string) => void }) {
  const team = useTeam();
  const [dialog, setDialog] = useState<'return' | 'review' | null>(null);
  const [busy, setBusy] = useState(false);
  const link = message.link!;
  const target = link.reviewOf ?? (link.runId ? { sessionId: link.sessionId, runId: link.runId } : undefined);
  const run = target && snapshot.runs.find(item => item.id === target.runId);
  const targetSession = target && snapshot.sessions.find(item => item.id === target.sessionId);
  const author = targetSession ? team.ofSession(targetSession) : undefined;
  // A run validated in its project session counts as accepted here too.
  const undone=Boolean(link.undoneAt||run?.workspaceUndo?.status==='undone');
  const decided = undone?undefined:link.verdict ?? (link.outcome && run?.status === 'completed' ? 'accepted' : undefined);
  const deciding = !archived && !undone && !decided && run?.workspaceUndo?.status!=='capturing' && (link.outcome === 'ended' || link.outcome === 'completed') && run?.status === 'ended';
  // A review only vouches for the files it saw; after further edits it can still be sent back, not used to accept.
  const stale = Boolean(link.reviewOf && link.reviewStale && !decided);
  async function accept() {
    setBusy(true);
    try { await invoke('run.verdict', { messageId: message.id, verdict: 'accepted' }, '已记录验收通过。'); } catch {} finally { setBusy(false); }
  }
  return <div className={`room-note ${decided ?? ''}`} data-message-id={message.id}>
    <button type="button" className="room-system link" onClick={() => onOpen(link.projectId, link.sessionId)}>{message.text}<span>打开会话</span></button>
    {message.detail && <details className="room-note-detail"><summary>{link.reviewOf ? '查看复核结论' : `查看 ${author?.name ?? '成员'} 的回答`}</summary><Markdown text={message.detail} /></details>}
    {undone&&<span className="room-note-verdict"><Undo2 size={12}/>对应轮次的文件改动已撤销</span>}
    {stale&&<span className="room-note-verdict stale"><History size={12}/>复核之后 {author?.name ?? '成员'} 的文件又改过，这份结论已过期</span>}
    {decided ? <span className={`room-note-verdict ${decided}`}>{decided === 'accepted' ? <><CheckCircle2 size={12} />已验收通过</> : <><Undo2 size={12} />已打回修改</>}</span>
      : deciding && <div className="room-note-actions">
        {link.reviewOf && <button type="button" className="button small secondary" disabled={busy} onClick={() => setDialog('return')}><Undo2 size={13} />交给 {author?.name ?? '成员'} 修改</button>}
        {!stale && <button type="button" className="button small secondary" disabled={busy || !snapshot.backendReady} onClick={() => void accept()}>{busy ? <LoaderCircle size={13} className="spin" /> : <CheckCheck size={13} />}{link.reviewOf ? '复核没问题，通过' : '通过'}</button>}
        {!link.reviewOf && <>
          <button type="button" className="button small secondary" disabled={busy} onClick={() => setDialog('return')}><Undo2 size={13} />打回修改</button>
          <button type="button" className="button small secondary" disabled={busy} onClick={() => setDialog('review')}><SearchCheck size={13} />请人复核</button>
        </>}
      </div>}
    {dialog === 'review' && run && <ReviewDialog snapshot={snapshot} invoke={invoke} run={run} threadId={message.threadId} messageId={message.id} onClose={() => setDialog(null)} onDone={() => setDialog(null)} />}
    {dialog === 'return' && <ReturnDialog invoke={invoke} messageId={message.id} name={author?.name ?? '成员'} initial={link.reviewOf ? message.detail ?? '' : ''} fromReview={Boolean(link.reviewOf)} onClose={() => setDialog(null)} />}
  </div>;
}

/** Ask another member to check a finished run read-only; the answer comes back as 已核实 / 需实测 / 建议. */
export function ReviewDialog({ snapshot, invoke, run, threadId, messageId, onClose, onDone }: { snapshot: Snapshot; invoke: Invoke; run: RunSummary; threadId?: string; messageId?: string; onClose: () => void; onDone: (target: { projectId: string; sessionId: string }) => void }) {
  const team = useTeam();
  const session = snapshot.sessions.find(item => item.id === run.sessionId);
  const author = session ? team.ofSession(session) : undefined;
  const ready = team.members.filter(member => member.id !== author?.id && runnable(snapshot.providers.find(item => item.id === member.executor)));
  const [memberId, setMemberId] = useState(ready[0]?.id ?? '');
  const [focus, setFocus] = useState('');
  const [busy, setBusy] = useState(false);
  const reviewer = team.get(memberId);
  // The room hears about it when asked from there, or when the reviewed task came from the room.
  const reported = Boolean(threadId || run.origin?.threadId);
  const copied = Boolean(session?.workspace && session.workspaceKind && session.workspaceKind !== 'original');
  async function submit() {
    setBusy(true);
    try {
      const result = await invoke<{ projectId: string; sessionId: string }>('run.review', { runId: run.id, memberId, focus, threadId, messageId }, `已请 ${reviewer?.name ?? '成员'} 复核${reported ? '，完成后会在聊天室告诉你' : ''}。`);
      onDone(result);
    } catch {} finally { setBusy(false); }
  }
  return <Modal title="请人复核" subtitle={`另一位成员以只读方式检查 ${author?.name ?? '成员'} 的结果，按已核实、需实测、建议三类给出结论。`} onClose={() => { if (!busy) onClose(); }} className="handoff-dialog">
    <div className="modal-body">
      <label className="field">复核成员<select aria-label="复核成员" value={memberId} onChange={event => setMemberId(event.target.value)}>{ready.map(item => <option key={item.id} value={item.id}>{item.name} · {item.product}</option>)}</select>
        {!ready.length && <small>没有其他可以工作的成员，请先在设置里检查连接。</small>}</label>
      <label className="field">复核重点（可选）<textarea aria-label="复核重点" rows={3} maxLength={4000} value={focus} onChange={event => setFocus(event.target.value)} placeholder="例如：重点看登录流程和错误处理。" /></label>
      {reviewer && <div className="handoff-preview"><Avatar member={reviewer} size={28} /><span>{reviewer.name} 会拿到原任务、{author?.name ?? '成员'} 的回答{copied ? '和文件改动，并直接读取 TA 的工作副本' : ''}；不会修改任何文件。{reported ? '结论会回到聊天室。' : ''}</span></div>}
    </div>
    <div className="modal-footer"><button type="button" className="button quiet" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="button primary" disabled={busy || !reviewer || !snapshot.backendReady} onClick={() => void submit()}>{busy ? <LoaderCircle size={14} className="spin" /> : <SearchCheck size={14} />}请 {reviewer?.name ?? '成员'} 复核</button></div>
  </Modal>;
}

/** Send a result back to the member who produced it, with the user's (or the reviewer's) comments. */
function ReturnDialog({ invoke, messageId, name, initial, fromReview, onClose }: { invoke: Invoke; messageId: string; name: string; initial: string; fromReview: boolean; onClose: () => void }) {
  const [note, setNote] = useState(initial);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try { await invoke('run.verdict', { messageId, verdict: 'returned', note }, `已交回 ${name} 修改，完成后会在聊天室告诉你。`); onClose(); } catch {} finally { setBusy(false); }
  }
  return <Modal title={fromReview ? `交给 ${name} 修改` : '打回修改'} subtitle={`${name} 会在原来的会话里接着改，完成后回到聊天室告诉你。`} onClose={() => { if (!busy) onClose(); }} className="handoff-dialog">
    <div className="modal-body">
      <label className="field">修改意见<textarea aria-label="修改意见" rows={fromReview ? 10 : 5} maxLength={20000} value={note} onChange={event => setNote(event.target.value)} placeholder="补充修改意见（可选）。" autoFocus />
        {fromReview && <small>已填入复核结论，可以删掉不需要改的部分。</small>}</label>
    </div>
    <div className="modal-footer"><button type="button" className="button quiet" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="button primary" disabled={busy} onClick={() => void submit()}>{busy ? <LoaderCircle size={14} className="spin" /> : <Undo2 size={14} />}交回 {name} 修改</button></div>
  </Modal>;
}
