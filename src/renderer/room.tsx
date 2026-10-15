import {readableContent} from '../shared/content-presentation';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { ArrowDown, BookmarkPlus, Columns2, Copy, Download, MoreHorizontal, Reply, Unlink, Eraser, FileStack, Layers, LoaderCircle, MessageSquarePlus, MessagesSquare, Send, SmilePlus, Sparkles, StopCircle, Trash2 } from 'lucide-react';
import type { Attachment, RoomHistory, RoomId, RoomMessage, RoomThread, Snapshot } from '../shared/types';
import type { PersonalRoomData } from '../shared/member-workspaces';
import { DEFAULT_ROOM_THREAD, ROOM_REACTIONS, isRoomPass, roomMarkerPending, roomMentions, roomReaction } from '../shared/room';
import { RoomPresence } from './discussion-status';
import { streamDiscussionBody } from '../shared/discussion-format';
import {hasMeetingRemarks,pendingDiscussionQuestion,type DiscussionStyle} from '../shared/discussion';
import {Modal} from './modals';
import { isSendKey } from './composer-keys';
import { RoomBackdrop } from './room-backdrop';
import { Markdown } from './Markdown';
import { Avatar, UserAvatar, useTeam, type TeamMember } from './members';
import { runnable, time, type Invoke } from './ui';
import { NewTopicDialog, SummaryNote, TopicPanel, useSummarizer } from './topics';
import { HandoffDialog, RoomNote, type HandoffSource } from './handoff';
import { ContextMenu, type MenuItem, type MenuState } from './interactions';
import { MemoryProposalDialog } from './memory';
import { AttachButton, AttachmentList, AttachmentTray, useAttachments } from './attachments';
import { Briefcase } from 'lucide-react';
import { ImagePlus } from 'lucide-react';
import { GeneratedImages, ImageGenerationDialog } from './generated-images';
import { ErrorBoundary } from './ErrorBoundary';
import {mergeMemberReports} from '../shared/member-report-history';
import {useComposerDraft} from './composer-draft';
import { effectiveConfigText } from '../shared/executor-config';

const INVITED_KEY = 'airoom.room.invited';
/** Per topic: the newest message time the user has seen, for the divider shown on return. */
const SEEN_KEY = 'airoom.room.seen';
/** Finished member messages longer than this start folded. */
const isLong = (text: string) => text.length > 700 || text.split('\n').length > 14;
const SUGGESTIONS = ['大家今天过得怎么样？', '互相做个自我介绍吧', '开个会：下周我们一起做点什么？'];
/** Where the pending-items entry wants the room to show: a topic and, optionally, one message in it. */
export type RoomFocus = { threadId?: string; messageId?: string; nonce: number };
const mergeMessages = (...groups: RoomMessage[][]) => [...new Map(groups.flat().map(message => [message.id, message])).values()];

/** Reactions under a message; on members' messages in the current topic the user can add or remove theirs. */
function Reactions({ message, name, onToggle }: { message: RoomMessage; name: (author: string) => string; onToggle?: (emoji: string) => void }) {
  const team = useTeam();
  const [open, setOpen] = useState(false);
  const picker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!picker.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const entries = Object.entries(message.reactions ?? {});
  if (!entries.length && !onToggle) return null;
  const pick = (emoji: string) => { setOpen(false); onToggle?.(emoji); };
  return <div className={`room-reactions ${entries.length ? '' : 'empty'}`}>
    {entries.map(([emoji, authors]) => {
      const who = authors.map(name).join('、'), mine = authors.includes('user');
      return <button type="button" key={emoji} className={`reaction-chip ${mine ? 'mine' : ''}`} disabled={!onToggle} title={who} aria-label={`${emoji} ${who}`} aria-pressed={onToggle ? mine : undefined} onClick={() => onToggle?.(emoji)}>
        <span className="reaction-emoji">{emoji}</span>
        <span className="reaction-faces">{authors.slice(0, 3).map(author => author === 'user' ? <span key={author} className="reaction-user">{[...name('user')][0]}</span> : <Avatar key={author} member={team.get(author)} id={author} size={16} ring={false} />)}</span>
        {authors.length > 3 && <small>{authors.length}</small>}
      </button>;
    })}
    {onToggle && <span className="reaction-add-wrap" ref={picker}>
      <button type="button" className="reaction-add" aria-label="添加表情回应" aria-expanded={open} title="添加表情回应" onClick={() => setOpen(value => !value)}><SmilePlus size={14} /></button>
      {open && <span className="reaction-picker" role="menu" aria-label="选择表情">{ROOM_REACTIONS.map(item => <button type="button" role="menuitem" key={item.emoji} title={item.label} aria-label={`回应 ${item.emoji} ${item.label}`} onClick={() => pick(item.emoji)}>{item.emoji}</button>)}</span>}
    </span>}
  </div>;
}

/** Task text for a project, quoting who said what in the room. */
const handoffText = (speaker: string, text: string) => `请根据茶歇室的讨论完成下面的任务。\n\n${speaker}：${text}`;

/** What a project's meeting room adds to the shared chat: its own people, cards for flow messages and a dock above the composer. */
export interface ProjectRoomChat {
  /** Who takes part (chosen in 请大家一起来); toggling a chip here changes it. */
  roster: string[]; onRoster: (memberIds: string[]) => void;
  onConfigureMember?: (memberId:string)=>void;
  onTaskRequest?:(memberId:string,goal:string,mode:'add'|'supplement')=>Promise<boolean>;
  /** The flow dock already shows a next step, so the discussion layer does not suggest another one. */
  flowNextStep?:boolean;
  /** A live card for a plan, decision or round-report message, or undefined to show the message as text. */
  renderFlow?: (message: RoomMessage) => ReactNode | undefined;
  /** Flow state that has no message of its own: drafting, stuck items, waiting for quota, choosing a lead. */
  dock?: ReactNode;
  empty?: ReactNode;
}
type RoomData = Snapshot['room'] & Partial<PersonalRoomData>;
/** `recordActions` lets the host put the record actions (compress, export) into its own topic menu,
 *  so the room shows one menu instead of a second tool row. */
export interface RoomSurface {title:string;hint:string;readOnly?:boolean;active?:boolean;renderMessage?:(message:RoomMessage,text:string)=>ReactNode|undefined;dock?:ReactNode;recordActions?:MutableRefObject<MenuItem[]>}
export interface PersonalRoomChat {
  kind:'desk'|'report'; memberId:string; title:string; hint:string;
  headerActions?:ReactNode; composerControls?:(room:RoomData)=>ReactNode;
  /** Report pages have no topics; this row takes the topic bar's place (e.g. the member switcher). */
  subbar?:ReactNode;
  renderMessage?:(message:RoomMessage)=>ReactNode|undefined;
  messageActions?:(message:RoomMessage,messages:RoomMessage[])=>ReactNode;
  dock?:ReactNode; empty?:ReactNode;
}

