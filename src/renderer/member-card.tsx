import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Laptop, Settings2, X } from 'lucide-react';
import type { Session, Snapshot } from '../shared/types';
import { ROUTINE_PERIODS, relationLines, routinePeriod } from '../shared/life';
import { memoryEntries } from '../shared/memory';
import { MOOD_TEXT, Portrait, useTeam, type Mood } from './members';
import { QuotaMeter } from './quota';
import { providerSummary, runnable, versionText } from './ui';

/** What a member is doing now, as the roster and the card show it. */
export interface MemberStatus { mood: Mood; text: string; session?: Session; inRoom?: boolean }
export interface MemberCardTarget { memberId: string; rect: DOMRect }

const WIDTH = 340, GAP = 10;

/** A teammate's card next to where it was opened: who they are, what they are doing now, and what you can do with them. */
export function MemberCard({ target, snapshot, status, onClose, onDesk, onOpenWork, onConnect }: {
  target: MemberCardTarget; snapshot: Snapshot; status: MemberStatus; onClose: () => void;
  onDesk:()=>void; onOpenWork: () => void; onConnect: () => void;
}) {
  const team = useTeam(), member = team.get(target.memberId), node = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: target.rect.right + GAP, top: target.rect.top });
  const info = member ? snapshot.providers.find(item => item.id === member.executor) : undefined, ready = runnable(info);
  const card = member?.card, period = ROUTINE_PERIODS.find(item => item.id === routinePeriod(new Date().getHours()))!;
  const quirk = useMemo(() => { const list = card?.quirks ?? []; return list.length ? list[Math.floor(Math.random() * list.length)] : undefined; }, [target.memberId]);
  const relations = card ? relationLines(card, snapshot.members) : [];
  const remembered = card ? memoryEntries(card).filter(entry => !entry.off).length : 0;
  // Beside the anchor when there is room, otherwise on its other side; always inside the window.
  useLayoutEffect(() => {
    const height = node.current?.offsetHeight ?? 420, right = target.rect.right + GAP;
    const left = right + WIDTH <= window.innerWidth - 8 ? right : Math.max(8, target.rect.left - GAP - WIDTH);
    setPosition({ left, top: Math.max(8, Math.min(target.rect.top, window.innerHeight - height - 8)) });
  }, [target]);
  useEffect(() => {
    const close = (event: Event) => { if (event instanceof KeyboardEvent ? event.key === 'Escape' : !node.current?.contains(event.target as Node)) onClose(); };
    const timer = window.setTimeout(() => { document.addEventListener('mousedown', close); document.addEventListener('keydown', close); window.addEventListener('resize', onClose); }, 0);
    node.current?.focus();
    return () => { window.clearTimeout(timer); document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); window.removeEventListener('resize', onClose); };
  }, [onClose]);
  if (!member) return null;
  return <div ref={node} className={`teammate-card member-${member.id}`} role="dialog" aria-label={`${member.name} 的人物卡片`} tabIndex={-1} style={{ left: position.left, top: position.top, width: WIDTH }}>
    {/* The banner shows the portrait itself, filling the width; members without one get their initial. */}
    <div className="teammate-card-banner">{member.art ? <img className="teammate-card-art" src={member.art} alt="" draggable={false} /> : <Portrait member={member} className="teammate-card-portrait" />}
      <button type="button" className="icon-button teammate-card-close" aria-label="关闭人物卡片" title="关闭人物卡片" onClick={onClose}><X size={15} /></button>
      <div className="teammate-card-title"><strong>{member.name}</strong><small>{member.product}</small></div>
    </div>
    <div className="teammate-card-body">
      {member.motto && <p className="teammate-card-motto">「{member.motto}」</p>}
      <div className="teammate-card-status">
        <span className={`teammate-card-mood mood-${status.mood}`}>{status.text || MOOD_TEXT[status.mood]}</span>
        {status.session && <button type="button" className="link-button" onClick={onOpenWork}>去看看<ArrowRight size={12} /></button>}
      </div>
      {(card?.routine?.[period.id] || quirk) && <p className="teammate-card-life">{card?.routine?.[period.id] && <span>{period.label}这个时候，一般在{card.routine[period.id]}</span>}{quirk && <span>小动作：{quirk}</span>}</p>}
      <dl className="teammate-card-facts">
        <div><dt>连接</dt><dd>{providerSummary(info)}{info?.version ? ` · ${versionText(info)}` : ''}</dd></div>
        <div><dt>额度</dt><dd><QuotaMeter provider={member.executor} quota={snapshot.quotas?.[member.executor]} /></dd></div>
        {relations.length > 0 && <div><dt>关系</dt><dd>{relations.map(line => <span key={line}>{line.replace(/^- /, '')}</span>)}</dd></div>}
        <div><dt>记忆</dt><dd>{remembered ? `记得关于你的 ${remembered} 件事` : '还没有长期记忆'}</dd></div>
      </dl>
    </div>
    <div className="teammate-card-actions">
      {/* One way in: the desk opens on the most recent topic; new topics are started inside the desk. */}
      {ready ? <button type="button" className="button small primary" disabled={!snapshot.backendReady} onClick={onDesk}><Laptop size={13} />去 {member.name} 的工位聊天</button>
        : <button type="button" className="button small primary" onClick={onConnect}><Settings2 size={13} />去设置连接</button>}
    </div>
  </div>;
}
