import {applySnapshotPatch,acceptSnapshot} from '../shared/snapshot-sync';
import { ProjectRoom, PROJECT_FLOW_READS } from './project-room';
import {MemberReports} from './member-reports';
import type {ReportEntry} from './report-switcher';
import {MemberDesk} from './member-desk';
import type {MemberReportPage} from '../shared/project-workbench';
import './project-workbench.css';
import { isConversationSession } from '../shared/session-classification';
import { idleActivity } from './life-status';
import { unwrapProjectFlowReply } from '../shared/project-flow';
import { AttentionEntry } from './attention';
import type { AttentionItem } from '../shared/attention';
import type { RoomFocus } from './room';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, CalendarClock, AlertCircle, ArrowDown, ArrowRight, ArrowUpRight, Bell, CheckCheck, CheckCircle2, ChevronDown, ChevronRight,
  Copy, Folder, FolderOpen, Globe2, Info, LoaderCircle, LockKeyhole, MessageCircleQuestion, PanelRightClose, PanelRightOpen,
  Pause, PencilLine, Play, Plus, RefreshCw, Search, Send, Settings2, ShieldCheck, Sparkles, StopCircle, Users, X,
  Archive, ArchiveRestore, Columns2, Download, MoreHorizontal, Pin, PinOff, RotateCcw, Trash2, GitMerge, FolderX, Pencil, MessagesSquare, IdCard, SearchCheck, Laptop,
} from 'lucide-react';
import { BUILTIN_MEMBERS, DEFAULT_PROFILE, DEFAULT_SETTINGS, PROVIDER_NAMES, rememberExecutors } from '../shared/defaults';
import type { Approval, Collaboration, MemberProfile, Project, ProviderId, Run, Session, Settings, Snapshot, TimelineEvent } from '../shared/types';
import { Markdown, plainText } from './Markdown';
import { ErrorBoundary } from './ErrorBoundary';
import { Avatar, MOOD_TEXT, Portrait, TeamColors, TeamProvider, UserAvatar, makeTeam, memberIdOf, moodOf, type Mood, type Team, type TeamMember } from './members';
import { InviteModal, Modal, ProjectModal, SessionModal } from './modals';
import {ProjectHierarchyModal} from './project-tree';
import {projectRows,descendantIds} from '../shared/project-tree';
import { needsMembers, saveProjectMembers } from './project-members';
import { ActivityPanel, ApprovalCard, ApprovalsPanel, AutoApproveChip, FilesPanel, PlanPanel, toolLine } from './panels';
import { RoomView } from './room';
import {RoundtableView,type RoundtableRequest} from './roundtable';
import {ROUNDTABLE_READS} from '../shared/roundtable';
import {RoundtableNavigation} from './roundtable-navigation';
import { ReviewDialog } from './handoff';
import { SetupChecklist } from './setup';
import { MemberCard, type MemberCardTarget, type MemberStatus } from './member-card';
import { byActivity } from './session-order';

/** The team room beside the open session: remembered per computer, offered from this window width. */
const SPLIT_KEY = 'airoom.split', SPLIT_MIN_WIDTH = 1400;
import { AttachButton, AttachmentList, AttachmentTray, useAttachments } from './attachments';
import { GeneratedImages } from './generated-images';
import { SettingsModal, type Installs, type SettingsTab, type ThemeChoice } from './settings';
import { assistantText, memberQuestions, supplements, thinkingSeconds, thinkingSegments } from './timeline';
import { resetText, usageOf } from './usage';
import { QuotaBadge, QuotaOverview } from './quota';
import { AutomationPanel } from './automation';
import { ContextMenu, ModelPopover, QuickSwitcher, conversationMarkdown, isBusy, useMemberNotifications, useUnread, type MenuItem, type MenuState } from './interactions';
import {refreshAfterRpc} from '../shared/rpc-refresh';
import {
  IconButton, PROVIDERS, runLabel, accessLevel, errorText, greeting, isActiveRun, providerSummary, runnable,
  sessionTitle, statusClass, time, useTicker, type Invoke,
} from './ui';
import { useSegmentedIndicator } from './segmented-indicator';
import { isSendKey } from './composer-keys';

const EMPTY_SNAPSHOT: Snapshot = {
  projects: [], sessions: [], runs: [], events: [], approvals: [], providers: [],
  settings: DEFAULT_SETTINGS, collaborations: [], dataDirectory: '', backendReady: false,
  deepseekKeyConfigured: false, members: [], profile: DEFAULT_PROFILE,
  room: { messages: [], state: { active: false, mode: 'chat' }, currentThreadId: 'room-main', threads: [{ id: 'room-main', title: '当前话题', createdAt: '' }], hasMore: false },
};

/** A backend from before cards and the room sends none of those fields; fill them so the room still renders. */
const withDefaults = (snapshot: Snapshot): Snapshot => {
  // Connected programs are named like built-in executors everywhere, so register their names first.
  rememberExecutors(snapshot.executors ?? []);
  return withSnapshotDefaults(snapshot);
};
// A missing roster is a legacy backend; an explicit [] is a real empty team and must stay empty.
const withSnapshotDefaults = (snapshot: Snapshot): Snapshot => ({ ...snapshot, executors: snapshot.executors ?? [], members: snapshot.members ?? BUILTIN_MEMBERS, profile: snapshot.profile ?? DEFAULT_PROFILE, room: { ...EMPTY_SNAPSHOT.room, ...snapshot.room, threads: snapshot.room?.threads ?? EMPTY_SNAPSHOT.room.threads } });

/** Combine event lists without duplicates, keeping the first list's order and appending newer ones. */
function mergeEvents(base: TimelineEvent[], extra: TimelineEvent[]) {
  if (!extra.length) return base;
  const known = new Set(base.map(event => event.id));
  const added = extra.filter(event => !known.has(event.id));
  return added.length ? [...base, ...added] : base;
}

type SideTab = 'plan' | 'activity' | 'files' | 'approvals';
type ModalName = 'project' | 'session' | 'settings' | 'collaboration' | 'invite' | null;
type Toast = { id: number; text: string; error?: boolean };

const THEME_KEY = 'airoom.theme';
function readTheme(): ThemeChoice {
  try { const value = localStorage.getItem(THEME_KEY); return value === 'light' || value === 'dark' ? value : 'system'; } catch { return 'system'; }
}

/** Mostly-Latin reasoning is the member's original language; say so instead of leaving it unexplained. */
const isMostlyLatin = (text: string) => { const letters = text.match(/[A-Za-z]/g)?.length ?? 0; const han = text.match(/[一-鿿]/g)?.length ?? 0; return letters > 40 && letters > han * 3; };

function ThinkingBlock({ run, events, active, answering }: { run: Run; events: TimelineEvent[]; active: boolean; answering: boolean }) {
  const { segments } = useMemo(() => thinkingSegments(events), [events]);
  // null follows the run: open while the member is still thinking, folded once the answer starts.
  const [choice, setChoice] = useState<boolean | null>(null);
  const thinking = active && !answering;
  const open = choice ?? thinking;
  const body = useRef<HTMLDivElement>(null);
  const id = useMemo(() => `thinking-${Math.random().toString(36).slice(2)}`, []);
  const now = useTicker(thinking);
  const length = segments.join('').length;
  useEffect(() => { if (open && thinking && body.current) body.current.scrollTop = body.current.scrollHeight; }, [open, thinking, length]);
  if (!segments.length) return null;
  const seconds = thinkingSeconds(run.createdAt, events, now);
  const preview = plainText(segments.at(-1)!);
  const latin = isMostlyLatin(segments.join(' '));
  return <div className={`thinking-block ${open ? 'open' : ''} ${thinking ? 'live' : ''}`}>
    <button type="button" className="thinking-toggle" aria-expanded={open} aria-controls={id} onClick={() => setChoice(!open)}>
      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      <Sparkles size={13} />
      <span className="thinking-title">{thinking ? `正在思考 · ${seconds} 秒` : `思考了 ${seconds} 秒`}</span>
      {segments.length > 1 && <span className="thinking-count">{segments.length} 段</span>}
      {latin && <span className="thinking-count">英文原文</span>}
      {!open && <span className="thinking-preview">{preview}</span>}
    </button>
    {open && <div className="thinking-body" id={id} ref={body}>
      {segments.map((text, index) => <div className="thinking-segment" key={index}><Markdown text={text} /></div>)}
      <p className="thinking-caption">成员公开返回的思考内容，可能是摘要，不代表完整的内部思考{latin ? '；模型常用英文思考，回答仍会用中文' : ''}。</p>
    </div>}
  </div>;
}

const PLACEHOLDER: Partial<Record<Run['status'], string>> = {
  queued: '任务排好队了，马上轮到。', waiting_user: '需要你的回应后继续。', rate_limited: '额度或请求频率受限，等待恢复。',
  stopping: '正在停下来，并核对执行状态。', stopped: '这一轮已停止，没有正文输出。', failed: '这一轮没能完成，原因见下方和活动记录。',
  unknown: '还不确定这一轮有没有送达或做完，请先核对，免得重复执行。',
};