export function RoomView({ snapshot, invoke: rawInvoke, onOpenSession, split, focus, roomId = 'global', project, personal,surface }: { snapshot: Snapshot; invoke: Invoke; onOpenSession?: (projectId: string, sessionId: string) => void; split?: { active: boolean; toggle: () => void }; focus?: RoomFocus; roomId?: RoomId; project?: ProjectRoomChat; personal?:PersonalRoomChat;surface?:RoomSurface }) {
  const global = roomId === 'global';
  // Every room call names its room; the tea room keeps the old unscoped form.
  const invoke = useCallback(<T,>(method: string, params?: unknown, success?: string) => rawInvoke<T>(method, global || !method.startsWith('room.') ? params : { ...(params as Record<string, unknown> | undefined), roomId }, success), [rawInvoke, global, roomId]) as Invoke;
  // The snapshot carries the tea room; another room is read on its own and re-read when its revision moves.
  const [loaded, setLoaded] = useState<RoomData | null>(null);
  const revision = snapshot.rooms?.find(item => item.roomId === roomId)?.revision;
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    if (global) return; let cancelled = false;
    void rawInvoke<RoomData>('room.get', { roomId }).then(result => { if (!cancelled && result?.state) setLoaded(result); }).catch(() => {});
    return () => { cancelled = true; };
  }, [global, roomId, revision, reloads]);
  useEffect(() => { if (!global) setLoaded(null); }, [roomId]);
  const expectedTopic=snapshot.rooms?.find(r=>r.roomId===roomId)?.currentThreadId;
  const expectedFolder=snapshot.rooms?.find(r=>r.roomId===roomId)?.folderKey;
  const personalLoading=Boolean(personal&&(!loaded||loaded.roomId!==roomId||expectedTopic!==undefined&&loaded.currentThreadId!==expectedTopic||expectedFolder!==undefined&&loaded.folderKey!==expectedFolder));
  const room: RoomData = global ? snapshot.room : (personalLoading?undefined:loaded) ?? { state: { active: false, mode: 'chat' }, messages: [], threads: [], hasMore: false } as unknown as RoomData;
  const personalSession=personal?.kind==='desk'?snapshot.sessions.find(s=>s.id===room.sessionId):undefined;
  const [handoff, setHandoff] = useState<HandoffSource | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [proposing, setProposing] = useState(false);
  const [imageDialog,setImageDialog]=useState<{text:string;attachments:Attachment[];draftVersion:number}|null>(null);
  const team = useTeam(), { state } = room, profile = snapshot.profile;
  const historyOnly=Boolean(surface?.readOnly||personalSession?.restoredHistoryOnly||personal&&!snapshot.members.some(member=>member.id===personal.memberId));
  const ready = (executor: string) => runnable(snapshot.providers.find(item => item.id === executor));
  const imageProvider=snapshot.providers.find(info=>info.id==='codex');
  const canGenerateImage=ready('codex')&&imageProvider?.capabilities.imageGeneration===true&&snapshot.settings.permissions.codex.network;
  const [ownInvited, setOwnInvited] = useState<string[]>(() => {
    try { const saved = JSON.parse(localStorage.getItem(INVITED_KEY) ?? 'null'); if (Array.isArray(saved)) return saved.filter(id => typeof id === 'string'); } catch {}
    return team.members.filter(member => ready(member.executor)).map(member => member.id);
  });
  // A project room's people are the project's roster; the tea room remembers its own invitation.
  const invited = personal ? [personal.memberId] : project ? project.roster : ownInvited;
  const setInvited = (next: string[] | ((previous: string[]) => string[])) => { const value = typeof next === 'function' ? next(invited) : next; if (project) project.onRoster(value); else setOwnInvited(value); };
  const usable = invited.map(id => team.members.find(member => member.id === id)).filter((member): member is TeamMember => Boolean(member && ready(member.executor)));
  const [mode, setMode] = useState<'chat' | 'meeting'>('chat');
  const discussion = state.mode === 'discuss' ? state.discussion : undefined;
  const [handRaise, setHandRaise] = useState(false);
  const [hostPick,setHostPick]=useState(true);
  // 闲聊 is an open-ended chat without a budget; 开会 is a discussion that closes once the topic is handled.
  const style: DiscussionStyle = mode === 'chat' ? 'chat' : 'work';
  const [minutesDialog,setMinutesDialog]=useState<{discussionId:string;revision:number;memberId:string;interrupt:boolean}>(),[minutesBusy,setMinutesBusy]=useState(false),[minutesError,setMinutesError]=useState('');
  const minutesMembers=team.members.filter(m=>discussion?.members.includes(m.id)&&ready(m.executor));
  async function openMinutes(){if(!discussion)return;const saved=discussion;setMinutesBusy(true);setMinutesError('');try{let lead:string|undefined;if(roomId.startsWith('project:')){const data=await rawInvoke<{flow?:{leadMemberId:string};overview?:{stage?:{leadMemberId?:string}}}>('projectFlow.get',{projectId:roomId.slice(8)});lead=data.overview?.stage?.leadMemberId??data.flow?.leadMemberId;}const candidates=saved.members.filter(id=>minutesMembers.some(m=>m.id===id));setMinutesDialog({discussionId:saved.id,revision:saved.revision,memberId:lead&&candidates.includes(lead)?lead:candidates[0]??'',interrupt:state.active});}catch{}finally{setMinutesBusy(false);}}
  async function confirmMinutes(){if(!minutesDialog)return;setMinutesBusy(true);setMinutesError('');try{await invoke('room.minutes',{discussionId:minutesDialog.discussionId,revision:minutesDialog.revision,memberId:minutesDialog.memberId});setMinutesDialog(undefined);}catch(e){setMinutesError((e as Error).message);}finally{setMinutesBusy(false);}}
  useEffect(() => { if (discussion) { const chat = discussion.style === 'chat'; setMode(chat ? 'chat' : 'meeting'); setInvited(discussion.members); setHandRaise(Boolean(discussion.handRaise));setHostPick(discussion.hostPick!==false); } }, [discussion?.id]);
  const [sending, setSending] = useState(false), [busy, setBusy] = useState(false),[stopping,setStopping]=useState(false);
  const [archiveId, setArchiveId] = useState<string>();
  const [panel, setPanel] = useState(false), [newTopic, setNewTopic] = useState<{ from?: RoomThread } | null>(null);
  // Anyone ready may write a summary, even if they are not invited to the current conversation.
  const writers = team.members.filter(member => ready(member.executor)&&(!personal||member.id===personal.memberId));
  const summarizer = useSummarizer(writers);
  const currentId = room.currentThreadId ?? (global ? DEFAULT_ROOM_THREAD : '');
  const noTopic=personal?.kind==='desk'&&!currentId;
  const selectedId = archiveId ?? currentId, archived = selectedId !== currentId;
  const composer=useComposerDraft(snapshot.dataDirectory,currentId&&!personalLoading?{roomId,threadId:currentId,restoreEpoch:snapshot.restoreEpoch}:undefined,rawInvoke);
  const draft=composer.value.text,setDraft=(text:string)=>composer.update(value=>({...value,text}));
  const replyTo=composer.value.replyTo,setReplyTo=(id:string|undefined)=>composer.update(value=>({...value,replyTo:id}));
  const workIntent=composer.value.workIntent??'ask',setWorkIntent=(value:'ask'|'add'|'supplement')=>composer.update(previous=>({...previous,workIntent:value}));
  const attach=useAttachments(invoke,[],{items:composer.value.attachments,update:change=>composer.update(value=>({...value,attachments:change(value.attachments)}))});
  // Only messages that arrive while a topic is open animate in; opening a room or paging history does not.
  const enterAfter = useMemo(() => new Date().toISOString(), [roomId, selectedId]);
  const enter = (message: RoomMessage) => message.at > enterAfter ? ' enter' : '';
  const threads = room.threads?.length ? room.threads : noTopic?[]:[{ id: currentId, title: '当前话题', createdAt: '' }];
  const thread = threads.find(item => item.id === selectedId);
  const [history, setHistory] = useState<RoomHistory | null>(null), [loading, setLoading] = useState(false);
  const request = useRef(0), loadingRef = useRef(false);
  useEffect(()=>{if(personal){++request.current;setHistory(null);setArchiveId(undefined);setNewTopic(null);}},[expectedFolder]);
  const list = useRef<HTMLDivElement>(null), textarea = useRef<HTMLTextAreaElement>(null), pinned = useRef(true);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  // Reading position: arrivals while scrolled up are counted, and on return a divider marks where the user left off.
  const seenKey = `${SEEN_KEY}:${currentId}`;
  const readSeen = () => { try { return localStorage.getItem(seenKey) ?? undefined; } catch { return undefined; } };
  const [unseen, setUnseen] = useState(0), [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [dividerAt, setDividerAt] = useState<string | undefined>(readSeen);
  const newest = useRef<string | undefined>(undefined), jumped = useRef(false);
  const markSeen = () => { if (newest.current) try { localStorage.setItem(seenKey, newest.current); } catch {} };
  const page = history?.threadId === selectedId ? history : null;
  const messages = useMemo(() => {const result=archived ? page?.messages ?? [] : mergeMessages(page?.messages ?? [], room.messages);return personal?.kind==='report'?mergeMemberReports(result):personal?result.sort((a,b)=>a.at.localeCompare(b.at)||Number(a.author!=='user')-Number(b.author!=='user')||a.id.localeCompare(b.id)):result;}, [archived, page, room.messages, personal?.kind]);
  const hasMore = page?.hasMore ?? (!archived && Boolean(room.hasMore));
  const before = page ? page.before : archived ? undefined : room.before;
  const acknowledged=useRef<string|undefined>(undefined);
  const acknowledge=()=>{const token=room.readToken;if(personal&&token&&pinned.current&&!archived&&acknowledged.current!==token){acknowledged.current=token;void invoke('room.read',{readToken:token}).catch(()=>{acknowledged.current=undefined;});}};
  useEffect(()=>{acknowledge();},[room.readToken,archived]);
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null), [mentionIndex, setMentionIndex] = useState(0);
  const mentionedWorker=project&&usable.find(m=>draft.includes('@'+m.name)||draft.includes('＠'+m.name));
  const candidates = mention ? usable.filter(member => member.name.toLowerCase().startsWith(mention.query.toLowerCase())) : [];
  const named = roomMentions(draft, team.members);
  const participants = named.ids.length ? named.ids.map(id => usable.find(member => member.id === id)).filter((member): member is TeamMember => Boolean(member)) : usable;

  useEffect(() => { if (global&&!personal) try { localStorage.setItem(INVITED_KEY, JSON.stringify(ownInvited)); } catch {} }, [ownInvited, global, Boolean(personal)]);
  async function loadHistory(older: boolean) {
    if (loadingRef.current || (older && (!hasMore || !before))) return;
    const revision = ++request.current;
    loadingRef.current = true; setLoading(true);
    if (older && list.current) { pinned.current = false; anchor.current = { height: list.current.scrollHeight, top: list.current.scrollTop }; }
    try {
      const result = await invoke<RoomHistory>('room.history', { threadId: selectedId, before: older ? before : undefined, limit: 100 });
      if (revision === request.current) setHistory(previous => ({ ...result, messages: older ? mergeMessages(result.messages, previous?.threadId === selectedId ? previous.messages : [], archived ? [] : room.messages) : result.messages }));
    } catch { if (revision === request.current) anchor.current = null; } finally { if (revision === request.current) { loadingRef.current = false; setLoading(false); } }
  }
  useEffect(() => {
    ++request.current; loadingRef.current = false; setLoading(false); setHistory(null); setMention(null); anchor.current = null; pinned.current = true;
    if (archived) void loadHistory(false);
    return () => { ++request.current; };
  }, [selectedId]);
  useEffect(() => { if (archiveId && !threads.some(item => item.id === archiveId)) setArchiveId(undefined); }, [archiveId, threads]);
  useEffect(() => {
    if (archived) return;
    if (!room.messages.length) { ++request.current; loadingRef.current = false; setLoading(false); setHistory(null); }
    else setHistory(previous => previous?.threadId === currentId ? { ...previous, messages: mergeMessages(previous.messages, room.messages) } : previous);
  }, [archived, currentId, room.messages]);
  useLayoutEffect(() => {
    if (anchor.current && list.current) { list.current.scrollTop = anchor.current.top + list.current.scrollHeight - anchor.current.height; anchor.current = null; }
  }, [messages]);
  const openedAtBottom=useRef('');
  useLayoutEffect(()=>{const key=roomId+':'+selectedId;if(personal&&messages.length&&list.current&&openedAtBottom.current!==key){openedAtBottom.current=key;pinned.current=true;list.current.scrollTop=list.current.scrollHeight;}},[roomId,selectedId,messages,Boolean(personal)]);

  const streamedBodies = useRef(new Map<string,{key:string;text:string}>());
  const live = useMemo(() => {
    const map = new Map<string, string>();
    const retained = new Map<string,{key:string;text:string}>();
    for (const message of messages) if (message.status === 'speaking' && message.runId) {
      const events = snapshot.events.filter(event => event.runId === message.runId);
      const deltas = events.filter(event => event.kind === 'delta').map(event => event.text).join('');
      const raw = message.discussionId ? deltas || events.filter(event => event.kind === 'message' && (event.data as any)?.role !== 'user').at(-1)?.text || '' : deltas;
      const status = snapshot.runs.find(run => run.id === message.runId)?.status;
      const key = `${message.runId}:${message.discussionTurn??''}:${message.discussionRevision??''}`;
      const previous = streamedBodies.current.get(message.id);
      // Other rooms load messages separately. A completed snapshot can arrive before room.get's final message.
      // Carry only this exact turn's validated preview across that gap, never across a failure or a new run.
      const carry = !global && !raw && (status === 'ended' || status === 'completed') && previous?.key === key ? previous.text : '';
      const hidden = !global && status && ['stopping','stopped','interrupted','unknown','failed'].includes(status);
      const text = hidden ? '' : raw ? message.discussionId ? streamDiscussionBody(raw,message.discussionTurn,message.discussionRevision) : raw : carry;
      map.set(message.id,text);
      if (!global) retained.set(message.id,{key,text});
    }
    streamedBodies.current = retained;
    return map;
  }, [global, messages, snapshot.events, snapshot.runs]);
  const lastLength = [...live.values()].join('').length + messages.length;
  useEffect(() => {
    const node = list.current; if (!node) return;
    const toBottom = () => { if (pinned.current) node.scrollTop = node.scrollHeight; };
    const observer = new ResizeObserver(toBottom);
    observer.observe(node);
    for (const child of Array.from(node.children)) observer.observe(child);
    toBottom(); return () => observer.disconnect();
  }, [lastLength, selectedId, dividerAt]);
  // Only a real topic change re-reads the position; a repeated mount must not pick up what this view just stored.
  const shownThread = useRef(currentId);
  useEffect(() => {
    if (shownThread.current === currentId) return;
    shownThread.current = currentId; newest.current = undefined; jumped.current = false; setUnseen(0); setDividerAt(readSeen());
  }, [currentId]);
  useEffect(() => {
    if (archived || !messages.length) return;
    const latest = messages.reduce((top, message) => message.at > top ? message.at : top, ''), before = newest.current;
    if (!before || latest > before) newest.current = latest;
    if (before && !pinned.current) {
      const arrived = messages.filter(message => message.at > before && message.author !== 'user' && !message.discussionControl).length;
      if (arrived) setUnseen(count => count + arrived);
    }
    if (pinned.current) markSeen();
  }, [archived, messages]);
  const dividerIndex = !archived && dividerAt ? messages.findIndex(message => message.at > dividerAt && message.author !== 'user' && !message.discussionControl) : -1;
  // Opening the room with unread messages starts at the divider rather than the bottom.
  useLayoutEffect(() => {
    const node = list.current, divider = node?.querySelector<HTMLElement>('.room-new-divider');
    if (personal || jumped.current || !node || !divider) return;
    jumped.current = true;
    if (node.scrollHeight > node.clientHeight) { pinned.current = false; node.scrollTop += divider.getBoundingClientRect().top - node.getBoundingClientRect().top - 12; }
  }, [dividerIndex]);
  function jumpToLatest() {
    const node = list.current; if (!node) return;
    pinned.current = true; node.scrollTop = node.scrollHeight; setUnseen(0); markSeen();acknowledge();
  }
  // Opening a pending item: switch to its topic, then bring the message into view once it is loaded.
  const focusing = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!focus) return;
    setArchiveId(focus.threadId && focus.threadId !== currentId && threads.some(item => item.id === focus.threadId) ? focus.threadId : undefined);
    focusing.current = focus.messageId;
  }, [focus?.nonce]);
  useLayoutEffect(() => {
    const id = focusing.current, node = list.current; if (!id || !node) return;
    const target = node.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`); if (!target) return;
    focusing.current = undefined; pinned.current = false; jumped.current = true;
    target.scrollIntoView({ block: 'center' }); target.classList.remove('focus-flash'); void target.offsetWidth; target.classList.add('focus-flash');
  }, [messages, focus?.nonce]);
  const speaking = state.active ? team.get(state.speaking) : undefined;
  const compressing = state.compressing ? team.get(state.compressing) : undefined;
  const current = threads.find(item => item.id === currentId) ?? { id: currentId, title: '当前话题', createdAt: '' };

  function toggle(id: string) { setInvited(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]); }
  function updateMention(value: string, caret: number) {
    const prefix = value.slice(0, caret), start = Math.max(prefix.lastIndexOf('@'), prefix.lastIndexOf('＠'));
    const query = prefix.slice(start + 1);
    setMention(start >= 0 && query.length <= 40 && !/[\n@＠，。！？,:;：；!?()[\]{}]/.test(query) ? { start, end: caret, query } : null);
    setMentionIndex(0);
  }
  function chooseMention(member: TeamMember) {
    if (!mention) return;
    const value = `${draft.slice(0, mention.start)}@${member.name} ${draft.slice(mention.end)}`;
    const caret = mention.start + member.name.length + 2;
    setDraft(value); setMention(null);
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(caret, caret); });
  }
  async function send(text = draft) {
    const body = text.trim();
    const sentVersion=composer.version,submitted={...composer.value,text};
    if(project?.onTaskRequest&&mentionedWorker&&workIntent!=='ask'){if(await project.onTaskRequest(mentionedWorker.id,body.replace('@'+mentionedWorker.name,'').replace('＠'+mentionedWorker.name,'').trim(),workIntent)){composer.sent(submitted,sentVersion);setMention(null);}return;}
    if ((!body && !attach.items.length) || sending || busy || compressing || (state.active && state.mode !== 'discuss') || archived || historyOnly || personalLoading || noTopic) return;
    setSending(true); pinned.current = true; setDividerAt(undefined);
    try { await invoke('room.send', { text: body, memberIds: usable.map(member => member.id), mode: 'discuss', style, maxMinutes: 0, handRaise: mode === 'meeting' && handRaise,hostPick, replyTo, ...(attach.items.length ? { attachments: attach.items } : {}) }); composer.sent(submitted,sentVersion); setMention(null); } catch {} finally { setSending(false); }
  }
  async function resumeDiscussion() {
    const acknowledgeUnknown = Boolean(discussion?.unknownRunId || discussion?.unknownRunIds?.length);
    if (acknowledgeUnknown && !window.confirm('上次执行结果未知。请先核对已收到的内容和活动记录。确认后将按当前讨论继续，不会重发原轮次。')) return;
    try { await invoke('room.resume', { acknowledgeUnknown, maxMinutes: 0, handRaise: mode === 'meeting' && handRaise,hostPick }); } catch {}
  }
  async function chooseHand(choice:'member'|'auto'|'skip',memberId?:string){
    if(busy||!discussion?.handRound||!(discussion.phase==='awaiting-host'||discussion.phase==='raising'&&discussion.hostPick&&discussion.handRound.status==='collecting'))return;
    setBusy(true);try{await invoke('room.host',{discussionId:discussion.id,revision:discussion.revision,handRoundId:discussion.handRound.id,choice,memberId});}catch{}finally{setBusy(false);}
  }
  async function endDiscussion() {
    if(!discussion||busy)return;
    const acknowledgeUnknown=Boolean(discussion.unknownRunId||discussion.unknownRunIds?.length);
    if(acknowledgeUnknown&&!window.confirm('上次执行结果未知。请先核对已收到的内容和活动记录。确认后结束本次讨论，不会重发原轮次。'))return;
    setBusy(true);
    try{await invoke('room.end',{discussionId:discussion.id,acknowledgeUnknown},'本次讨论已由你结束。');}catch{}finally{setBusy(false);}
  }
  const afterTopicChange = () => { setReloads(n => n + 1); ++request.current; loadingRef.current = false; setLoading(false); setHistory(null); setArchiveId(undefined); setMention(null); pinned.current = true; };
  async function manage(action: 'clear' | 'delete') {
    const question = action === 'delete' ? `删除归档话题「${thread?.title}」？这段记录将永久删除，当前话题不受影响。`
      : '清空当前话题？消息会删除，成员也会忘掉本话题。归档记录和项目会话保留。';
    if (!window.confirm(question)) return;
    setBusy(true);
    try { await invoke(`room.${action}`, action === 'delete' ? { threadId: selectedId } : undefined, action === 'delete' ? '归档话题已删除。' : '当前话题已清空。'); if(action==='clear')composer.clear(); afterTopicChange(); } catch {} finally { setBusy(false); }
  }
  async function compressCurrent() {
    if (!summarizer.member || !window.confirm(`让 ${summarizer.member.name} 把当前话题压缩成摘要？之后成员从摘要继续，消息仍然保留。这会使用一次成员额度。`)) return;
    setBusy(true);
    try { await invoke('room.compress', { threadId: currentId, memberId: summarizer.member.id }, '已压缩，成员接下来从摘要继续。'); pinned.current = true; } catch {} finally { setBusy(false); }
  }
  async function uninherit() {
    if (!thread?.inherited || !window.confirm(`不再延续「${thread.inherited.title}」？成员会只从本话题自己的内容继续，原来的话题记录不受影响。`)) return;
    setBusy(true);
    try { await invoke('room.uninherit', { threadId: thread.id }, '已不再延续之前的话题。'); } catch {} finally { setBusy(false); }
  }
  async function exportTopic(threadId = selectedId) {
    setBusy(true);
    try {
      const result = await invoke<{ title: string; content: string }>('room.export', { threadId });
      await invoke('file.save', { name: `AIROOM ${personal?personal.kind==='desk'?'工位':'汇报':'聊天室'} - ${result.title}.md`, content: result.content });
    } catch {} finally { setBusy(false); }
  }
  const name = (message: RoomMessage) => message.authorName ?? (message.author === 'user' ? profile.name || '你' : team.get(message.author)?.name ?? '成员');
  const authorName = (author: string) => author === 'user' ? profile.name || '你' : team.get(author)?.name ?? '成员';
  // Less frequent message actions live in one menu, opened from "…" or by right-clicking the message.
  function messageMenu(message: RoomMessage, canReply: boolean): MenuItem[] {
    const text = message.text, finished = message.author === 'user' || message.status === 'done';
    return [
      { label: '复制文字', icon: <Copy size={14} />, disabled: !text, onSelect: () => { void navigator.clipboard.writeText(text).catch(() => {}); } },
      ...(canReply ? [{ label: '回复这条', icon: <Reply size={14} />, onSelect: () => { setReplyTo(message.id); textarea.current?.focus(); } }] : []),
      ...(global ? [{ label: '交给项目', icon: <Briefcase size={14} />, disabled: !text || !finished, onSelect: () => setHandoff({ threadId: selectedId, messageId: message.id, text: handoffText(name(message), text) }) }] : []),
    ];
  }
  const openMessageMenu = (event: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, items: MenuItem[]) => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, items }); };
  const moreButton = (message: RoomMessage, canReply: boolean) => <button type="button" className="icon-button room-more-button" aria-label={`${name(message)} 的消息操作`} title="更多操作" onClick={event => openMessageMenu(event, messageMenu(message, canReply))}><MoreHorizontal size={14} /></button>;
  async function react(message: RoomMessage, emoji: string) { try { await invoke('room.react', { messageId: message.id, emoji }); } catch {} }

  const recordItems: MenuItem[] = [
    ...(messages.length > 0 ? [{ label: '压缩上下文', icon: <Sparkles size={14} />, disabled: busy || state.active || Boolean(compressing) || !summarizer.member || !snapshot.backendReady || Boolean(surface?.readOnly), onSelect: () => void compressCurrent() }] : []),
    { label: '导出会议记录', icon: <Download size={14} />, disabled: busy || state.active || !messages.length || !snapshot.backendReady, onSelect: () => void exportTopic() },
    ...(surface ? [] : ['separator' as const, { label: '清空会议记录', icon: <Eraser size={14} />, danger: true, disabled: busy || state.active || !messages.length || !snapshot.backendReady, onSelect: () => void manage('clear') }]),
  ];
  if (surface?.recordActions) surface.recordActions.current = recordItems;
  const Root = project || personal ? 'section' : 'main';
  async function selectTopic(id:string){if(personal){try{await invoke('room.select',{threadId:id});afterTopicChange();}catch{}}else setArchiveId(id===currentId?undefined:id);}
  return <Root className={`room ${project ? 'room-embedded' : ''} ${personal ? 'personal-room' : ''}`} aria-label={personal?personal.kind==='desk'?'工位聊天':'汇报对话':project ? '会议聊天' : undefined}>
    {!project && !personal && <RoomBackdrop />}
    <div className="room-top">
    {project ? surface?.recordActions ? null : <div className="room-tool-row">
      <span className="room-tool-title">{surface?.title??'会议聊天'}<small>{surface?.hint??'成员可查看项目文件，但不改文件；正在工作的成员只回答 @ 点名'}</small></span>
      <button type="button" className="icon-button topic-more" aria-label="会议记录操作" aria-haspopup="menu" title="压缩、导出和清空会议记录" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom + 6, items: recordItems }); }}><MoreHorizontal size={16} /></button>
    </div> : <>
    <header className="room-head">
      <span className="room-icon"><MessagesSquare size={20} /></span>
      <div className="room-title"><h1>{personal?.title??'茶歇室'}</h1><p title={personal?.hint}>{personal?.hint??'闲聊时自由接话，开会时轮流发言，随时都可以插话。'}</p></div>
      <div className="room-actions">
        {personal?.headerActions}
        {split && <button type="button" className={`button small secondary ${split.active ? 'pressed' : ''}`} aria-pressed={split.active} title={split.active ? '回到单独的聊天室' : '聊天室和当前项目会话左右并排'} onClick={split.toggle}><Columns2 size={14} />{split.active ? '取消并排' : '并排显示'}</button>}
        {personal?.kind==='report'&&<button type="button" className="icon-button" title="导出完整话题" aria-label="导出当前话题" disabled={busy || state.active || !messages.length || !snapshot.backendReady} onClick={() => void exportTopic()}><Download size={16} /></button>}
      </div>
    </header>
    {personal?.kind==='report'&&personal.subbar&&<div className="room-topic-bar">{personal.subbar}</div>}
    {personal?.kind!=='report'&&<div className="room-topic-bar"><label className="topic-picker"><span>话题</span><select aria-label="话题记录" value={selectedId} disabled={busy||noTopic||Boolean(personal&&state.active)} onChange={event => void selectTopic(event.target.value)}>{noTopic&&<option value="">当前文件夹暂无话题</option>}{threads.map(item => <option key={item.id} value={item.id}>{item.archivedAt ? '归档 · ' : '当前 · '}{item.title}</option>)}</select></label>
      {archived ? <span className="topic-archived">归档记录 · 只读 <button type="button" className="link-button" onClick={() => setArchiveId(undefined)}>回到当前话题</button><button type="button" className="link-button" disabled={busy || state.active || Boolean(compressing)} onClick={() => thread && setNewTopic({ from: thread })}><FileStack size={12} />接着聊</button></span>
        : <button type="button" className="button small secondary" disabled={busy || state.active || Boolean(compressing) || (!personal&&!messages.length) || !snapshot.backendReady} onClick={() => setNewTopic({})}><MessageSquarePlus size={14} />开新话题</button>}
      <button type="button" className={`icon-button topic-more ${panel ? 'pressed' : ''}`} aria-label="话题操作" aria-haspopup="menu" title="话题管理、压缩、导出和清空" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom + 6, items: [
        { label: panel ? '收起话题管理' : '话题管理', icon: <Layers size={14} />, onSelect: () => setPanel(value => !value) },
        ...(!archived && messages.length > 0 ? [{ label: '压缩上下文', icon: <Sparkles size={14} />, disabled: busy || state.active || Boolean(compressing) || !summarizer.member || !snapshot.backendReady || historyOnly, onSelect: () => void compressCurrent() }] : []),
        { label: personal ? '导出当前话题' : '导出聊天室', icon: <Download size={14} />, disabled: busy || state.active || !messages.length || !snapshot.backendReady, onSelect: () => void exportTopic() },
        'separator' as const,
        archived ? { label: '删除归档话题', icon: <Trash2 size={14} />, danger: true, disabled: busy || state.active, onSelect: () => void manage('delete') }
          : { label: '清空当前话题', icon: <Eraser size={14} />, danger: true, disabled: busy || state.active || !messages.length || !snapshot.backendReady, onSelect: () => void manage('clear') },
      ] }); }}><MoreHorizontal size={16} /></button>
      {thread && (thread.summary || thread.inherited) && <div className="topic-bar-summary"><SummaryNote thread={thread} /><span className="topic-bar-links">{thread.summary?.proposals?.length ? <button type="button" className="link-button topic-memory" onClick={() => setProposing(true)}><BookmarkPlus size={12} />有 {thread.summary.proposals.length} 条可以记住的事</button> : null}{thread.inherited && !archived && <button type="button" className="link-button topic-uninherit" disabled={busy || state.active || Boolean(compressing) || !snapshot.backendReady} title="当前话题不再带着之前话题的摘要" onClick={() => void uninherit()}><Unlink size={12} />不再延续</button>}{global&&thread.summary && <button type="button" className="link-button topic-handoff" onClick={() => setHandoff({ threadId: thread.id, text: `请根据团队聊天室话题「${thread.title}」的讨论摘要完成任务。\n\n${thread.summary!.text}` })}><Briefcase size={12} />把摘要交给项目</button>}</span></div>}
    </div>}</>}
    {project && thread?.summary && <div className="room-topic-bar"><div className="topic-bar-summary"><SummaryNote thread={thread} /></div></div>}
    {!archived && !personal && !surface?.readOnly && <RoomPresence discussion={discussion} state={state} invited={invited} ready={member => ready(member.executor)}
      locked={state.active || Boolean(discussion && discussion.phase !== 'idle')} busy={busy || Boolean(compressing) || !snapshot.backendReady} onToggle={toggle}
      showNextStep={!surface} flowNextStep={Boolean(project?.flowNextStep)} onConfigure={project?.onConfigureMember}
      onHost={id=>void chooseHand('member',id)}
      onPause={() => void invoke('room.pause').catch(() => {})} onResume={() => void resumeDiscussion()} onEnd={() => void endDiscussion()} />}
    </div>
    <div className="room-messages" role="log" aria-label={surface?'圆桌消息':personal?personal.kind==='desk'?'个人工位消息':'个人汇报消息':project?'项目会议室消息':'茶歇室消息'} ref={list} onScroll={event => { const node = event.currentTarget; pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; if (pinned.current && !archived) { if (unseen) setUnseen(0); markSeen();acknowledge(); } if (node.scrollTop < 40 && hasMore && !loadingRef.current) void loadHistory(true); }}>
      {hasMore && <button type="button" className="button small quiet room-load-more" disabled={loading} onClick={() => void loadHistory(true)}>{loading ? '正在加载…' : '加载更早的消息'}</button>}
      {loading && !messages.length && <div className="room-system">正在加载历史…</div>}
      {!messages.length && !archived && project?.empty}
      {!messages.length && !archived && personal?.empty}
      {!messages.length && !archived && !project && !personal && <div className="room-empty">
        <div className="room-empty-team">{team.members.map(member => <Avatar key={member.id} member={member} size={56} />)}</div>
        <h2>大家都在，聊点什么？</h2><p>成员只会说话，不会执行命令或修改文件。</p>
        <div className="room-suggestions">{SUGGESTIONS.map(text => <button type="button" key={text} disabled={busy || state.active} onClick={() => { if (text.startsWith('开个会')) { setMode('meeting'); setDraft(text.replace(/^开个会：/, '')); textarea.current?.focus(); } else void send(text); }}>{text}</button>)}</div>
      </div>}
      {messages.map((message, index) => <Fragment key={message.id}>{index === dividerIndex && <div className="room-new-divider" role="separator"><span>以下是新消息</span></div>}{(() => {
        if (message.contextOnly) return null;
        if (message.system || message.author === 'system') return message.link ? <RoomNote key={message.id} message={message} snapshot={snapshot} invoke={invoke} archived={archived} onOpen={(projectId, sessionId) => onOpenSession?.(projectId, sessionId)} /> : <div key={message.id} className="room-system" data-message-id={message.id}>{message.text}</div>;
        if (message.discussionControl) return null;
        const streamed = live.get(message.id) ?? '';
        const text = message.status === 'speaking' ? message.discussionId ? streamed : isRoomPass(streamed) || roomMarkerPending(streamed) || roomReaction(streamed) ? '' : streamed || message.text : message.author==='user'?message.text:readableContent(message.text);
        const card = surface?.renderMessage?.(message,text)??personal?.renderMessage?.(message)??(project?.renderFlow && (message.flowPlan || message.flowDecision || message.flowReport || message.jointReview || message.roundtable) ? project.renderFlow(message) : undefined);
        if (card) return <div key={message.id} className={`room-line flow-line member-${message.author}${enter(message)}`} data-message-id={message.id}>{message.author === 'user' ? <UserAvatar name={name(message)} avatar={profile.avatar} size={30} /> : <Avatar member={team.get(message.author)} id={message.author} size={30} />}<div className="flow-line-body"><span className="room-meta"><strong>{name(message)}</strong><time>{time(message.at)}</time></span><ErrorBoundary area="汇报消息" compact>{card}</ErrorBoundary></div></div>;
        // A reaction-only turn shows on the message it answered, not as a line of its own.
        if (message.status === 'passed' && message.reaction) return null;
        if (message.status === 'passed') return <details key={message.id} className="room-passed" data-message-id={message.id}><summary>{name(message)} 选择不发言 <time>{time(message.at)}</time></summary><p>这次没有需要补充的内容。判断是否发言仍会使用额度。</p></details>;
        if (message.author === 'user') return <div key={message.id} className={`room-line mine${enter(message)}`} data-message-id={message.id}>
          <div className="room-bubble-wrap"><span className="room-meta"><time>{time(message.at)}</time><strong>{name(message)}</strong></span><div className="room-bubble" onContextMenu={event => openMessageMenu(event, messageMenu(message, false))}>{message.text}</div><AttachmentList items={message.attachments} invoke={invoke} align="end" /><Reactions message={message} name={authorName} /><span className="room-tools">{moreButton(message, false)}</span>{personal?.messageActions?.(message,messages)}</div>
          <UserAvatar name={name(message)} avatar={profile.avatar} size={36} />
        </div>;
        const member = team.get(message.author);
        const reactable = !archived && snapshot.backendReady && ['done', 'failed', 'stopped'].includes(message.status ?? 'done');
        const long = message.status !== 'speaking' && isLong(text), folded = long && !expanded.has(message.id);
        const canReply = !archived && message.status === 'done';
        const run = message.runId ? snapshot.runs.find(item => item.id === message.runId) : undefined;
        const unknown = run?.status === 'unknown' && message.status !== 'speaking';
        const actual = run?.effectiveConfig?.modelStatus === 'reported' ? [run.effectiveConfig.model, run.effectiveConfig.effortStatus === 'reported' ? run.effectiveConfig.effort : undefined].filter(Boolean).join(' · ') : '';
        const silent = message.error ?? (unknown ? '成员程序结束了这一轮，但没有返回内容，结果待核对。可能是登录失效或连接中断，可在“设置与连接”检查这位成员。工作台不会自动重发。' : run?.error ?? '（没有说话）');
        return <div key={message.id} className={`room-line member-${member?.id ?? 'claude'}${enter(message)}`} data-message-id={message.id}>
          {member ? <Avatar member={member} size={36} mood={message.status === 'speaking' ? 'working' : undefined} /> : <span className="room-retired-avatar" aria-hidden="true">{[...name(message)][0]}</span>}
          <div className="room-bubble-wrap"><span className="room-meta"><strong>{name(message)}</strong><time title={run ? effectiveConfigText(run.requestedConfig, run.effectiveConfig) : undefined}>{time(message.at)}</time>{personal && actual && <span className="room-model" title="这一轮实际使用的模型与思考程度">{actual}</span>}{message.inReplyTo && <span className="room-reply-to">回复 {messages.find(m => m.id === message.inReplyTo)?.authorName ?? '较早的消息'}</span>}{message.kind === 'summary' && <em>会议总结</em>}{message.status === 'failed' && <em className="room-failed">{unknown ? '结果待核对' : run?.delivery==='prepared' ? '未发送' : '回复失败'}</em>}{message.status === 'stopped' && <em>已停止</em>}</span>
            <div className={`room-bubble ${message.status === 'speaking' && !text ? 'typing' : ''} ${folded ? 'folded' : ''}`} onContextMenu={message.status === 'speaking' ? undefined : event => openMessageMenu(event, messageMenu(message, canReply))}>{text ? <Markdown text={text} /> : message.status === 'speaking' ? <span className="typing-dots"><i /><i /><i /></span> : <span className="room-silent">{silent}</span>}</div>
            {long && <button type="button" className="link-button room-fold-button" aria-expanded={!folded} onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next; })}>{folded ? '展开全文' : '收起'}</button>}
            {message.imageGeneration&&message.status==='speaking'&&!message.generatedImages?.length&&<small className="room-reply-note">正在生成图片，可以随时停止。</small>}
            <GeneratedImages images={message.generatedImages} invoke={invoke} onEdit={!archived&&!state.active&&canGenerateImage?image=>setImageDialog({text:draft,draftVersion:composer.version,attachments:[image]}):undefined}/>
            {message.status === 'failed' && message.error && text && <small className="room-error">{message.error}</small>}
            <Reactions message={message} name={authorName} onToggle={reactable ? emoji => void react(message, emoji) : undefined} />
            {message.status !== 'speaking' && <span className="room-tools">{canReply && <button type="button" className="link-button room-reply-button" aria-label={`回复 ${name(message)} 的消息`} onClick={() => { setReplyTo(message.id); textarea.current?.focus(); }}>回复这条</button>}{moreButton(message, canReply)}</span>}
            {personal?.messageActions?.(message,messages)}
          </div>
        </div>;
      })()}</Fragment>)}
      {personal?.dock}{archived && surface?.dock}
    </div>
    {unseen > 0 && <button type="button" className="room-jump" onClick={jumpToLatest}><ArrowDown size={14} />有 {unseen} 条新消息</button>}
    {!archived && (() => { const roomHint = personal ? '' : compressing && !state.active ? `${compressing.name} 正在整理话题摘要…` : discussion?.phase==='awaiting-host' ? '等你点名' : state.active ? speaking ? `${speaking.name} 正在说话…` : '正在安排发言…' : candidates.length ? '选择要点名的成员' : named.unknown.length ? `未识别点名：${named.unknown.join('、')}` : named.ids.length ? mode==='meeting'?'只请被 @ 的成员回答，之后等你继续':`优先请 ${participants.map(member => member.name).join('、')} 接话，其他在场成员仍可参与` : usable.length ? mode === 'chat' ? '大家自由接话，聊到自然告一段落为止' : handRaise ? '每轮轮流发言后先举手，想补充的再发言' : '每人回答一次后等你，点击整理会议纪要结束' : '先邀请至少一位已准备好的成员'; return <div className="room-composer">
      {(project?.dock ?? surface?.dock) && <div className="room-dock-anchor">{project?.dock ?? surface?.dock}</div>}
      {replyTo && <div className="room-reply-note">回复：{messages.find(m => m.id === replyTo)?.text.slice(0,80) ?? '较早消息'} <button type="button" className="link-button" onClick={() => setReplyTo(undefined)}>取消回复</button></div>}
      <div className={`composer room-input ${attach.dragging ? 'dragging' : ''}`} {...attach.dropTarget}>
        {attach.dragging && <div className="drop-hint">松开即可附上文件</div>}
        <AttachmentTray items={attach.items} onRemove={attach.remove} />
        {composer.error&&<p role="status" className="composer-draft-error">{composer.error} <button type="button" className="link-button" onClick={composer.retry}>重试保存草稿</button></p>}
        {discussion?.handRound&&(discussion.phase==='awaiting-host'||discussion.phase==='raising'&&discussion.hostPick&&discussion.handRound.status==='collecting')&&<section className="room-host-choice" aria-label="举手点名">
          <p>{discussion.phase==='raising'?`正在收集举手（${Object.values(discussion.handRound.ballots).filter(b=>!['pending','running'].includes(b.status)).length}/${Object.keys(discussion.handRound.ballots).length} 已完成）。已举手的成员可先点名，未完成的举手会撤回。`:'举手已收集，请选谁接着说。'}</p>
          {Object.entries(discussion.handRound.ballots).some(([,b])=>b.status==='failed'||b.status==='invalid')&&<p className="panel-muted">{Object.entries(discussion.handRound.ballots).filter(([,b])=>b.status==='failed'||b.status==='invalid').map(([id])=>team.get(id)?.name??'成员').join('、')} 的举手未完成，可查看活动记录。</p>}
          <div className="room-host-actions">{discussion.members.filter(id=>discussion.handRound!.ballots[id]?.status==='done'&&(discussion.handRound!.ballots[id].want??0)>0).map(id=><button type="button" className="button small secondary" key={id} disabled={busy||!snapshot.backendReady||!ready(team.get(id)?.executor??'')} onClick={()=>void chooseHand('member',id)}>请 {team.get(id)?.name??'成员'} 发言 · {discussion.handRound!.ballots[id].want}/3</button>)}<button type="button" className="button small quiet" disabled={busy||!snapshot.backendReady||!Object.values(discussion.handRound.ballots).some(b=>b.status==='done'&&(b.want??0)>0)} onClick={()=>void chooseHand('auto')}>按举手自动选</button><button type="button" className="button small quiet" disabled={busy||!snapshot.backendReady} onClick={()=>void chooseHand('skip')}>都不用补充，下一轮</button></div>
        </section>}
        {mentionedWorker&&project?.onTaskRequest&&<label className="room-work-intent">@{mentionedWorker.name}<select aria-label="点名用途" value={workIntent} onChange={e=>setWorkIntent(e.target.value as typeof workIntent)}><option value="ask">只是问问</option><option value="add">安排新任务</option><option value="supplement">补充到 TA 当前的任务</option></select></label>}
        {candidates.length > 0 && <div className="room-mentions" role="listbox" id="room-mentions" aria-label="点名成员">{candidates.map((member, index) => <button type="button" role="option" id={`room-mention-${index}`} key={member.id} aria-selected={index === mentionIndex % candidates.length} className={index === mentionIndex % candidates.length ? 'selected' : ''} onMouseDown={event => event.preventDefault()} onClick={() => chooseMention(member)}><Avatar member={member} size={24} ring={false} /><span>@{member.name}</span></button>)}</div>}
        <textarea ref={textarea} value={draft} aria-label={personal?personal.kind==='desk'?'在工位里说话':'在汇报里说话':project ? '在会议室里说话' : '在聊天室里说话'} aria-autocomplete="list" aria-controls={candidates.length ? 'room-mentions' : undefined} aria-activedescendant={candidates.length ? `room-mention-${mentionIndex % candidates.length}` : undefined} placeholder={personal?'写下问题或要求… Enter 发送，Shift + Enter 换行':mode === 'meeting' ? '写下会议议题或随时补充… Enter 发送，Shift + Enter 换行，@ 谁就只请谁回答' : '说点什么… Enter 发送，Shift + Enter 换行，@ 可指定优先接话者'} onChange={event => { setDraft(event.target.value); if(!personal)updateMention(event.target.value, event.target.selectionStart); }} onClick={event => {if(!personal)updateMention(event.currentTarget.value, event.currentTarget.selectionStart);}} onKeyDown={event => {
          if (candidates.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setMentionIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length); }
          else if (candidates.length && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); chooseMention(candidates[mentionIndex % candidates.length]); }
          else if (isSendKey(event)) { event.preventDefault(); void send(); }
          else if (event.key === 'Escape') setMention(null);
        }} disabled={!snapshot.backendReady || busy || historyOnly || personalLoading || noTopic || !composer.ready} />
        {historyOnly&&<p className="panel-muted" role="status">{surface?.readOnly?surface.hint:personal?.kind==='report'?'原成员已删除，汇报事实保留。':'这份话题只供阅读；继续工作请新开话题。'}</p>}<div className="composer-bottom"><AttachButton onPick={() => void attach.pick()} busy={attach.busy} disabled={!snapshot.backendReady||!composer.ready||historyOnly} />{!project && !personal && <button type="button" className="composer-tool" aria-label="生成图片" disabled={!canGenerateImage||state.active||busy||sending||Boolean(compressing)||!snapshot.backendReady} title={state.active?'生成图片：先暂停讨论并等待当前发言结束':canGenerateImage?'生成图片：让 Codex 生成或修改一张图片':'生成图片：需要连接支持绘图的 Codex，并允许联网'} onClick={()=>setImageDialog({text:draft,draftVersion:composer.version,attachments:attach.items})}><ImagePlus size={16}/></button>}{personal?.composerControls?.(room)}{!personal&&<div className="composer-mode"><div className="segmented" role="radiogroup" aria-label="聊天方式"><button type="button" role="radio" aria-checked={mode === 'chat'} className={mode === 'chat' ? 'selected' : ''} disabled={state.active} onClick={() => setMode('chat')} title="大家自由接话，不限次数；聊到自然告一段落、大家都同意时会收尾">闲聊</button><button type="button" role="radio" aria-checked={mode === 'meeting'} className={mode === 'meeting' ? 'selected' : ''} disabled={state.active} onClick={() => setMode('meeting')} title="每人回答一次后等你；由你点击整理会议纪要结束">开会</button></div>{mode === 'meeting' && <><label className="room-hand-option" title="一轮回答后举手，每人最多补充一次，没人举手后等你。单人会议不需要举手。举手也计入调用次数。"><input type="checkbox" checked={handRaise&&participants.length>1} disabled={participants.length<2||state.active||discussion?.phase==='awaiting-host'} onChange={e => {setHandRaise(e.target.checked);if(e.target.checked)setHostPick(true);}} />举手模式</label>{handRaise&&<label className="room-hand-option"><input type="checkbox" checked={hostPick} disabled={state.active||discussion?.phase==='awaiting-host'} onChange={e=>setHostPick(e.target.checked)}/>举手后由我点名</label>}</>}</div>}<span className="composer-hint" title={personal?undefined:roomHint}>{personal?personal.kind==='desk'?personalSession?.restoredHistoryOnly?'只读历史':personalSession&&!personalSession.writeMode?'只读查看当前文件夹':personalSession?.workspaceKind==='original'?'直接读写当前文件夹':'在任务副本中工作，应用后写回原文件夹':'只读回答；改要求请通过任务按钮确认':roomHint}{composer.hasDraft?' · 草稿已保留':''}</span>{!personal&&(discussion&&discussion.phase!=='idle'?discussion.style!=='chat':mode==='meeting')&&<button type="button" className={`button small ${discussion?.phase==='waiting_user'&&!discussion.questions.some(q=>q.to==='user'&&pendingDiscussionQuestion(q))?'primary':'secondary'} composer-minutes`} aria-label="整理会议纪要" disabled={!snapshot.backendReady||stopping||minutesBusy||historyOnly||!hasMeetingRemarks(discussion,messages)||discussion?.phase==='summarizing'||!minutesMembers.length} onClick={()=>void openMinutes()}><FileStack size={15}/>整理会议纪要</button>}{(stopping||surface?.active||state.active||compressing||state.generatingImage||discussion&&['talking','raising','awaiting-host','closing','summarizing'].includes(discussion.phase))&&<button type="button" className="button small stop-button" aria-label="中止当前对话" disabled={!snapshot.backendReady||stopping} onClick={()=>{setStopping(true);void invoke('room.stop').catch(()=>{}).finally(()=>setStopping(false));}}><StopCircle size={15}/>中止</button>}<button type="button" className="send-button room-send" aria-label={personal?personal.kind==='desk'?'发送到工位':'发送到汇报':mode === 'meeting' && !(discussion && discussion.phase !== 'idle') ? '开始会议' : '发送到聊天室'} disabled={(!draft.trim() && !attach.items.length) || sending || busy || (state.active && state.mode !== 'discuss') || Boolean(compressing) || (!usable.length && !discussion)  || !snapshot.backendReady || historyOnly || personalLoading || noTopic || !composer.ready} onClick={() => void send()}>{sending ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}</button></div>
      </div>
    </div>; })()}
    {panel && <TopicPanel onChanged={() => setReloads(n => n + 1)} snapshot={personal?{...snapshot,room}:snapshot} personal={Boolean(personal)} historyOnly={historyOnly} selectedId={selectedId} usable={writers} invoke={invoke} busy={busy}
      onSelect={id => { void selectTopic(id); setPanel(false); }} onContinue={item => personal?void selectTopic(item.id):setNewTopic({ from: item })}
      onExport={id => void exportTopic(id)} onClear={() => void manage('clear')} onClose={() => setPanel(false)} />}
    {minutesDialog&&<Modal title="整理会议纪要" subtitle="依据目前已保存的发言整理结论、分歧和下一步；写完后结束本次会议。" onClose={()=>{if(!minutesBusy)setMinutesDialog(undefined);}}><div className="modal-body"><label className="field">整理纪要的成员<select aria-label="纪要成员" value={minutesDialog.memberId} disabled={minutesBusy} onChange={e=>setMinutesDialog({...minutesDialog,memberId:e.target.value})}>{minutesMembers.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>{minutesDialog.interrupt&&<p>正在进行的发言会先中止，已保存的发言保留。</p>}<p>预计 1 次调用。</p>{minutesError&&<p role="alert">{minutesError}</p>}</div><div className="modal-footer"><button className="button quiet" disabled={minutesBusy} onClick={()=>setMinutesDialog(undefined)}>取消</button><button className="button primary" disabled={minutesBusy||!minutesDialog.memberId} onClick={()=>void confirmMinutes()}>{minutesBusy?'正在处理…':'确认整理'}</button></div></Modal>}
    <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    {imageDialog&&<ImageGenerationDialog snapshot={snapshot} invoke={invoke} text={imageDialog.text} attachments={imageDialog.attachments} onClose={()=>setImageDialog(null)} onSent={()=>{setImageDialog(null);composer.clear(imageDialog.draftVersion);pinned.current=true;}}/>}
    {proposing && thread?.summary?.proposals?.length ? <MemoryProposalDialog snapshot={snapshot} thread={thread} invoke={invoke} onClose={() => setProposing(false)} /> : null}
    {handoff && <HandoffDialog snapshot={snapshot} invoke={invoke} source={handoff} onClose={() => setHandoff(null)} onDone={() => setHandoff(null)} />}
    {newTopic && <NewTopicDialog snapshot={personal?{...snapshot,room}:snapshot} personal={Boolean(personal)} current={current} from={newTopic.from} usable={writers} invoke={invoke} onClose={() => setNewTopic(null)} onDone={() => { setNewTopic(null); setPanel(false); afterTopicChange(); }} />}
  </Root>;
}
