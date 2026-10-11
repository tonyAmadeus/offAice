import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertCircle, ArrowUpRight, FolderX, GitMerge, ChevronRight, CircleHelp, Clock3, Code2, Copy, FileCode2, FilePlus2,
  FileText, FolderOpen, GitCompareArrows, Info, LoaderCircle, MessageSquare, Pause, PencilLine, Play, Plus,
  RefreshCw, Search, ShieldCheck, Sparkles, Square, Terminal, Undo2,
} from 'lucide-react';
import type { Approval, Artifact, Collaboration, MemberPermissions, ProviderInfo, Run, Session, TimelineEvent } from '../shared/types';
import { Markdown } from './Markdown';
import { Avatar, useTeam, type TeamMember } from './members';
import { Modal } from './modals';
import { WorkspaceUndoDialog } from './workspace-undo';
import { prettyCommand, thinkingSegments } from './timeline';
import { Empty, IconButton, runLabel, bytes, errorText, statusClass, time, type Invoke, type Notify, type Perform } from './ui';
import { terminalText } from '../shared/display-text';

export function PlanPanel({ events, session, provider, claudeFileScope, collaborations, onCollaboration, perform,projectWork=false }: {
  events: TimelineEvent[]; session?: Session; provider?: ProviderInfo; claudeFileScope: MemberPermissions['fileScope']; collaborations: Collaboration[]; onCollaboration: () => void; perform: Perform;
  projectWork?:boolean;
}) {
  const team = useTeam();
  const plans = events.filter(event => event.kind === 'plan');
  const reasoning = thinkingSegments(events).segments;
  const claudeLoading = [...events].reverse().find(event => event.provider === 'claude' && (event.data as any)?.loadingMode)?.data as { loadingMode?: string } | undefined;
  const claudeNativeLoading = claudeLoading ? claudeLoading.loadingMode === 'native' : claudeFileScope === 'any';
  return <>
    <div className="panel-section-title">公开计划<span>{plans.length || '—'}</span></div>
    {!plans.length ? <Empty icon={<Sparkles size={22} />} title="计划会出现在这里">成员公开计划后，会跟着实际执行更新。</Empty> : plans.map(event => <div className="plan-card" key={event.id}><div><span className="event-time">{time(event.at)}</span>{event.fidelity !== 'native' && <span className="fidelity-label">{event.fidelity === 'derived' ? '整理记录' : '简化记录'}</span>}</div><Markdown text={event.text} /></div>)}
    {reasoning.length > 0 && <><div className="panel-section-title">公开过程摘要<span>{reasoning.length}</span></div><div className="reasoning-notice"><Info size={12} />成员提供的摘要，不代表完整的内部思考。</div>{reasoning.map((text, index) => <div className="reasoning-card" key={index}><Markdown text={text} /></div>)}</>}
    {!projectWork&&<><div className="panel-section-title">一起协作<button onClick={onCollaboration} disabled={!session}><Plus size={13} />安排</button></div>
    {!collaborations.length ? <p className="panel-muted">请在项目会议室安排新流程。下方保留历史协作记录。</p> : collaborations.map(item => <div className="collaboration-card" key={item.id}><strong>{item.topic.split('\n')[0]}</strong><span>{item.mode === 'relay' ? '接力协作' : '各自作答 → 互审 → 汇总'} · {item.stage}</span><div className="collaboration-members">{item.members.map(member => <Avatar key={member} id={member} size={24} />)}<span>{item.status === 'running' ? '进行中' : item.status === 'paused' ? '已暂停' : item.status === 'ended' ? '流程结束' : '执行失败'}</span></div><span>历史协作记录 · 只读</span></div>)}
    </>}{session && <details className="capability-details">
      <summary>关于 {team.ofSession(session).name} 的能力</summary>
      <div className="capability-list"><span><MessageSquare size={13} />实时输出<strong>{provider ? provider.capabilities.streaming ? '支持' : '有限' : '待检查'}</strong></span><span><PencilLine size={13} />运行中补充<strong>{provider ? provider.capabilities.steer ? '当前轮可介入' : '排到下一轮' : '待检查'}</strong></span><span><Square size={12} />停止执行<strong>{provider ? provider.capabilities.cancel === 'native' ? '可以直接中断' : provider.capabilities.cancel === 'process' ? '结束成员程序' : '取消请求' : '待检查'}</strong></span><span><FileText size={13} />项目修改<strong>{session.writeMode ? '已开启' : '只读'}</strong></span></div>
      {session.provider === 'claude' && <p className="panel-muted">{claudeNativeLoading ? 'Claudia 不受限制地运行，会直接读取你的用户设置和项目约定。具体以活动记录为准。' : 'AIROOM 显式加载当前工作目录的 CLAUDE.md 和 .claude/CLAUDE.md（合计最多 64 KiB）。不自动读取父目录、规则目录、CLAUDE.local.md 和 @ 引用。具体以活动记录为准。'}</p>}
    </details>}
  </>;
}

