import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCheck, CircleHelp, GitMerge, Inbox, KeyRound, ListChecks, MessageCircleQuestion, ShieldCheck, Split, X } from 'lucide-react';
import { ATTENTION_KINDS, type AttentionItem, type AttentionSummary } from '../shared/attention';
import { Avatar, useTeam } from './members';
import { dateTime, time, errorText } from './ui';

// Kinds the backend may add later (G0 §8) are listed ahead of time; anything else still shows, under a plain heading.
const KINDS: Record<string, { label: string; icon: ReactNode }> = {
  question: { label: '等你回答', icon: <MessageCircleQuestion size={14} /> },
  approval: { label: '等你确认操作', icon: <ShieldCheck size={14} /> },
  unknown: { label: '结果待核对', icon: <CircleHelp size={14} /> },
  login: { label: '需要登录', icon: <KeyRound size={14} /> },
  'merge-conflict': { label: '应用有冲突', icon: <GitMerge size={14} /> },
  acceptance: { label: '待验收', icon: <CheckCheck size={14} /> },
  'round-acceptance': { label: '轮次成品待验收', icon: <ListChecks size={14} /> },
  decision: { label: '等你决定', icon: <Split size={14} /> },
};
const kindOf = (kind: string) => KINDS[kind] ?? { label: '其他事项', icon: <Inbox size={14} /> };
/** Known kinds in their order first, then any kind this build does not know yet. */
const kindsIn = (summary: AttentionSummary) => [...new Set<string>([...ATTENTION_KINDS, ...summary.items.map(item => item.kind)])].filter(kind => summary.items.some(item => item.kind === kind));

const today = (at: string) => new Date(at).toDateString() === new Date().toDateString();

/** One line in the sidebar summarising what waits on the user. */
export function attentionLine(summary?: AttentionSummary) {
  if (!summary?.total) return '暂时没有需要你处理的事';
  return kindsIn(summary).map(kind => `${summary.items.filter(item => item.kind === kind).length} 项${kindOf(kind).label}`).join(' · ');
}

/** The fixed entry: everything that waits on the user, each with the one place to go next. Opening an item only navigates. */
export function AttentionEntry({ summary, onOpen, onIgnore }: { summary?: AttentionSummary; onOpen: (item: AttentionItem) => void; onIgnore?:(item:AttentionItem)=>Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [ignoring,setIgnoring]=useState(''),[error,setError]=useState('');
  const button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const total = summary?.total ?? 0;
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { const target = event.target as Node; if (!panel.current?.contains(target) && !button.current?.contains(target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [open]);
  // Open level with the entry; move up only as far as the panel's real height needs.
  useLayoutEffect(() => {
    if (!open) return;
    const rect = button.current?.getBoundingClientRect(), height = panel.current?.offsetHeight ?? 0;
    if (rect) setTop(Math.max(12, Math.min(rect.top, window.innerHeight - height - 12)));
  }, [open, total]);
  function toggle() { setOpen(value => !value); }
  async function ignore(item:AttentionItem){if(!onIgnore||ignoring)return;setIgnoring(item.id);setError('');try{await onIgnore(item);}catch(e){setError(errorText(e));}finally{setIgnoring('');}}
  return <>
    <button type="button" ref={button} className={`attention-entry ${total ? 'has-items' : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={toggle}>
      <Inbox size={16} /><span><strong>待你处理</strong><small>{attentionLine(summary)}</small></span>
      {total > 0 && <span className="attention-count" aria-label={`${total} 项待处理`}>{total}</span>}
    </button>
    {open && <div ref={panel} className="attention-panel" role="dialog" aria-label="待你处理" style={{ top, maxHeight: `min(560px, calc(100vh - ${top + 12}px))` }}>
      <div className="attention-panel-head"><strong>待你处理</strong><small>{total ? `共 ${total} 项，点一项就去对应的地方` : ''}</small>
        <button type="button" className="icon-button" aria-label="关闭待处理" title="关闭待处理" onClick={() => setOpen(false)}><X size={15} /></button></div>
      {total ? <div className="attention-groups">{kindsIn(summary!).map(kind => <section key={kind} className={`attention-group kind-${kind}`} aria-label={kindOf(kind).label}>
        <h4>{kindOf(kind).icon}{kindOf(kind).label}<span>{summary!.items.filter(item => item.kind === kind).length}</span></h4>
        {summary!.items.filter(item => item.kind === kind).map(item => <AttentionRow key={item.id} item={item} ignoring={Boolean(ignoring)} onIgnore={onIgnore&&item.fingerprint?()=>void ignore(item):undefined} onOpen={() => { setOpen(false); onOpen(item); }} />)}
      </section>)}</div>
        : <p className="attention-empty">问题、审批、登录、待核对和待验收都会出现在这里。现在没有要你处理的事。</p>}
      {error&&<p role="alert" className="inline-notice error">{error}</p>}
    </div>}
  </>;
}

function AttentionRow({ item, onOpen, onIgnore, ignoring }: { item: AttentionItem; onOpen: () => void; onIgnore?:()=>void; ignoring:boolean }) {
  const team = useTeam(), member = item.memberId ? team.get(item.memberId) : undefined;
  return <div className={`attention-item member-${member?.id ?? 'none'}`}>
    {member ? <Avatar member={member} size={28} ring={false} /> : <span className="attention-item-icon">{kindOf(item.kind).icon}</span>}
    <span className="attention-item-text"><strong>{item.title}</strong>{item.detail && <small>{item.detail}</small>}</span>
    <span className="attention-item-side"><time dateTime={item.at} title={dateTime(item.at)}>{today(item.at) ? time(item.at) : dateTime(item.at)}</time>
      <button type="button" className="button small secondary" onClick={onOpen}>{item.action.label}</button>
      {onIgnore&&<button type="button" className="button small quiet" disabled={ignoring} title="仅隐藏这条提醒，原记录和任务状态保留" onClick={onIgnore}>忽略</button>}</span>
  </div>;
}