function RunBlock({ run, member: p, user, events, approvals, invoke, notify, onProcess, onShare,shareLabel, onValidate, onReview, onAnswer, onRetry, onLogin }: {
  run: Run; member: TeamMember; user: { name: string; avatar?: string }; events: TimelineEvent[]; approvals: Approval[]; invoke: Invoke; notify: (text: string, error?: boolean) => void;
  onProcess: () => void; onShare?: () => void;shareLabel?:string; onValidate?: () => void; onReview?: () => void; onAnswer: (text: string) => void; onRetry: (text: string) => void; onLogin: () => void;
}) {
  const text = assistantText(events);
  const active = isActiveRun(run);
  const warnings = events.filter(event => event.kind === 'warning' || event.kind === 'error');
  const tools = events.filter(event => event.kind === 'tool' && /^(开始|调用)：/.test(event.text));
  const publicEvents = events.filter(event => ['plan', 'reasoning', 'tool', 'output'].includes(event.kind));
  const added = supplements(events);
  const asked = memberQuestions(events);
  const mood: Mood | undefined = run.status === 'waiting_user' || approvals.length ? 'waiting' : active || run.status === 'queued' ? 'working' : undefined;
  return <div className="run-block">
    <div className="user-message">
      <div className="message-label"><time>{time(run.createdAt)}</time>{run.revision > 1 && <span className="revision-label" title="停止或改变方向后，任务版本会加一">方向版本 {run.revision}</span>}<strong>{user.name}</strong><UserAvatar name={user.name} avatar={user.avatar} size={22} /></div>
      <div className="user-bubble">{run.input}</div>
      <AttachmentList items={run.attachments} invoke={invoke} align="end" />
      {added.map(event => <div className="supplement-note" key={event.id}><PencilLine size={12} /><span>补充：{event.text}</span><time>{time(event.at)}</time></div>)}
    </div>
    <div className={`member-message member-${p.id}`}>
      <Avatar member={p} size={38} mood={mood} />
      <div className="member-body">
        <div className="message-label"><strong>{p.name}</strong><small>{PROVIDER_NAMES[run.provider]}</small><span className={`run-status ${statusClass(run.status)}`}>{active && <span className="status-dot" />}{runLabel(run)}</span></div>
        <ThinkingBlock run={run} events={events} active={active} answering={!!text} />
        <GeneratedImages images={run.generatedImages} invoke={invoke}/>
        {text ? <div className="member-card"><Markdown text={text} /></div>
          : run.status === 'waiting_user' && approvals.length ? null : <div className={`message-placeholder ${active && run.status !== 'waiting_user' ? 'working' : ''}`}>{active && run.status === 'running' ? <><span className="typing-dots"><i /><i /><i /></span>{tools.length ? `${p.name} 正在动手：${toolLine(tools.at(-1)!)}` : `${p.name} 正在处理，输出会实时出现在这里。`}</> : PLACEHOLDER[run.status] ?? '这一轮没有正文输出。'}</div>}
        {asked.map((question, index) => <div className="member-question" key={index}>
          <MessageCircleQuestion size={15} /><div><strong>{question.title}</strong>
            {question.options.length > 0 && <div className="member-question-options">{question.options.map(option => <button type="button" key={option} onClick={() => onAnswer(option)}>{option}</button>)}</div>}
            <small>点一个选项会填进输入框，发出后 {p.name} 会在下一轮接着做。</small></div>
        </div>)}
        {approvals.map(approval => <ApprovalCard key={approval.id} approval={approval} invoke={invoke} member={p} compact />)}
        {publicEvents.length > 0 && <button className="process-link" onClick={onProcess}><Activity size={13} /><span>{tools.length ? `做了 ${tools.length} 个操作` : `${publicEvents.length} 条过程记录`} · 查看过程</span><ArrowUpRight size={12} /></button>}
        {warnings.slice(-2).map(event => <div className={`inline-notice ${event.kind === 'error' ? 'error' : ''}`} key={event.id}><AlertCircle size={14} /><span>{event.text}</span></div>)}
        {run.error && !warnings.some(event => event.text.includes(run.error!)) && <div className="inline-notice error"><AlertCircle size={14} /><span>{run.error}</span></div>}
        {run.status === 'failed' && /authenticat|OAuth|log ?in|登录|认证/i.test(run.error ?? '') && <div className="inline-notice"><Info size={14} /><span>{p.name} 的登录已失效，需要重新登录后再试。登录由官方程序完成，AIROOM 不接触你的账号密码。</span><button type="button" className="button small secondary" onClick={onLogin}>去重新登录</button></div>}
        <div className="message-footer">
          {text && <IconButton label="复制成员输出" onClick={() => { void navigator.clipboard.writeText(text).then(() => notify('已复制输出。')).catch(error => notify(errorText(error), true)); }}><Copy size={13} /></IconButton>}
          {text&&onShare&&['ended','completed'].includes(run.status)&&<button className="share-output" onClick={onShare}><Users size={12}/>{shareLabel??'成果评审'}</button>}
          {['stopped', 'failed', 'unknown', 'interrupted'].includes(run.status) && <button className="share-output" onClick={() => onRetry(run.input)} title="把这一轮的任务放回输入框，确认后再发送"><RotateCcw size={12} />再试一次</button>}
          {text && onReview && ['ended', 'completed'].includes(run.status) && !['undone','capturing'].includes(run.workspaceUndo?.status??'') && <button className="share-output" onClick={onReview} title="请另一位成员以只读方式检查这一轮的结果"><SearchCheck size={12} />请人复核</button>}
          {onValidate && run.status === 'ended' && !['undone','capturing'].includes(run.workspaceUndo?.status??'') && <button className="button small secondary" onClick={onValidate}><CheckCheck size={13} />记录验收</button>}
          {run.workspaceUndo?.status==='undone'&&<span className="validation-note"><RotateCcw size={12}/>本轮文件改动已撤销</span>}
          {run.validation && <span className="validation-note"><CheckCircle2 size={12} />{run.validation}</span>}
          {run.delivery === 'unknown' && <span className="delivery-warning">送达待核对</span>}
        </div>
      </div>
    </div>
  </div>;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [memberStop,setMemberStop]=useState<{memberId:string;token:string;runs:{runId:string;title:string;location:string;projectName?:string}[]}>(),[memberStopping,setMemberStopping]=useState(false),[memberStopError,setMemberStopError]=useState('');
  // Snapshots carry only live events; the open session's full record is fetched and kept current here.
  const [opened, setOpened] = useState<{ sessionId: string; events: TimelineEvent[] } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [backendMessage, setBackendMessage] = useState('');
  const [projectId, setProjectId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [modal, setModal] = useState<ModalName>(null);
  const [hierarchy,setHierarchy]=useState<{mode:'child'|'move';target:Project}>();
  const [collapsedProjects,setCollapsedProjects]=useState<Set<string>>(()=>{try{const ids=JSON.parse(localStorage.getItem('airoom.project-tree.collapsed')??'[]');return new Set(Array.isArray(ids)?ids.filter(id=>typeof id==='string').slice(0,5000):[]);}catch{return new Set();}});
  useEffect(()=>{try{localStorage.setItem('airoom.project-tree.collapsed',JSON.stringify([...collapsedProjects]));}catch{}},[collapsedProjects]);
  useEffect(()=>{const byId=new Map(snapshot.projects.map(p=>[p.id,p])),ancestors=new Set<string>();let p=byId.get(projectId);while(p?.parentId&&!ancestors.has(p.parentId)){ancestors.add(p.parentId);p=byId.get(p.parentId);}setCollapsedProjects(old=>{if(![...ancestors].some(id=>old.has(id)))return old;return new Set([...old].filter(id=>!ancestors.has(id)));});},[projectId,snapshot.projects.map(p=>p.id+':'+p.parentId).join('|')]);
  const [quotaOpen,setQuotaOpen]=useState(false);
  const [automationOpen,setAutomationOpen]=useState(false);
  const [sessionPreset, setSessionPreset] = useState<string | undefined>();
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('members');
  const [settingsEditing, setSettingsEditing] = useState<string | null>(null);
  const [settingsFocus, setSettingsFocus] = useState<string | null>(null);
  const [view, setView] = useState<'work' | 'room' | 'project' | 'desk' | 'reports' | 'roundtable'>('work');
  const [deskMemberId,setDeskMemberId]=useState('codex'),[reportMemberId,setReportMemberId]=useState('codex'),[reportRosterState,setReportRoster]=useState<{projectId:string;members:MemberReportPage['members']}>({projectId:'',members:[]});
  const reportRoster=reportRosterState.projectId===projectId?reportRosterState.members:[];
  const reportEntries:ReportEntry[]=reportRoster.map(m=>({...m,unread:snapshot.rooms?.some(r=>r.roomId===`report:${projectId}:${m.id}`&&r.unread)}));
  const openReport=(memberId:string)=>{setReportMemberId(memberId);setView('reports');setSessionId('');};
  const [roomFocus, setRoomFocus] = useState<RoomFocus>();
  const [roundtableRequest,setRoundtableRequest]=useState<RoundtableRequest>();
  const [inviteProject, setInviteProject] = useState<string>();
  const [sideTab, setSideTab] = useState<SideTab>('plan');
  const [sideOpen, setSideOpen] = useState(true);
  const [split, setSplit] = useState(() => { try { return localStorage.getItem(SPLIT_KEY) === 'on'; } catch { return false; } });
  const [wide, setWide] = useState(() => window.innerWidth >= SPLIT_MIN_WIDTH);
  useEffect(() => { const update = () => setWide(window.innerWidth >= SPLIT_MIN_WIDTH); window.addEventListener('resize', update); return () => window.removeEventListener('resize', update); }, []);
  const [toast, setToast] = useState<Toast | null>(null);
  const [draft, setDraft] = useState('');
  const [intent, setIntent] = useState<'message' | 'supplement' | 'redirect'>('message');
  const [sending, setSending] = useState(false);
  const [probing, setProbing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [search, setSearch] = useState('');
  const [nearBottom, setNearBottom] = useState(true);
  const [validationRun, setValidationRun] = useState<Run | null>(null);
  const [reviewRun, setReviewRun] = useState<Run | null>(null);
  const [validation, setValidation] = useState('');
  const [installs, setInstalls] = useState<Installs>({});
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const [menu, setMenu] = useState<MenuState>(null);
  const [renaming, setRenaming] = useState<{ kind: 'session' | 'project'; id: string; value: string } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'delete-session' | 'remove-project' | 'discard'; id: string; discard: boolean } | null>(null);
  const [applyResult, setApplyResult] = useState<{ sessionId: string; applied: { path: string; kind: string }[]; conflicts: { path: string; reason: string }[]; unchanged: boolean } | null>(null);
  const [switcher, setSwitcher] = useState(false);
  useSegmentedIndicator();
  const [showArchived, setShowArchived] = useState(false);
  const [modelAnchor, setModelAnchor] = useState<DOMRect | null>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const toastCounter = useRef(0);

  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
  }, [theme]);

  const notify = useCallback((text: string, error = false) => {
    setToast({ id: ++toastCounter.current, text, error });
  }, []);
  const refresh = useCallback(async () => {
    if (!window.airoom) throw new Error('请在 AIROOM 桌面应用中打开工作台。');
    const next = withDefaults(await window.airoom.invoke<Snapshot>('snapshot'));
    setSnapshot(previous=>acceptSnapshot(previous,next));
    setLoaded(true);
    return next;
  }, []);
  const invoke: Invoke = useCallback(async <T,>(method: string, params?: unknown, success?: string, options?:{background?:boolean}): Promise<T> => {
    try {
      if (!window.airoom) throw new Error('桌面后端尚未连接。');
      const result = unwrapProjectFlowReply(await window.airoom.invoke<T>(method, params));
      if(method==='settings.save')setSnapshot(previous=>({...previous,settings:result as Settings}));
      else if(refreshAfterRpc(method))await refresh();
      if (success) notify(success);
      return result;
    } catch (error) {
      if(!options?.background)notify(errorText(error), true);
      throw error;
    }
  }, [notify, refresh]);
  const perform = useCallback((method: string, params?: unknown, success?: string) => {
    void invoke(method, params, success).catch(() => {});
  }, [invoke]);
  function openCollaboration() {openInvite(project?.id);}
  function openInvite(projectId?: string) { setInviteProject(projectId); setModal('invite'); }
  /** A project without chosen members starts at 请大家一起来; one with people opens its meeting room. */
  // The window waits a moment so a double-click (rename) on the same row can cancel it.
  const inviteTimer = useRef<number | undefined>(undefined);
  function openProject(target: Project) { window.clearTimeout(inviteTimer.current); if (needsMembers(snapshot, target)) { inviteTimer.current = window.setTimeout(() => openInvite(target.id), 260); return; } setView('project'); setProjectId(target.id); setSessionId(''); }
  async function enterMeeting(targetId: string, memberIds: string[]) { await saveProjectMembers(invoke, targetId, memberIds); setModal(null); setView('project'); setProjectId(targetId); setSessionId(''); }
  function openSettings(tab: SettingsTab = 'members', editing: string | null = null, focus: string | null = null) { setSettingsTab(tab); setSettingsEditing(editing); setSettingsFocus(focus); setModal('settings'); }
  /** A pending item opens where it can be handled; opening never answers, resends, accepts or applies anything. */
  function openAttention(item: AttentionItem) {
    if(item.jointReviewId){const topic=snapshot.roundtable?.topics.find(t=>t.reviewId===item.jointReviewId);if(topic){setRoundtableRequest({topicId:topic.id,nonce:Date.now()});setView('roundtable');setSessionId('');return;}if(item.projectId){setProjectId(item.projectId);setView('project');setSessionId('');return;}}
    if(item.action.view==='member-settings'){openSettings('members',null,item.provider??item.memberId??null);return;}
    if(item.action.view==='room'){setView('room');setSessionId('');setRoomFocus({threadId:item.threadId,messageId:item.messageId,nonce:Date.now()});return;}
    if(item.action.view==='project-room'&&item.kind==='acceptance'&&item.roomId?.startsWith('project:')){setProjectId(item.roomId.slice(8));setView('project');setSessionId('');return;}
    const target=item.sessionId&&snapshot.sessions.find(s=>s.id===item.sessionId);
    if(target){openRecordedSession(target);return;}
    const work = (tab?: SideTab) => { setView('work'); if (item.projectId) setProjectId(item.projectId); if (item.sessionId) setSessionId(item.sessionId); if (tab) { setSideTab(tab); setSideOpen(true); } };
    if (item.action.view === 'workspace') work('files');
    else if (item.action.view === 'project-room') { setView('project'); if (item.projectId) setProjectId(item.projectId); setSessionId(''); }
    else work(item.approvalId ? 'approvals' : undefined);
  }
  function openSession(memberId?: string) { const id=memberId??deskMemberId;openDesk(id);perform('desk.topic',{memberId:id},'已开始新的工位话题。'); }

  useEffect(() => {
    if (!window.airoom) {
      setLoaded(true);
      setBackendMessage('桌面后端未连接。请从 AIROOM 桌面应用打开工作台。');
      return;
    }
    const unsubscribe = window.airoom.onEvent(event => {
      if (event.type === 'snapshot') {
        setSnapshot(previous=>acceptSnapshot(previous,withDefaults(event.snapshot)));
        setLoaded(true);
      } else if(event.type==='snapshot-patch'){
        setSnapshot(previous=>{const next=applySnapshotPatch(previous,event);if(!next){queueMicrotask(()=>void refresh().catch(()=>{}));return previous;}return withDefaults(next);});
      } else if (event.type === 'event') {
        setSnapshot(previous => previous.events.some(item => item.id === event.event.id) ? previous : {
          ...previous, events: [...previous.events, event.event],
        });
        setOpened(previous => previous && previous.sessionId === event.event.sessionId && !previous.events.some(item => item.id === event.event.id) ? { ...previous, events: [...previous.events, event.event] } : previous);
      } else if(event.type==='backend') {
        setSnapshot(previous => ({ ...previous, backendReady: event.ready }));
        setBackendMessage(event.message ?? '');
      }
    });
    void refresh().catch(error => { setLoaded(true); setBackendMessage(errorText(error)); });
    return unsubscribe;
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.error ? 9000 : 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const team: Team = useMemo(() => makeTeam(snapshot.members,snapshot.removedMembers), [snapshot.members,snapshot.removedMembers]);
  // The chat room lives in a hidden project; project lists and pickers only show real work.
  const loungeId = snapshot.projects.find(project => project.kind === 'lounge')?.id;
  const workProjects = useMemo(() => snapshot.projects.filter(project => !project.kind), [snapshot.projects]);
  const user = { name: snapshot.profile.name || '你', avatar: snapshot.profile.avatar };
  useEffect(() => {
    if (!workProjects.some(project => project.id === projectId)) setProjectId(workProjects[0]?.id ?? '');
  }, [workProjects, projectId]);
  useEffect(() => {
    const choices = snapshot.sessions.filter(session => session.projectId === projectId);
    if (sessionId && !choices.some(session => session.id === sessionId)) setSessionId('');
  }, [snapshot.sessions, projectId, sessionId]);
  useEffect(() => { setDraft(''); setIntent('message'); setNearBottom(true); }, [sessionId]);
  useEffect(() => {
    if (!sessionId || !window.airoom || !snapshot.backendReady) return;
    let current = true;
    void window.airoom.invoke<TimelineEvent[]>('session.events', { sessionId }).then(events => {
      // Events pushed while this request was in flight are kept.
      if (current && Array.isArray(events)) setOpened(previous => ({ sessionId, events: mergeEvents(events, previous?.sessionId === sessionId ? previous.events : []) }));
    }).catch(() => {});
    return () => { current = false; };
  }, [sessionId, snapshot.backendReady]);
  useEffect(() => {
    if (nearBottom && timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight;
  }, [snapshot.events, opened, snapshot.runs, snapshot.approvals, sessionId, nearBottom]);

  const project = snapshot.projects.find(item => item.id === projectId);
  const reportsStamp=JSON.stringify([snapshot.projectFlows?.filter(f=>f.projectId===projectId),snapshot.runs.filter(r=>r.projectId===projectId).map(r=>[r.id,r.status,r.updatedAt]),project?.memberIds]);
  useEffect(()=>{let current=true;if(snapshot.backendReady&&projectId)void invoke<MemberReportPage>('projectFlow.memberReports',{projectId,limit:1}).then(p=>{if(current&&p?.members)setReportRoster({projectId,members:p.members});}).catch(()=>{});return()=>{current=false;};},[projectId,reportsStamp,snapshot.backendReady,invoke]);
  function openDesk(memberId:string){setDeskMemberId(memberId);setView('desk');setSessionId('');perform('desk.open',{memberId});}
  function openRecordedSession(target:Session){
    const personal=snapshot.rooms?.find(r=>r.roomId===target.roomId);
    if(target.roomId?.startsWith('report:')){if(personal?.projectId)setProjectId(personal.projectId);setReportMemberId(personal?.memberId??memberIdOf(target));setView('reports');setSessionId('');return;}
    if(target.roomId?.startsWith('project:')){setProjectId(target.roomId.slice(8));setView('project');setSessionId('');return;}
    if(target.roomId==='global'||target.roomThreadId&&!target.flowId){setView('room');setSessionId('');return;}
    if(!isConversationSession(target,snapshot.runs)){setProjectId(target.projectId);setReportMemberId(memberIdOf(target));setView('reports');setSessionId('');return;}
    const id=memberIdOf(target);openDesk(id);const folder=snapshot.projects.find(p=>p.id===target.projectId)?.directory;
    if(folder)void invoke('desk.switchFolder',{memberId:id,directory:folder}).then(()=>invoke('room.select',{roomId:`desk:${id}`,threadId:`desk-topic-${target.id}`})).catch(()=>{});
  }
  const session = snapshot.sessions.find(item => item.id === sessionId);
  const firstInput = useCallback((id: string) => snapshot.runs.filter(run => run.sessionId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]?.input, [snapshot.runs]);
  const openFromNotice = useCallback((target: Session) => {
    openRecordedSession(target);
  }, [snapshot.sessions,snapshot.rooms,snapshot.runs]);
  useMemberNotifications(snapshot, firstInput, openFromNotice, team);
  const isUnread = useUnread(snapshot, sessionId);
  // A project flow's sessions belong to its meeting room (each task card opens its record), not the session list.
  const projectSessions = useMemo(() => byActivity(snapshot.sessions.filter(item => item.projectId === projectId && isConversationSession(item,snapshot.runs)&&(view!=='desk'||memberIdOf(item)===deskMemberId)), snapshot.runs), [snapshot.sessions, snapshot.runs, projectId,view,deskMemberId]);
  const runs = snapshot.runs.filter(run => run.sessionId === sessionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const currentRun = [...runs].reverse().find(run => isActiveRun(run));
  const pendingRun = [...runs].reverse().find(run => run.status === 'queued');
  const currentProvider = snapshot.providers.find(item => item.id === session?.provider);
  const sessionEvents = useMemo(() => mergeEvents(opened?.sessionId === sessionId ? opened.events : [], snapshot.events.filter(event => event.sessionId === sessionId)), [opened, snapshot.events, sessionId]);
  const pendingApprovals = snapshot.approvals.filter(approval => approval.state === 'pending');
  const sessionApprovals = pendingApprovals.filter(approval => approval.sessionId === sessionId);
  const allRunning = snapshot.runs.filter(run => isActiveRun(run) || run.status === 'queued');
  const collaborations = snapshot.collaborations.filter(item => item.projectId === projectId);
  const visibleSessions = projectSessions.filter(item => `${sessionTitle(item, firstInput(item.id))} ${team.ofSession(item).name} ${PROVIDER_NAMES[item.provider]}`.toLowerCase().includes(search.toLowerCase()));
  // Each member's mood comes from the runs of their own sessions (custom members included).
  const memberOfSession = useMemo(() => new Map(snapshot.sessions.map(item => [item.id, memberIdOf(item)])), [snapshot.sessions]);
  const moods = useMemo(() => Object.fromEntries(team.members.map(member => {
    const info = snapshot.providers.find(item => item.id === member.executor);
    const memberRuns = snapshot.runs.filter(run => memberOfSession.get(run.sessionId) === member.id);
    const waiting = pendingApprovals.some(approval => memberOfSession.get(approval.sessionId) === member.id) || memberRuns.some(run => run.status === 'waiting_user' && !run.completedAt);
    return [member.id, moodOf(info, memberRuns, waiting, runnable(info))];
  })) as Record<string, Mood>, [team, snapshot.providers, snapshot.runs, pendingApprovals, memberOfSession]);

  async function probe() {
    setProbing(true);
    try { await invoke('provider.probe'); } catch {} finally { setProbing(false); }
  }
  async function restartBackend() {
    if (!window.airoom || restarting) return;
    setRestarting(true);
    try {
      const result = await window.airoom.invoke<{ detail?: string; message?: string }>('backend.restart');
      notify(result?.detail ?? result?.message ?? '已请求重启工作台后端。');
      await refresh();
    } catch (error) { notify(errorText(error), true); }
    finally { setRestarting(false); }
  }
  async function send() {
    const text = draft.trim();
    if ((!text && !attach.items.length) || !session || sending) return;
    const submittedIntent = currentRun ? (intent === 'message' ? 'supplement' : intent) : 'message';
    setSending(true);
    try {
      const result = await invoke<{ delivery?: string; activeTaskContinues?: boolean }>('session.send', { sessionId, text, intent: submittedIntent, ...(attach.items.length ? { attachments: attach.items } : {}) });
      setDraft(''); attach.clear();
      setIntent('message');
      setNearBottom(true);
      if (result?.delivery === 'paused') notify(result.activeTaskContinues ? '自动协作已暂停。正在执行的任务会继续；需要中断请点停止成员。' : '自动协作已暂停。');
      else if (submittedIntent === 'redirect') notify('新方向已提交：旧方向会先停下，再按新要求继续。');
      else if (submittedIntent === 'supplement') notify(currentProvider?.capabilities.steer ? '补充已送到当前这一轮，显示在你的任务下方。' : '补充已收下，这位成员会在下一轮接收。');
    } catch {} finally { setSending(false); }
  }
  async function createdProject(params: { name: string; directory: string }) {
    const result = await invoke<Project>('project.create', params);
    const next = await refresh();
    const id = result?.id ?? next.projects.find(item => item.directory === params.directory)?.id ?? '';
    setProjectId(id);
    if (id) openInvite(id); else setModal(null);
    notify('项目已加入工作室，请选择参加的成员。');
  }
  async function createdInviteProject(params: { name: string; directory: string }) {
    const result = await invoke<Project>('project.create', params);
    const next = await refresh();
    notify('项目已加入工作室。');
    return result ?? next.projects.find(item => item.directory === params.directory);
  }
  async function createdSession(params: { provider: ProviderId; memberId: string; title: string; writeMode: boolean }) {
    const result = await invoke<Session>('session.create', { ...params, projectId });
    const next = await refresh();
    setSessionId(result?.id ?? next.sessions.filter(item => item.projectId === projectId && item.provider === params.provider).at(-1)?.id ?? '');
    setModal(null);
    window.setTimeout(() => textarea.current?.focus(), 50);
  }
  async function validate() {
    if (!validationRun) return;
    try {
      await invoke('run.validate', { runId: validationRun.id, validation: validation.trim() }, '验收已记录。');
      setValidationRun(null); setValidation('');
    } catch {}
  }
  async function commitRename() {
    if (!renaming) return;
    const value = renaming.value.trim(); const target = renaming; setRenaming(null);
    if (!value) return;
    if (target.kind === 'session') await invoke('session.update', { sessionId: target.id, title: value }).catch(() => {});
    else await invoke('project.update', { projectId: target.id, name: value }).catch(() => {});
  }
  async function exportSession(target: Session) {
    const sessionRuns = snapshot.runs.filter(run => run.sessionId === target.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const name = sessionTitle(target, firstInput(target.id));
    const fetched = await window.airoom?.invoke<TimelineEvent[]>('session.events', { sessionId: target.id }).catch(() => undefined);
    const content = conversationMarkdown(target, snapshot.projects.find(item => item.id === target.projectId), sessionRuns, mergeEvents(Array.isArray(fetched) ? fetched : [], snapshot.events.filter(event => event.sessionId === target.id)), name, team);
    try { const result = await invoke<{ saved?: boolean; path?: string }>('file.save', { name: `${name.replace(/…$/, '')}.md`, content }); if (result?.saved) notify(`对话已导出：${result.path}`); } catch {}
  }
  async function applyCopy(target: Session) {
    try { setApplyResult({ sessionId: target.id, ...(await invoke<{ applied: { path: string; kind: string }[]; conflicts: { path: string; reason: string }[]; unchanged: boolean }>('workspace.apply', { sessionId: target.id })) }); } catch {}
  }
  async function runConfirm() {
    if (!confirm) return;
    const target = confirm; setConfirm(null);
    try {
      if (target.kind === 'delete-session') { await invoke('session.delete', { sessionId: target.id, discardWorkspace: target.discard }, '会话已删除。'); if (target.id === sessionId) setSessionId(''); }
      else if (target.kind === 'remove-project') { await invoke('project.remove', { projectId: target.id, discardWorkspaces: target.discard }, '项目已从工作室移除，文件夹没有改动。'); if (target.id === projectId) { setProjectId(''); setSessionId(''); } }
      else await invoke('workspace.discard', { sessionId: target.id }, '工作副本已丢弃，下一轮会从项目重新建立。');
    } catch {}
  }
  function sessionMenuItems(target: Session): MenuItem[] {
    const busy = isBusy(snapshot, target.id);
    const copy = target.workspace && target.workspaceKind && target.workspaceKind !== 'original';
    return [
      { label: '重命名', icon: <Pencil size={14} />, onSelect: () => { setSessionId(target.id); setRenaming({ kind: 'session', id: target.id, value: sessionTitle(target, firstInput(target.id)).replace(/…$/, '') }); } },
      { label: target.pinned ? '取消置顶' : '置顶', icon: target.pinned ? <PinOff size={14} /> : <Pin size={14} />, onSelect: () => perform('session.update', { sessionId: target.id, pinned: !target.pinned }) },
      { label: target.archived ? '移出归档' : '归档', icon: target.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />, onSelect: () => { perform('session.update', { sessionId: target.id, archived: !target.archived }, target.archived ? '已移出归档。' : '已归档，可在会话列表底部找到。'); if (!target.archived && target.id === sessionId) setSessionId(''); } },
      { label: '导出对话（Markdown）', icon: <Download size={14} />, onSelect: () => void exportSession(target) },
      ...(copy ? ['separator' as const,
        { label: '把改动应用到项目…', icon: <GitMerge size={14} />, disabled: busy, onSelect: () => void applyCopy(target) },
        { label: '打开工作副本文件夹', icon: <FolderOpen size={14} />, onSelect: () => void invoke('workspace.open', { sessionId: target.id }).catch(() => {}) },
        { label: '丢弃工作副本…', icon: <FolderX size={14} />, disabled: busy, onSelect: () => setConfirm({ kind: 'discard', id: target.id, discard: true }) }] : []),
      'separator',
      { label: busy ? '删除（先停止任务）' : '删除会话…', icon: <Trash2 size={14} />, danger: true, disabled: busy, onSelect: () => setConfirm({ kind: 'delete-session', id: target.id, discard: true }) },
    ];
  }
  function projectMenuItems(target: Project): MenuItem[] {
    const busy = snapshot.sessions.some(item => item.projectId === target.id && isBusy(snapshot, item.id)),hasChildren=descendantIds(snapshot.projects,target.id).length>1;
    return [
      {label:'添加子项目…',icon:<Plus size={14}/>,onSelect:()=>setHierarchy({mode:'child',target})},
      {label:'归属与修改范围…',icon:<GitMerge size={14}/>,onSelect:()=>setHierarchy({mode:'move',target})},
      { label: '重命名', icon: <Pencil size={14} />, onSelect: () => setRenaming({ kind: 'project', id: target.id, value: target.name }) },
      'separator',
      { label: hasChildren?'移除（先移出子项目）':busy ? '移除（先停止任务）' : '从工作室移除…', icon: <Trash2 size={14} />, danger: true, disabled: busy||hasChildren, onSelect: () => setConfirm({ kind: 'remove-project', id: target.id, discard: true }) },
    ];
  }
  const openMenu = (event: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }, items: MenuItem[]) => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, items }); };

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'k') { event.preventDefault(); setSwitcher(value => !value); }
      else if (key === 'n' && !modal && snapshot.backendReady) { event.preventDefault(); openSession(session ? memberIdOf(session) : undefined); }
      else if (key === ',' && !modal) { event.preventDefault(); openSettings('connections'); }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  });
  // Dropped or picked files go with the next message as attachments.
  const attach = useAttachments(invoke);
  useEffect(() => { attach.clear(); }, [sessionId]);
  function onInstall(provider: ProviderId, version: string | null) {
    setInstalls(previous => { const next = { ...previous }; if (version) next[provider] = { version, startedAt: Date.now() }; else delete next[provider]; return next; });
  }

  const persona = session ? team.ofSession(session) : undefined;
  const access = session ? accessLevel(session, snapshot.settings, snapshot.executors) : undefined;
  /** What a member is doing now, for the roster and the member card. */
  // Idle members go about their day: the sidebar line follows the time of day, refreshed each minute.
  const clock = useTicker(true, 60_000);
  function memberStatus(id: string): MemberStatus {
    const member = team.get(id), info = member && snapshot.providers.find(item => item.id === member.executor), mood = moods[id];
    const install = member && installs[member.executor];
    const workingRun = snapshot.runs.find(run => memberOfSession.get(run.sessionId) === id && (isActiveRun(run) || run.status === 'queued'));
    const working = workingRun && snapshot.sessions.find(item => item.id === workingRun.sessionId), inRoom = working?.projectId === loungeId;
    const text = install ? `正在安装 ${install.version}…` : mood === 'working' && working ? inRoom ? '正在聊天室说话' : `正在做：${sessionTitle(working, firstInput(working.id))}` : mood === 'offline' || mood === 'away' ? providerSummary(info) : mood === 'resting' && member ? `空闲 · ${idleActivity(member.card, new Date(clock)).text}` : MOOD_TEXT[mood];
    return { mood, text, session: mood === 'working' ? working : undefined, inRoom };
  }
  async function prepareMemberStop(memberId:string){setMemberStopError('');try{setMemberStop(await invoke('member.stop.preview',{memberId}));}catch(e){notify(errorText(e));}}
  async function confirmMemberStop(){if(!memberStop)return;setMemberStopping(true);setMemberStopError('');try{const r=await invoke<{remaining:unknown[]}>('member.stop',{memberId:memberStop.memberId,token:memberStop.token,confirm:true});if(r.remaining.length)setMemberStopError('停止要求已发送，仍有运行正在核对退出。请等待并查看实际记录。');else setMemberStop(undefined);}catch(e){setMemberStopError(errorText(e));try{setMemberStop(await invoke('member.stop.preview',{memberId:memberStop.memberId}));}catch{}}finally{setMemberStopping(false);}}
  const [memberCard, setMemberCard] = useState<MemberCardTarget | null>(null);
  const closeMemberCard = useCallback(() => setMemberCard(null), []);
  const openMemberCard = (memberId: string, anchor: Element) => setMemberCard(current => current?.memberId === memberId ? null : { memberId, rect: anchor.getBoundingClientRect() });
  // On a wide window the team room can sit beside the open session.
  const splitting = split && wide && Boolean(session && persona && access);
  function toggleSplit(on: boolean) {
    setSplit(on); if (on) setSideOpen(false);
    try { localStorage.setItem(SPLIT_KEY, on ? 'on' : 'off'); } catch {}
  }
  const title = session ? sessionTitle(session, firstInput(session.id)) : '';
  const usage = useMemo(() => session ? usageOf(snapshot.events, session.provider) : undefined, [snapshot.events, session?.provider]);

  return <TeamProvider value={team}><RoundtableNavigation.Provider value={source=>{const {projectId,...ref}=source;setRoundtableRequest({projectId,source:ref,nonce:Date.now()});setView('roundtable');setSessionId('');}}><TeamColors team={team} /><div className={`app-shell ${sideOpen && session && (view === 'work'||view==='desk') ? '' : 'side-hidden'}`}>
    <aside className="sidebar">
      <button type="button" className="brand" onClick={() => { setView('work'); setSessionId(''); }} title="回到团队主页">
        <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
        <span className="brand-text"><strong>AIROOM</strong><span>我们的 AI 工作室</span></span>
      </button>

      <div className="sidebar-scroll">
      <div className="sidebar-section-label"><span>团队</span><span className="team-header-actions"><IconButton label="自动功能与定时任务" onClick={()=>setAutomationOpen(true)}><CalendarClock size={14}/></IconButton><IconButton label="用量与额度" onClick={()=>setQuotaOpen(true)}><Activity size={14}/></IconButton><IconButton label="检查所有成员" onClick={() => void probe()} disabled={probing || !snapshot.backendReady}><RefreshCw size={14} className={probing ? 'spin' : ''} /></IconButton></span></div>
      <ErrorBoundary area="团队列表" compact><div className="team-roster">
        {team.members.filter(member=>!member.card.cardHidden).map(member => {
          const id = member.id;
          const status = memberStatus(id);
          const running = allRunning.some(run=>memberOfSession.get(run.sessionId)===id);
          const deskNews = snapshot.rooms?.some(r=>r.roomId===`desk:${id}`&&(r.unread||r.pending));
          const deskOpen = view==='desk' && deskMemberId===id;
          return <div className={`roster-with-desk member-${id} ${deskOpen?'selected':''}`} key={id}><button type="button" className={`roster-row member-${id} mood-${status.mood} ${memberCard?.memberId === id ? 'open' : ''}`} key={id} aria-haspopup="dialog" onClick={event => openMemberCard(id, event.currentTarget)}>
            <Avatar member={member} size={32} mood={status.mood} />
            <span className="roster-text"><span className="roster-name"><strong>{member.name}</strong><QuotaBadge provider={member.executor} quota={snapshot.quotas?.[member.executor]}/></span><small title={status.text}>{status.text}</small></span>
          </button><span className="roster-actions">{running&&<button type="button" className="icon-button roster-member-stop" aria-label={'中止 '+member.name} title={'中止 '+member.name+' 当前所有运行'} disabled={memberStopping||!snapshot.backendReady} onClick={()=>void prepareMemberStop(id)}><StopCircle size={14}/></button>}<button type="button" className={`icon-button roster-desk ${deskNews?'has-news':''}`} aria-label={member.name+' 的工位'} aria-current={deskOpen?'page':undefined} title={member.name+' 的工位：单独聊天'} onClick={()=>openDesk(id)}><Laptop size={15}/>{deskNews&&<span className="unread-dot" aria-label="工位有新结果或待回应"/>}</button></span></div>;
        })}
      </div></ErrorBoundary>
      <nav className="place-list" aria-label="房间">
      <button type="button" className={`room-entry ${view === 'room' ? 'selected' : ''} ${snapshot.room.state.active ? 'active' : ''}`} aria-current={view==='room'?'page':undefined} onClick={() => setView('room')}>
        <MessagesSquare size={16} /><span><strong>茶歇室</strong><small>{snapshot.room.state.active ? `${team.get(snapshot.room.state.speaking)?.name ?? '大家'} 正在说话…` : snapshot.room.messages.length ? `${snapshot.room.messages.length} 条消息` : '闲聊或开会，不绑定项目'}</small></span>
        {snapshot.room.state.active && <span className="status-dot active" />}
      </button>
      <button type="button" className={'room-entry '+(view==='roundtable'?'selected':'')} aria-current={view==='roundtable'?'page':undefined} onClick={()=>{setView('roundtable');setSessionId('');}}><Users size={16}/><span><strong>圆桌</strong><small>{snapshot.roundtable?.topics.length?snapshot.roundtable.topics.length+' 个议题':'独立评审、比稿与方案比较'}</small></span></button>
      <AttentionEntry summary={snapshot.attention} onOpen={openAttention} onIgnore={item=>invoke('attention.dismiss',{id:item.id,fingerprint:item.fingerprint})} />
      </nav>

      <div className="sidebar-section-label"><span>项目</span><IconButton label="添加项目" onClick={() => setModal('project')} disabled={!snapshot.backendReady}><Plus size={15} /></IconButton></div>
      <ErrorBoundary area="项目和会话列表" compact resetKey={projectId}><div className="project-list" role="tree" aria-label="项目树">
        {workProjects.length === 0 ? <div className="sidebar-empty">还没有项目，先添加一个吧</div> : projectRows(workProjects,collapsedProjects).map(({project:item,depth,hasChildren,path:treePath}) => renaming?.kind === 'project' && renaming.id === item.id
          ? <RenameInput key={item.id} value={renaming.value} label="项目名称" onChange={value => setRenaming({ ...renaming, value })} onCommit={() => void commitRename()} onCancel={() => setRenaming(null)} />
          : <div className={`list-row project-item project-tree-row ${item.id === projectId ? (view === 'project' ? 'selected current' : 'current') : ''}`} key={item.id} role="treeitem" aria-level={depth+1} aria-selected={item.id===projectId} aria-expanded={hasChildren?!collapsedProjects.has(item.id):undefined} style={{paddingLeft:Math.min(depth,6)*13}} onContextMenu={event => openMenu(event, projectMenuItems(item))}>
            {hasChildren?<button type="button" className="project-tree-toggle" aria-label={(collapsedProjects.has(item.id)?'展开':'收起')+' '+item.name+' 的子项目'} onClick={()=>setCollapsedProjects(old=>{const next=new Set(old);if(next.has(item.id))next.delete(item.id);else next.add(item.id);return next;})}>{collapsedProjects.has(item.id)?<ChevronRight size={13}/>:<ChevronDown size={13}/>}</button>:<span className="project-tree-spacer"/>}
            <button type="button" className="list-row-main" onClick={() => openProject(item)} onDoubleClick={() => { window.clearTimeout(inviteTimer.current); setRenaming({ kind: 'project', id: item.id, value: item.name }); }} title={treePath.join(' / ')+' · '+item.directory}>{item.id === projectId ? <FolderOpen size={15} /> : <Folder size={15} />}<span>{item.name}</span></button>
            <button type="button" className="row-more" aria-label={`${item.name} 的更多操作`} onClick={event => openMenu(event, projectMenuItems(item))}><MoreHorizontal size={15} /></button>
          </div>)}
      </div>
      </ErrorBoundary>
      </div>

      <div className="sidebar-footer">
        <span className={`backend-state ${snapshot.backendReady ? 'ready' : ''}`}><span className="status-dot" />{snapshot.backendReady ? '本机工作台已连接' : loaded ? '后端未连接' : '正在连接'}</span>
        <button className="sidebar-settings" onClick={() => openSettings('connections')}><Settings2 size={15} /><span>设置与连接</span></button>
      </div>
    </aside>

    <div className="workspace">
      {!snapshot.backendReady && loaded && <div className="backend-banner" role="status"><AlertCircle size={16} /><span>{backendMessage || '后端尚未就绪，连接恢复前不会发送任务。'}</span><button onClick={() => void refresh().catch(error => notify(errorText(error), true))}>重新连接</button>{window.airoom && <button disabled={restarting} onClick={() => void restartBackend()}>{restarting ? '正在重启…' : '重启后端'}</button>}</div>}
      {view==='roundtable'?<ErrorBoundary area="圆桌" resetKey={snapshot.roundtable?.currentTopicId}><RoundtableView snapshot={snapshot} invoke={invoke} request={roundtableRequest} onHandled={()=>setRoundtableRequest(undefined)} onProject={id=>{setProjectId(id);setView('project');setSessionId('');}}/></ErrorBoundary>:view==='reports'&&project?<ErrorBoundary area="个人汇报" resetKey={project.id+reportMemberId}><MemberReports key={project.id+':'+reportMemberId} project={project} memberId={reportMemberId} snapshot={snapshot} invoke={invoke} reports={reportEntries} onOpenReport={openReport} onMeeting={()=>setView('project')} onDesk={team.get(reportMemberId)?()=>openDesk(reportMemberId):undefined}/></ErrorBoundary>:view==='desk'?<ErrorBoundary area="个人工位" resetKey={deskMemberId}><MemberDesk key={deskMemberId} memberId={deskMemberId} snapshot={snapshot} invoke={invoke} onSettings={()=>openSettings('members',deskMemberId)}/></ErrorBoundary>:view === 'project' && project ? <ErrorBoundary area="项目会议室" resetKey={project.id}><ProjectRoom key={project.id} snapshot={snapshot} project={project} invoke={invoke} reports={reportEntries} onOpenReport={openReport}onRoundtable={source=>{setRoundtableRequest('topicId' in source?{topicId:source.topicId,nonce:Date.now()}:{projectId:project.id,source,nonce:Date.now()});setView('roundtable');setSessionId('');}} onOpenSession={id => {const target=snapshot.sessions.find(s=>s.id===id);if(target)openRecordedSession(target);}} /></ErrorBoundary>
        : view === 'room' && !splitting ? <ErrorBoundary area="聊天室" resetKey={snapshot.room.currentThreadId}><RoomView snapshot={snapshot} invoke={invoke} focus={roomFocus} onOpenSession={(target, id) => { const recorded=snapshot.sessions.find(s=>s.id===id);if(recorded)openRecordedSession(recorded); }} split={wide && session && persona && access ? { active: false, toggle: () => toggleSplit(true) } : undefined} /></ErrorBoundary> : session && persona && access ? <ErrorBoundary area="对话区" resetKey={session.id}><div className={`workbench ${splitting ? `split ${sideOpen ? 'with-panel' : ''}` : ''}`}>
        {splitting && <ErrorBoundary area="聊天室" resetKey={snapshot.room.currentThreadId}><RoomView snapshot={snapshot} invoke={invoke} focus={roomFocus} onOpenSession={(target, id) => { setProjectId(target); setSessionId(id); }} split={{ active: true, toggle: () => toggleSplit(false) }} /></ErrorBoundary>}
        <main className={`conversation member-${persona.id}`}>
          <header className="conversation-heading">
            <Avatar member={persona} size={44} mood={moods[persona.id] === 'working' && currentRun ? 'working' : sessionApprovals.length ? 'waiting' : undefined} />
            <div className="heading-text">
              <div className="breadcrumb"><span>{project?.name}</span><ChevronRight size={11} /><span>和 {persona.name} 的会话</span></div>
              <h1 onDoubleClick={() => setRenaming({ kind: 'session', id: session.id, value: title.replace(/…$/, '') })} title="双击重命名">{title}</h1>
              <div className="conversation-meta">
                <span className="meta-chip">{persona.name} · {PROVIDER_NAMES[session.provider]} · {providerSummary(currentProvider)}</span>
                <span className={`meta-chip access-${access.tone}`} title={access.detail}><ShieldCheck size={11} />{access.label}</span>
                {session.writeMode && <button type="button" className="meta-chip link" title={session.workspace ?? project?.directory} onClick={() => void invoke('workspace.open', { sessionId: session.id }).catch(() => {})} disabled={!session.workspace}><FolderOpen size={11} />{session.workspaceKind === 'copy' ? '独立目录副本' : session.workspace ? '独立工作副本' : '工作副本（下一轮建立）'}</button>}
                <AutoApproveChip session={session} invoke={invoke} />
              </div>
            </div>
            <div className="heading-controls">
              {currentRun && <button className="button stop-button" disabled={currentRun.status === 'stopping'} onClick={() => perform('run.stop', { runId: currentRun.id }, '停止请求已发送。已有的输出和文件会保留。')}><StopCircle size={15} />{currentRun.status === 'stopping' ? '正在停止' : '停止成员'}</button>}
              <button type="button" className="icon-button" aria-label="会话的更多操作" title="会话的更多操作" onClick={event => openMenu(event, sessionMenuItems(session))}><MoreHorizontal size={17} /></button>
              {wide && <IconButton label={splitting ? '取消并排' : '和聊天室并排显示'} onClick={() => toggleSplit(!splitting)}><Columns2 size={17} /></IconButton>}
              <IconButton label={sideOpen ? '收起工作记录' : '打开工作记录'} onClick={() => setSideOpen(!sideOpen)}>{sideOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}</IconButton>
            </div>
          </header>
          {collaborations.filter(item => item.sessionIds.includes(sessionId) && item.status !== 'ended').map(item => <CollaborationStrip key={item.id} collaboration={item} perform={perform} />)}
          <div className="timeline" ref={timeline} onScroll={() => { const node = timeline.current; if (node) setNearBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 100); }}>
            <div className="timeline-inner">
              {!runs.length && <div className="session-greeting">
                <Portrait member={persona} className="greeting-portrait" />
                <div className="greeting-bubble">
                  <span className="greeting-name">{persona.name}</span>
                  <p>你好，我是 {persona.name}。{persona.motto}</p>
                  <p>这次想完成什么？把目标、限制和想要的结果告诉我就好。</p>
                  <div className="session-facts"><span><ShieldCheck size={13} />{access.label}</span><span><Info size={13} />随时可以补充要求、改变方向或停止</span></div>
                  {!runnable(currentProvider) && <button className="button secondary" onClick={() => openSettings('connections')}>先检查 {persona.name} 的连接</button>}
                </div>
              </div>}
              {runs.map(run => <ErrorBoundary key={run.id} area="这一轮的记录" compact resetKey={run.updatedAt}><RunBlock run={run} member={persona} user={user} events={sessionEvents.filter(event => event.runId === run.id)} approvals={sessionApprovals.filter(approval => approval.runId === run.id)} invoke={invoke} notify={notify}
                onProcess={() => { setSideOpen(true); setSideTab('activity'); }} onShare={project&&!project.kind&&!session.restoredHistoryOnly&&!run.flowOperationId?()=>{setRoundtableRequest({projectId:project.id,source:{runId:run.id},nonce:Date.now()});setView('roundtable');setSessionId('');}:undefined} shareLabel="送去圆桌评审" onValidate={session.restoredHistoryOnly ? undefined : () => { setValidationRun(run); setValidation(''); }} onReview={project?.kind === 'lounge' || session.restoredHistoryOnly ? undefined : () => setReviewRun(run)}
                onAnswer={text => { setDraft(text); window.setTimeout(() => textarea.current?.focus(), 0); }}
                onLogin={() => openSettings('connections')}
                onRetry={text => { setDraft(text); setIntent('message'); window.setTimeout(() => textarea.current?.focus(), 0); notify('已把任务放回输入框，确认后再发送。'); }} /></ErrorBoundary>)}
            </div>
          </div>
          {!nearBottom && <button className="jump-bottom" onClick={() => { setNearBottom(true); timeline.current?.scrollTo({ top: timeline.current.scrollHeight, behavior: 'smooth' }); }}><ArrowDown size={14} />查看最新进展</button>}
          <div className="composer-wrap">
            {session.restoredHistoryOnly&&<div className="auto-banner"><Info size={13}/><span>这是恢复的历史记录，只能查看。当时的工作副本和成员的对话上下文没有备份，请新建任务继续。</span><button type="button" onClick={()=>openSession(memberIdOf(session))}>新建任务</button></div>}
            {session.autoApprove && !session.restoredHistoryOnly && <div className="auto-banner"><ShieldCheck size={13} /><span>自动工作中：{persona.name} 的操作审批会自动批准并记录，提问仍会等你。</span><button type="button" onClick={() => perform('session.approvals', { sessionId: session.id, autoApprove: false, clearRules: true }, '已关闭本会话的自动批准。')}>关闭自动批准</button></div>}
            {sessionApprovals.length > 0 && <button className="approval-prompt" onClick={() => { const node = timeline.current; node?.scrollTo({ top: node.scrollHeight, behavior: 'smooth' }); }}><Bell size={14} /><span>{persona.name} 在等你回应（{sessionApprovals.length} 项）</span><ArrowRight size={14} /></button>}
            {currentRun && <div className="intervention-controls">
              <span><span className="status-dot active" />{persona.name} 正在工作，你可以：</span>
              <div role="group" aria-label="运行中的输入方式">
                <button className={intent !== 'redirect' ? 'selected' : ''} onClick={() => { setIntent('supplement'); textarea.current?.focus(); }} title={currentProvider?.capabilities.steer ? '送到当前这一轮' : '这位成员会在下一轮接收'}><Plus size={12} />补充要求</button>
                <button className={intent === 'redirect' ? 'selected redirect' : ''} onClick={() => { setIntent('redirect'); textarea.current?.focus(); }} title="先停下当前方向，再按新要求继续"><PencilLine size={12} />改变方向</button>
              </div>
            </div>}
            <div className={`composer ${currentRun && intent === 'redirect' ? 'redirect' : ''} ${attach.dragging ? 'dragging' : ''}`} {...attach.dropTarget}>
              {attach.dragging && <div className="drop-hint">松开即可附上文件</div>}
              <AttachmentTray items={attach.items} onRemove={attach.remove} />
              <textarea ref={textarea} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (isSendKey(event)) { event.preventDefault(); void send(); } }} aria-label="输入任务或补充要求" placeholder={currentRun ? intent === 'redirect' ? '写下新的目标：旧方向会先停下，已有输出和改动会保留…' : `补充给 ${persona.name} 的约束、资料或想法…` : `告诉 ${persona.name} 要完成什么…`} rows={3} disabled={!snapshot.backendReady || session.restoredHistoryOnly} />
              <div className="composer-bottom">
                <AttachButton onPick={() => void attach.pick()} busy={attach.busy} disabled={!snapshot.backendReady || session.restoredHistoryOnly} />
                <button type="button" className={`model-chip ${session.model || session.effort ? 'custom' : ''}`} onClick={event => setModelAnchor(event.currentTarget.getBoundingClientRect())} title="选择这个会话用的模型和思考程度"><Sparkles size={12} />{session.model || snapshot.settings.models[session.provider] || currentProvider?.model || '成员默认模型'}{(session.effort || snapshot.settings.efforts?.[session.provider]) ? ` · ${session.effort || snapshot.settings.efforts[session.provider]}` : ''}</button>
                {usage && <span className={`usage-chip ${usage.exhausted ? 'full' : usage.percent >= 80 ? 'high' : ''}`} title={`${persona.name} 自己报告的额度：${usage.window}已用 ${usage.percent}%${resetText(usage.resetsAt)}`}><span className="usage-meter"><i style={{ width: `${Math.min(100, usage.percent)}%` }} /></span>{usage.exhausted ? '额度已用完' : `${usage.window} ${usage.percent}%`}</span>}
                <span className="composer-hint">{currentRun ? intent === 'redirect' ? '提交后先停下旧方向' : currentProvider?.capabilities.steer ? '补充会送到当前这一轮' : '补充会排到下一轮' : pendingRun ? '已有任务排队' : 'Enter 发送'}</span>
                <button className="send-button" aria-label={currentRun && intent === 'redirect' ? '提交新方向' : currentRun ? '发送补充要求' : '发送任务'} disabled={(!draft.trim() && !attach.items.length) || sending || !snapshot.backendReady || session.restoredHistoryOnly || (!runnable(currentProvider) && !currentRun)} onClick={() => void send()}>{sending ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}</button>
              </div>
            </div>
            <div className="composer-caption"><span>Shift + Enter 换行 · + 或拖入添加图片和文件 · Ctrl + K 切换会话</span><span><LockKeyhole size={10} />记录只保存在本机</span></div>
          </div>
        </main>
        {sideOpen && <aside className="detail-panel">
          <div className="detail-tabs" role="tablist" aria-label="工作记录分类">{([['plan', '过程', <Sparkles size={14} />], ['activity', '活动', <Activity size={14} />], ['files', '产出', <FolderOpen size={14} />], ['approvals', '回应', <ShieldCheck size={14} />]] as const).map(([id, label, icon]) => <button key={id} role="tab" aria-selected={sideTab === id} className={sideTab === id ? 'selected' : ''} onClick={() => setSideTab(id)}>{icon}<span>{label}</span>{id === 'approvals' && sessionApprovals.length > 0 && <span className="tab-dot" />}</button>)}</div>
          <div className="detail-content" role="tabpanel"><ErrorBoundary area="工作记录" resetKey={`${session.id}:${sideTab}`}>
            {sideTab === 'plan' && <PlanPanel events={sessionEvents} session={session} provider={currentProvider} claudeFileScope={snapshot.settings.permissions.claude.fileScope} collaborations={collaborations} onCollaboration={() => openCollaboration()} perform={perform} />}
            {sideTab === 'activity' && <ActivityPanel events={sessionEvents} runs={runs} />}
            {sideTab === 'files' && <FilesPanel session={session} invoke={invoke} eventsCount={sessionEvents.length} notify={notify} busy={Boolean(currentRun || pendingRun)} onApply={() => void applyCopy(session)} onDiscard={() => setConfirm({ kind: 'discard', id: session.id, discard: true })} />}
            {sideTab === 'approvals' && <ApprovalsPanel approvals={sessionApprovals} invoke={invoke} member={persona} />}
          </ErrorBoundary></div>
          <div className="detail-footer"><ShieldCheck size={12} /><span>只显示成员公开的过程和实际记录</span></div>
        </aside>}
      </div></ErrorBoundary> : <ErrorBoundary area="主页" resetKey={projectId}><Welcome project={project} snapshot={snapshot} team={team} moods={moods} invoke={invoke} onSettingsTab={(tab, focus) => openSettings(tab, null, focus ?? null)} onProject={() => setModal('project')} onCard={openMemberCard} onCollaboration={() => openCollaboration()} /></ErrorBoundary>}
    </div>
    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'} key={toast.id}>{toast.error ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}<span>{toast.text}</span><IconButton label="关闭提示" onClick={() => setToast(null)}><X size={14} /></IconButton></div>}
    {hierarchy&&<ProjectHierarchyModal key={hierarchy.mode+hierarchy.target.id} {...hierarchy} snapshot={snapshot} invoke={invoke} onClose={()=>setHierarchy(undefined)} onCreate={createdProject} onSaved={async()=>{await refresh();notify('项目归属与修改范围已保存。');}}/>}
    {modal && <ErrorBoundary area={modal === 'settings' ? '设置' : modal === 'project' ? '添加项目' : modal === 'session' ? '新建会话' : modal === 'invite' ? '请大家一起来' : '协作'} onDismiss={() => setModal(null)}>
      {modal === 'project' && <ProjectModal invoke={invoke} onClose={() => setModal(null)} onCreate={createdProject} />}
      {modal === 'session' && project && <SessionModal snapshot={snapshot} project={project} initialMember={sessionPreset} onClose={() => setModal(null)} onCreate={createdSession} />}
      {modal === 'settings' && <SettingsModal snapshot={snapshot} invoke={invoke} onClose={() => setModal(null)} notify={notify} installs={installs} onInstall={onInstall} theme={theme} onTheme={setTheme} initialTab={settingsTab} initialFocus={settingsFocus} initialEditing={settingsEditing} />}
      {modal === 'invite' && <InviteModal snapshot={snapshot} invoke={invoke} initialProjectId={inviteProject} onClose={() => setModal(null)} onCreateProject={createdInviteProject} onDone={enterMeeting} />}

    </ErrorBoundary>}
    {reviewRun && <ReviewDialog snapshot={snapshot} invoke={invoke} run={reviewRun} onClose={() => setReviewRun(null)} onDone={target => { setReviewRun(null); const recorded=snapshot.sessions.find(s=>s.id===target.sessionId);if(recorded)openRecordedSession(recorded); }} />}
    {memberStop&&<Modal title={'中止 '+(team.get(memberStop.memberId)?.name??'这位成员')} subtitle={'将停止 '+memberStop.runs.length+' 项当前运行，其他成员保留。'} onClose={()=>{if(!memberStopping)setMemberStop(undefined);}}><div className="modal-body"><ul>{memberStop.runs.map(run=><li key={run.runId}><strong>{run.location}{run.projectName?' · '+run.projectName:''}</strong><p>{run.title}</p></li>)}</ul><p>已保存的发言和文件版本保留；结果未知的请求不会自动重发。</p>{memberStopError&&<p role="alert" className="task-meta bad">{memberStopError}</p>}</div><div className="modal-footer"><button className="button quiet" disabled={memberStopping} onClick={()=>setMemberStop(undefined)}>取消</button><button className="button danger" disabled={memberStopping||!memberStop.runs.length} onClick={()=>void confirmMemberStop()}>确认中止这位成员</button></div></Modal>}
    {quotaOpen&&<QuotaOverview snapshot={snapshot} invoke={invoke} onClose={()=>setQuotaOpen(false)}/>}
    {automationOpen&&<AutomationPanel snapshot={snapshot} invoke={invoke} notify={notify} onClose={()=>setAutomationOpen(false)}/>}
    {validationRun && <Modal title="记录本轮验收" subtitle="核对结果和文件后确认验收，补充说明可选填。" onClose={() => setValidationRun(null)}><div className="modal-body"><div className="info-card"><CheckCheck size={18} /><p>成员结束后状态是“待验收”。验收记录会保留在这一轮任务里。</p></div><label className="field">验收记录<textarea rows={4} placeholder="验收说明（可选），例如已检查的产物。" value={validation} onChange={event => setValidation(event.target.value)} autoFocus /></label></div><div className="modal-footer"><button className="button quiet" onClick={() => setValidationRun(null)}>稍后核对</button><button className="button primary" disabled={!snapshot.backendReady} onClick={() => void validate()}><CheckCheck size={14} />确认验收</button></div></Modal>}
    <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    {memberCard && (() => {
      const target = memberCard, status = memberStatus(target.memberId), executor = team.get(target.memberId)?.executor;
      const go = (action: () => void) => () => { closeMemberCard(); action(); };
      return <MemberCard target={target} snapshot={snapshot} status={status} onClose={closeMemberCard}
        onOpenWork={go(() => { if (status.inRoom) setView('room'); else if (status.session) openRecordedSession(status.session); })}
        onDesk={go(()=>openDesk(target.memberId))} onConnect={go(() => openSettings('members', null, executor ?? null))} />;
    })()}
    {modelAnchor && session && <ModelPopover invoke={invoke} anchor={modelAnchor} session={session} info={currentProvider} defaults={{ model: snapshot.settings.models[session.provider], effort: snapshot.settings.efforts?.[session.provider] }} onClose={() => setModelAnchor(null)} onSettings={() => openSettings('connections')} onSave={change => perform('session.update', { sessionId: session.id, ...change }, '已更新这个会话的模型设置，下一轮生效。')} />}
    {switcher && <QuickSwitcher snapshot={snapshot} firstInput={firstInput} onClose={() => setSwitcher(false)} onPick={target => { setSwitcher(false);openRecordedSession(target); }} />}
    {confirm && (() => {
      const target = confirm.kind === 'remove-project' ? undefined : snapshot.sessions.find(item => item.id === confirm.id);
      const targetProject = confirm.kind === 'remove-project' ? snapshot.projects.find(item => item.id === confirm.id) : undefined;
      const copies = confirm.kind === 'remove-project' ? snapshot.sessions.filter(item => item.projectId === confirm.id && item.workspaceKind && item.workspaceKind !== 'original' && item.workspace).length : target?.workspace && target.workspaceKind !== 'original' ? 1 : 0;
      const name = target ? sessionTitle(target, firstInput(target.id)) : targetProject?.name ?? '';
      const heading = confirm.kind === 'delete-session' ? '删除这个会话？' : confirm.kind === 'remove-project' ? '把项目从工作室移除？' : '丢弃这个工作副本？';
      return <Modal title={heading} subtitle={name} onClose={() => setConfirm(null)}>
        <div className="modal-body">
          {confirm.kind === 'delete-session' && <p className="confirm-text">对话记录、任务记录和待回应的请求会一起删除，不能恢复。如果只是不想看到它，可以改用“归档”。</p>}
          {confirm.kind === 'remove-project' && <p className="confirm-text">这个项目里的 {snapshot.sessions.filter(item => item.projectId === confirm.id).length} 个会话会一起删除。<strong>你电脑上的项目文件夹不会被改动。</strong></p>}
          {confirm.kind === 'discard' && <p className="confirm-text">工作副本里还没应用到项目的改动会丢失。项目本身不受影响；下一轮任务会从项目当前的样子重新建立副本。如果需要保留改动，请先“应用到项目”。</p>}
          {confirm.kind !== 'discard' && copies > 0 && <label className="toggle-row"><span><strong>同时删除工作副本（{copies} 个）</strong><small>未应用到项目的改动会丢失。不勾选则保留在 AIROOM 的数据目录里。</small></span><input type="checkbox" checked={confirm.discard} onChange={event => setConfirm({ ...confirm, discard: event.target.checked })} /></label>}
        </div>
        <div className="modal-footer"><button className="button quiet" onClick={() => setConfirm(null)}>取消</button><button className="button danger-solid" onClick={() => void runConfirm()}><Trash2 size={14} />{confirm.kind === 'delete-session' ? '删除会话' : confirm.kind === 'remove-project' ? '移除项目' : '丢弃副本'}</button></div>
      </Modal>;
    })()}
    {applyResult && <Modal title={applyResult.conflicts.length ? '有冲突，没有应用任何改动' : applyResult.unchanged ? '没有需要应用的改动' : '改动已应用到项目'} subtitle={snapshot.projects.find(item => item.id === snapshot.sessions.find(entry => entry.id === applyResult.sessionId)?.projectId)?.directory} onClose={() => setApplyResult(null)}>
      <div className="modal-body">
        {applyResult.conflicts.length > 0 && <><p className="confirm-text">下面这些文件在任务开始后，项目里也被改过。为了不覆盖你的修改，这次一个文件都没有写入。可以先处理这些文件，再重新应用。</p><ul className="change-list">{applyResult.conflicts.map(item => <li key={item.path}><em className="change-badge deleted">冲突</em><code>{item.path}</code><small>{item.reason}</small></li>)}</ul></>}
        {applyResult.unchanged && <p className="confirm-text">项目已经和工作副本一致。</p>}
        {applyResult.applied.length > 0 && <><p className="confirm-text">已把 {applyResult.applied.length} 个文件写入项目。之后的改动可以再次应用，只会带上新的部分。</p><ul className="change-list">{applyResult.applied.map(item => <li key={item.path}><em className={`change-badge ${item.kind}`}>{item.kind === 'added' ? '新增' : item.kind === 'modified' ? '修改' : '删除'}</em><code>{item.path}</code></li>)}</ul></>}
      </div>
      <div className="modal-footer"><button className="button primary" onClick={() => setApplyResult(null)}>好的</button></div>
    </Modal>}
  </div></RoundtableNavigation.Provider></TeamProvider>;
}