function eventIcon(kind: TimelineEvent['kind']) {
  if (kind === 'tool') return <Terminal size={13} />;
  if (kind === 'output') return <Code2 size={13} />;
  if (kind === 'error' || kind === 'warning') return <AlertCircle size={13} />;
  if (kind === 'approval') return <ShieldCheck size={13} />;
  if (kind === 'question') return <CircleHelp size={13} />;
  if (kind === 'plan' || kind === 'reasoning') return <Sparkles size={13} />;
  if (kind === 'usage') return <Activity size={13} />;
  return <Clock3 size={13} />;
}
const EVENT_LABELS: Record<TimelineEvent['kind'], string> = { message: '成员输出', delta: '实时输出', reasoning: '公开摘要', plan: '计划', tool: '工具操作', output: '执行输出', approval: '权限请求', question: '提问', status: '执行状态', usage: '使用情况', warning: '提醒', error: '错误', session: '会话记录', image: '生成图片' };

/** One-line, human-readable form of a tool event: commands lose their PowerShell wrapper. */
export function toolLine(event: TimelineEvent) {
  const first = event.text.split('\n')[0] ?? '';
  const match = first.match(/^(开始|结束|调用)：([\s\S]*)$/);
  return match ? `${match[1]}：${prettyCommand(match[2])}` : prettyCommand(first);
}

export function ActivityPanel({ events, runs }: { events: TimelineEvent[]; runs: Run[] }) {
  const activities = events.filter(event => event.kind !== 'delta' && event.kind !== 'message');
  const [filter, setFilter] = useState<'all' | 'tools' | 'alerts'>('all');
  const visible = activities.filter(event => filter === 'all' || (filter === 'tools' ? ['tool', 'output'].includes(event.kind) : ['warning', 'error', 'approval', 'question'].includes(event.kind)));
  return <>
    <div className="activity-filter">{([['all', '全部'], ['tools', '执行'], ['alerts', '提醒']] as const).map(([id, label]) => <button key={id} className={filter === id ? 'selected' : ''} onClick={() => setFilter(id)}>{label}</button>)}</div>
    {!visible.length ? <Empty icon={<Activity size={22} />} title="还没有活动记录">工具操作、执行状态和错误会在这里显示。</Empty> : <div className="activity-timeline">{visible.map(event => <details className={`activity-item ${event.kind}`} key={event.id}><summary><span className="activity-icon">{eventIcon(event.kind)}</span><div><div className="activity-item-heading"><strong>{EVENT_LABELS[event.kind]}</strong><time>{time(event.at)}</time></div><span className="activity-preview">{event.kind === 'tool' ? toolLine(event) : terminalText(event.text).split('\n')[0] || EVENT_LABELS[event.kind]}</span></div><ChevronRight size={12} /></summary><div className="activity-detail"><pre>{terminalText(event.text)}</pre>{event.data != null && <details className="raw-details"><summary>查看结构化记录</summary><pre>{typeof event.data === 'string' ? event.data : JSON.stringify(event.data, null, 2)}</pre></details>}<span className="fidelity-label">{event.fidelity === 'native' ? '成员程序记录' : event.fidelity === 'derived' ? '工作台整理的记录' : '信息简化记录'}</span></div></details>)}</div>}
    {runs.length > 0 && <div className="activity-run-summary"><div className="panel-section-title">任务记录<span>{runs.length}</span></div>{runs.map(run => <div key={run.id}><span>{time(run.createdAt)}</span><strong className={statusClass(run.status)}>{runLabel(run)}</strong><small>方向 {run.revision}</small></div>)}</div>}
  </>;
}

type Change = 'added' | 'modified' | 'deleted';
/** File states from the workspace diff summary ("新增/修改/删除 path" lines). */
export function parseChanges(text: string) {
  const changes = new Map<string, Change>();
  for (const line of text.split('\n')) {
    const match = line.match(/^(新增|修改|删除) (.+)$/);
    if (match) changes.set(match[2].replace(/\\/g, '/'), match[1] === '新增' ? 'added' : match[1] === '修改' ? 'modified' : 'deleted');
  }
  return changes;
}
const CHANGE_LABEL: Record<Change, string> = { added: '新增', modified: '修改', deleted: '删除' };

function DiffView({ text }: { text: string }) {
  return <pre className="diff-preview">{text.split('\n').map((line, index) => {
    const tone = /^(\+\+\+|---)/.test(line) ? 'meta' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : /^(diff --git|index |新增 |修改 |删除 )/.test(line) ? 'meta' : '';
    return <span className={`diff-line ${tone}`} key={index}>{line || ' '}{'\n'}</span>;
  })}</pre>;
}

export function FilesPanel({ session, invoke, eventsCount, notify, busy = false, onApply, onDiscard }: { session?: Session; invoke: Invoke; eventsCount: number; notify: Notify; busy?: boolean; onApply?: () => void; onDiscard?: () => void }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [changes, setChanges] = useState<Map<string, Change>>(new Map());
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(true);
  const [preview, setPreview] = useState<{ title: string; content: string; truncated?: boolean; diff?: boolean; path?: string } | null>(null);
  const [error, setError] = useState('');
  const [undoOpen,setUndoOpen]=useState(false);
  const load = useCallback(async () => {
    if (!session) { setArtifacts([]); setChanges(new Map()); return; }
    setLoading(true); setError('');
    try {
      const [files, diff] = await Promise.all([invoke<Artifact[]>('artifact.list', { sessionId: session.id }), invoke<{ text: string }>('project.diff', { sessionId: session.id }).catch(() => ({ text: '' }))]);
      setArtifacts(files); setChanges(parseChanges(diff?.text ?? ''));
    } catch (failure) { setError(errorText(failure)); }
    finally { setLoading(false); }
  }, [session?.id, invoke]);
  useEffect(() => { setPreview(null); setUndoOpen(false); setQuery(''); void load(); }, [session?.id, load]);
  // Changes can arrive in a burst; request a file list only after the stream settles.
  useEffect(() => { if (!session || !eventsCount) return; const timer = window.setTimeout(() => void load(), 1800); return () => window.clearTimeout(timer); }, [eventsCount, session?.id, load]);
  async function read(file: Artifact) {
    try {
      const result = await invoke<{ content: string; language: string; truncated: boolean }>('artifact.read', { sessionId: session?.id, relativePath: file.relativePath });
      setPreview({ title: file.relativePath, content: result.content, truncated: result.truncated, path: file.relativePath });
    } catch {}
  }
  async function diff() {
    try { const result = await invoke<{ text: string }>('project.diff', { sessionId: session?.id }); setPreview({ title: '项目文件差异', content: result.text || '当前没有可显示的文件差异。', diff: true }); } catch {}
  }
  async function openFile(relativePath: string) {
    try { const result = await invoke<{ detail?: string }>('artifact.open', { sessionId: session?.id, relativePath }); if (result?.detail) notify(result.detail); } catch {}
  }
  // AIROOM's own bookkeeping (.airoom/) is not a member's output.
  const all = artifacts.filter(item => !item.directory && !item.relativePath.replace(/\\/g, '/').startsWith('.airoom/'));
  const changeOf = (file: Artifact) => changes.get(file.relativePath.replace(/\\/g, '/'));
  const changedCount = all.filter(changeOf).length;
  const files = all.filter(item => (!onlyChanged || !changes.size || changeOf(item)) && item.relativePath.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Number(Boolean(changeOf(b))) - Number(Boolean(changeOf(a))));
  const deleted = [...changes].filter(([, kind]) => kind === 'deleted').map(([path]) => path);
  return <>
    {session && <div className="workspace-card">
      <FolderOpen size={16} />
      <span><strong>{session.workspaceKind === 'worktree' ? '独立工作副本' : session.workspaceKind === 'copy' ? '独立目录副本' : session.writeMode ? '独立工作副本' : '项目工作区'}</strong><small title={session.workspace}>{session.workspace ?? (session.writeMode ? '下一轮任务开始时，从项目当前的样子建立' : '只读会话直接查看项目')}</small></span>
      <button className="button small secondary" disabled={!session.workspace} onClick={() => void invoke('workspace.open', { sessionId: session.id }).catch(() => {})}>打开文件夹</button>
    </div>}
    {session?.workspace && session.workspaceKind && session.workspaceKind !== 'original' && <div className="workspace-actions">
      <button className="button small primary" disabled={busy || !changes.size} title={busy ? '任务结束后才能应用' : '把副本里的改动写回项目；有冲突时不会写入任何文件'} onClick={onApply}><GitMerge size={13} />应用到项目</button>
      <button className="button small quiet danger" disabled={busy} title="删除这个工作副本，项目不受影响" onClick={onDiscard}><FolderX size={13} />丢弃副本</button>
      <button className="button small secondary" disabled={busy} title="查看最近一轮的还原点，并撤销它在工作副本里的改动" onClick={()=>setUndoOpen(true)}><Undo2 size={13}/>撤销最近一轮</button>
    </div>}
    <div className="files-toolbar">
      <span>{changes.size ? `${changedCount} 个改动 · 共 ${all.length} 个文件` : `${all.length} 个文件`}</span>
      <div>{changes.size > 0 && <button className={`chip-toggle ${onlyChanged ? 'selected' : ''}`} onClick={() => setOnlyChanged(!onlyChanged)}>只看改动</button>}<IconButton label="查看项目文件差异" onClick={() => void diff()} disabled={!session}><GitCompareArrows size={15} /></IconButton><IconButton label="刷新产出文件" onClick={() => void load()} disabled={loading || !session}><RefreshCw size={14} className={loading ? 'spin' : ''} /></IconButton></div>
    </div>
    {undoOpen&&session&&<WorkspaceUndoDialog session={session} invoke={invoke} notify={notify} onClose={()=>setUndoOpen(false)} onDone={()=>{setUndoOpen(false);void load();}}/>}
    {all.length > 6 && <label className="file-search"><Search size={13} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="查找文件" aria-label="查找产出文件" /></label>}
    {error && <div className="inline-notice error"><AlertCircle size={14} /><span>{error}</span></div>}
    {!files.length ? <Empty icon={<FileText size={22} />} title={loading ? '正在读取文件' : '产出会留在这里'}>{session ? '这里列出工作区的实际文件，验收前可以核对差异。' : '选择一个会话查看产出。'}</Empty> : <div className="file-list">{files.map(file => { const change = changeOf(file); return <button className={`file-row ${change ?? ''}`} key={file.relativePath} onClick={() => void read(file)}>{change === 'added' ? <FilePlus2 size={17} /> : <FileCode2 size={17} />}<span><strong>{file.name}{change && <em className={`change-badge ${change}`}>{CHANGE_LABEL[change]}</em>}</strong><small title={file.relativePath}>{file.relativePath}</small></span><i>{bytes(file.size)}</i><ChevronRight size={12} /></button>; })}</div>}
    {deleted.length > 0 && <div className="inline-notice"><Info size={14} /><span>已删除：{deleted.join('、')}</span></div>}
    {preview && <Modal title={preview.title} subtitle={preview.diff ? '来自当前工作区的实际差异' : changes.get(preview.title.replace(/\\/g, '/')) === 'added' ? '新增文件 · 只读预览' : '只读文本预览'} onClose={() => setPreview(null)} className="preview-modal"><div className="file-preview">{preview.truncated && <div className="inline-notice"><Info size={14} /><span>文件较大，当前预览已截断；打开文件可以查看完整内容。</span></div>}{preview.diff ? <DiffView text={preview.content} /> : <pre>{preview.content}</pre>}</div><div className="modal-footer"><button className="button quiet" onClick={() => { void navigator.clipboard.writeText(preview.content).then(() => notify('已复制预览内容。')).catch(failure => notify(errorText(failure), true)); }}><Copy size={14} />复制内容</button>{preview.path && <button className="button primary" onClick={() => preview.path && void openFile(preview.path)}><ArrowUpRight size={14} />打开文件</button>}</div></Modal>}
  </>;
}