function RenameInput({ value, label, onChange, onCommit, onCancel }: { value: string; label: string; onChange: (value: string) => void; onCommit: () => void; onCancel: () => void }) {
  return <input className="rename-input" aria-label={label} value={value} autoFocus maxLength={120} onFocus={event => event.target.select()} onChange={event => onChange(event.target.value)} onBlur={onCommit}
    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onCommit(); } else if (event.key === 'Escape') { event.preventDefault(); onCancel(); } }} />;
}

function Welcome({ project, snapshot, team, moods, invoke, onProject, onSettingsTab, onCard, onCollaboration }: {
  project?: Project; snapshot: Snapshot; team: Team; moods: Record<string, Mood>; invoke: Invoke; onSettingsTab: (tab: SettingsTab, focus?: string) => void; onProject: () => void;
  onCard: (memberId: string, anchor: Element) => void; onCollaboration: () => void;
}) {
  const ready = (member: TeamMember) => runnable(snapshot.providers.find(item => item.id === member.executor));
  const visible=team.members.filter(member=>!member.card.cardHidden),readyCount=team.members.filter(ready).length;
  const readyNames = visible.filter(ready).map(member => member.name);
  return <div className="studio-welcome">
    <div className="welcome-hero">
      <span className="welcome-eyebrow">{greeting()}{project ? ` · ${project.name}` : ''}</span>
      <h1>{project ? '今天想请谁来帮忙？' : '欢迎来到 AIROOM，\n我们一起工作的房间。'}</h1>
      <p className="welcome-description">{readyNames.length ? `${readyNames.join('、')} 都在这里。点一位成员的卡片，就能和 TA 开始工作。` : !visible.length&&team.members.length?'人物卡已隐藏。可以在设置中重新显示，已有对话和连接照常使用。':'先在设置里添加人物卡并把成员连接好，大家就能开工了。'}</p>
      <div className="welcome-buttons">
        <button className={`button ${snapshot.projects.some(item => !item.kind) ? 'secondary' : 'primary'}`} disabled={!snapshot.backendReady || readyCount < 2} title={readyCount < 2 ? '至少需要两位已准备好的成员' : '选一个项目，请大家进入它的会议室'} onClick={onCollaboration}><Users size={15} />请大家一起来</button>
        <button className="button secondary" onClick={()=>onSettingsTab('members')}><IdCard size={15}/>管理人物卡</button>
        {!project && !snapshot.projects.some(item => !item.kind) && <button className="button secondary" disabled={!snapshot.backendReady} onClick={onProject}><Plus size={16} />添加第一个项目</button>}
      </div>
    </div>
    {!snapshot.providers.some(info=>info.path||info.runtimeReady)&&!Object.values(snapshot.settings.paths).some(Boolean)&&!(snapshot.executors??[]).length&&<section className="catalog-first-use"><strong>开始使用：选择成员 → 下载官方程序 → 登录</strong><p>AIROOM 已带好下载所需的运行环境。选择想用的成员，由工作台下载并配置，再通过厂商官方页面或 API Key 登录。</p><button className="button primary" onClick={()=>onSettingsTab('members','catalog')}>选择并下载执行端</button></section>}
    <SetupChecklist snapshot={snapshot} team={team} invoke={invoke} onSettings={onSettingsTab} onProject={onProject} />
    <div className={`team-stage ${visible.length > 3 ? 'many' : ''}`} style={{ '--stage-cols': Math.max(1, Math.min(visible.length, 4)) } as CSSProperties} role="list" aria-label="团队成员">
      {visible.map((member, index) => {
        const info = snapshot.providers.find(item => item.id === member.executor), mood = moods[member.id];
        return <div role="listitem" className={`stage-card member-${member.id} ${mood ? `mood-${mood}` : ''}`} key={member.id} style={{ animationDelay: `${index * 90}ms` }}>
          <button type="button" className="stage-card-hit" aria-haspopup="dialog" aria-label={`查看 ${member.name} 的人物卡片`} onClick={event => onCard(member.id, event.currentTarget.parentElement ?? event.currentTarget)} />
          <Portrait member={member} className="stage-portrait" />
          <div className="stage-caption">
            <strong>{member.name}</strong><small>{member.product}</small>
            <span className="stage-status">{mood === 'resting' || mood === 'working' || mood === 'waiting' ? MOOD_TEXT[mood] : providerSummary(info)}</span>
            <p>{member.motto ? `「${member.motto}」` : '　'}</p>
          </div>
        </div>;
      })}
    </div>
    <div className="welcome-footer"><span><Globe2 size={13} />{snapshot.settings.networkMode === 'tun' ? '网络沿用当前 TUN 环境' : '网络使用已配置的代理'} · 所有记录保存在本机</span></div>
  </div>;
}

function CollaborationStrip({ collaboration, perform }: { collaboration: Collaboration; perform: (method: string, params?: unknown, success?: string) => void }) {
  return <div className="collaboration-strip"><Users size={14} /><span>{collaboration.mode === 'relay' ? '接力协作' : '共同评审'} · {collaboration.stage}</span><span className="collaboration-avatars">{collaboration.members.map(member => <Avatar key={member} id={member} size={20} ring={false} />)}</span><span>历史协作记录 · 只读</span></div>;
}