interface QuestionView { key: string; question: string; header?: string; options: { label: string; description?: string }[]; multiSelect?: boolean }
function questionsFor(approval: Approval): QuestionView[] {
  const value = approval.questions;
  const raw = Array.isArray(value) ? value : value && typeof value === 'object' && 'questions' in value ? (value as { questions: unknown }).questions : [];
  if (!Array.isArray(raw)) return [];
  return raw.filter(item => item && typeof item === 'object').map((item, index) => ({
    key: String(item.id ?? item.key ?? item.question ?? index),
    question: String(item.question ?? item.text ?? ''), header: item.header,
    options: Array.isArray(item.options) ? item.options.map((option: unknown) => typeof option === 'string' ? { label: option } : ({ label: String((option as { label?: string }).label ?? ''), description: (option as { description?: string }).description })) : [],
    multiSelect: Boolean(item.multiSelect),
  }));
}

export function ApprovalsPanel({ approvals, invoke, member }: { approvals: Approval[]; invoke: Invoke; member?: TeamMember }) {
  if (!approvals.length) return <Empty icon={<ShieldCheck size={24} />} title="现在不需要你回应">权限请求和成员提问会出现在这里，也会出现在对话里。已过期的请求不会再执行。</Empty>;
  return <div className="approvals-list">{approvals.map(approval => <ApprovalCard key={approval.id} approval={approval} invoke={invoke} member={member} />)}</div>;
}

export function AutoApproveChip({ session, invoke }: { session: Session; invoke: Invoke }) {
  const rules = session.approvalRules ?? [];
  if (!session.autoApprove && !rules.length) return null;
  const label = session.autoApprove ? '自动批准：全部' : `自动批准：${rules.map(rule => rule === 'command' || rule === 'Bash' || rule === 'pwsh' ? '执行命令' : rule === 'fileChange' ? '修改文件' : rule).join('、')}`;
  return <span className="auto-approve-chip"><ShieldCheck size={11} />{label}<button type="button" title="关闭会话自动批准；正在自动执行的 Codex 完全访问轮次会停止。成员基本权限仍由设置决定。" onClick={() => { void invoke('session.approvals', { sessionId: session.id, autoApprove: false, clearRules: true }).catch(() => {}); }} aria-label="关闭本会话的自动批准">关闭</button></span>;
}

const ALLOW = /allow|accept|approve|answer|允许|批准|提交|同意/i;
const DENY = /deny|decline|reject|cancel|拒绝|取消/i;
function consequence(approval: Approval) {
  const category = approval.category ?? '';
  if (/command|bash|pwsh|shell/i.test(category)) return '允许后，这条命令会以你的 Windows 用户权限运行。';
  if (/file/i.test(category) || /Edit|Write/.test(category)) return '允许后，成员会修改工作副本中的文件；改动可以在“产出”里核对。';
  if (/web|fetch|search/i.test(category)) return '允许后，成员会访问网络获取资料。';
  return '允许后，成员会继续执行这一步。';
}

export function ApprovalCard({ approval, invoke, compact = false, member }: { approval: Approval; invoke: Invoke; compact?: boolean; member?: TeamMember }) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [busy, setBusy] = useState(false);
  const questions = questionsFor(approval);
  const team = useTeam();
  const p = member ?? team.get(approval.provider) ?? team.ofSession({provider:approval.provider});
  // Codex sends "reason\ncommand\ncwd"; show the reason as text, the command unwrapped, the directory as a note.
  const { reason, command, cwd } = useMemo(() => {
    const lines = approval.detail.trim().split('\n');
    const at = lines.findIndex(line => prettyCommand(line) !== line);
    if (at < 0) return { reason: undefined, command: undefined, cwd: undefined };
    const after = lines.slice(at + 1).join('\n').trim();
    return {
      reason: lines.slice(0, at).join('\n').trim() || undefined,
      command: prettyCommand(lines[at]),
      cwd: /^[A-Za-z]:[\\/]|^\//.test(after) && !after.includes('\n') ? after : undefined,
    };
  }, [approval.detail]);
  async function answer(choice: string) {
    setBusy(true);
    try { await invoke('approval.answer', { id: approval.id, choice, ...(approval.type === 'question' ? { answers } : {}) }); } catch {} finally { setBusy(false); }
  }
  function setQuestion(key: string, value: string, multi = false) {
    setAnswers(previous => {
      if (!multi) return { ...previous, [key]: value };
      const items = Array.isArray(previous[key]) ? previous[key] as string[] : [];
      return { ...previous, [key]: items.includes(value) ? items.filter(item => item !== value) : [...items, value] };
    });
  }
  const isQuestion = approval.type === 'question';
  return <div className={`approval-card member-${p.id} ${isQuestion ? 'question' : ''} ${compact ? 'compact' : ''}`}>
    <div className="approval-card-header"><Avatar member={p} size={30} mood="waiting" /><span><strong>{p.name}</strong>{isQuestion ? ' 想问你一个问题' : ' 想请你批准'}</span><time>{time(approval.createdAt)}</time></div>
    <h3>{approval.title}</h3>
    {reason && <p className="approval-reason">{reason}</p>}
    {command ? <div className="approval-command"><Terminal size={13} /><code>{command}</code></div> : approval.detail && !isQuestion && <pre className="approval-detail">{approval.detail}</pre>}
    {cwd && <small className="approval-cwd">在 {cwd} 中执行</small>}
    {isQuestion && approval.detail && !questions.length && <p className="approval-question-text">{approval.detail}</p>}
    {questions.map(question => <div className="approval-question" key={question.key}>
      <strong>{question.header ?? question.question}</strong>{question.header && <p>{question.question}</p>}
      {question.options.map(option => {
        const selected = Array.isArray(answers[question.key]) ? (answers[question.key] as string[]).includes(option.label) : answers[question.key] === option.label;
        return <label className={`question-option ${selected ? 'selected' : ''}`} key={option.label}><input type={question.multiSelect ? 'checkbox' : 'radio'} name={`${approval.id}-${question.key}`} checked={selected} onChange={() => setQuestion(question.key, option.label, question.multiSelect)} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label>;
      })}
      <input className="answer-input" aria-label={`自定义回答：${question.question}`} placeholder="或者写下你自己的回答" value={typeof answers[question.key] === 'string' && !question.options.some(option => option.label === answers[question.key]) ? answers[question.key] as string : ''} onChange={event => setQuestion(question.key, event.target.value)} />
    </div>)}
    {isQuestion && !questions.length && <textarea className="answer-input" aria-label="回答成员问题" rows={3} value={String(answers.answer ?? '')} onChange={event => setAnswers({ answer: event.target.value })} placeholder="写下你的回答…" />}
    {!isQuestion && <p className="approval-consequence"><Info size={12} />{consequence(approval)}</p>}
    <div className="approval-options">{approval.options.map(option => {
      const tone = ALLOW.test(option.id + option.label) ? 'primary' : DENY.test(option.id + option.label) ? 'quiet' : 'secondary';
      const scope = option.kind && ({ allow_once: '仅本次', allow_always: '始终允许', reject_once: '仅本次拒绝', reject_always: '始终拒绝' } as Record<string,string>)[option.kind];
      return <button className={`button ${tone}`} key={option.id} disabled={busy} onClick={() => void answer(option.id)}>{busy && tone === 'primary' ? <LoaderCircle size={13} className="spin" /> : null}{option.label}{scope ? ' · ' + scope : ''}</button>;
    })}{!approval.options.length && <div className="inline-notice"><Info size={13} /><span>这个请求还没有提供可用的回应选项。</span></div>}</div>
    {!isQuestion && approval.allowChoice && <details className="approval-delegate">
      <summary>帮我批准 · 更多选项</summary>
      <div className="approval-options">
        {approval.category && <button className="button secondary" disabled={busy} onClick={() => void answer('airoom:allow-category')} title="本会话后续同类请求自动批准">本会话允许「{approval.categoryLabel ?? approval.category}」</button>}
        <button className="button secondary" disabled={busy} onClick={() => void answer('airoom:allow-all')} title="本会话后续所有审批自动批准">本会话全部自动批准</button>
      </div>
      <span className="approval-explainer">自动批准使用成员自己的“允许这次”，每一项都记入活动；可以在会话标题旁随时关闭。</span>
      {approval.denyChoice && <button className="button danger-outline" disabled={busy} onClick={() => { if (window.confirm('拒绝这项请求，并停止本轮任务？已写入的文件会保留。')) void answer('airoom:deny-stop'); }}>拒绝并停止本轮</button>}
    </details>}
    <span className="approval-explainer">操作范围以成员程序发来的请求为准；停止任务后，这个请求会失效。</span>
  </div>;
}

export function LoadingLine() { return <span className="loading-line"><LoaderCircle size={13} className="spin" /></span>; }
