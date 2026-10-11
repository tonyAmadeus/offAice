import { useState } from 'react';
import type { MemberProfile } from '../shared/types';
import { QUIRK_LIMIT, QUIRKS_MAX, RELATION_LIMIT, ROUTINE_LIMIT, ROUTINE_PERIODS } from '../shared/life';
import { Avatar, useTeam } from './members';

const hours = (from: number, to: number) => `${String(from).padStart(2, '0')}:00–${String(to).padStart(2, '0')}:00`;

/** A member's everyday life on the card: routine by part of day, small habits and relations to teammates. */
export function LifeEditor({ draft, onChange }: { draft: MemberProfile; onChange: (change: Partial<MemberProfile>) => void }) {
  const team = useTeam(), others = team.members.filter(member => member.id !== draft.id);
  const [quirks, setQuirks] = useState(() => (draft.quirks ?? []).join('\n'));
  const relation = (id: string) => draft.relations?.find(item => item.memberId === id)?.text ?? '';
  function setRelation(id: string, text: string) {
    const rest = (draft.relations ?? []).filter(item => item.memberId !== id);
    onChange({ relations: text.trim() ? [...rest, { memberId: id, text }] : rest });
  }
  return <fieldset className="field life-editor">
    <legend>生活设定</legend>
    <span className="life-label">作息</span>
    <div className="life-routine">{ROUTINE_PERIODS.map(period => <label key={period.id} className="life-slot"><span>{period.label}<small>{hours(period.from, period.to)}</small></span>
      <input aria-label={`${period.label}的作息`} maxLength={ROUTINE_LIMIT} value={draft.routine?.[period.id] ?? ''} placeholder={period.example} onChange={event => onChange({ routine: { ...draft.routine, [period.id]: event.target.value } })} /></label>)}</div>
    <label className="life-label">小动作<small>每行一个，最多 {QUIRKS_MAX} 个</small>
      <textarea aria-label="小动作" rows={3} value={quirks} placeholder={'例如：\n转笔\n托腮看窗外'} onChange={event => { setQuirks(event.target.value); onChange({ quirks: event.target.value.split('\n').map(line => line.trim().slice(0, QUIRK_LIMIT)).filter(Boolean).slice(0, QUIRKS_MAX) }); }} /></label>
    {others.length > 0 && <><span className="life-label">和其他成员的关系</span>
      <div className="life-relations">{others.map(member => <label key={member.id} className="life-relation"><Avatar member={member} size={22} ring={false} /><span>{member.name}</span>
        <input aria-label={`和 ${member.name} 的关系`} maxLength={RELATION_LIMIT} value={relation(member.id)} placeholder="例如：搭档，常互相吐槽" onChange={event => setRelation(member.id, event.target.value)} /></label>)}</div></>}
    <small>作息和小动作只用来显示成员此刻的状态，不会当作真实经历发给成员；关系会作为人设的一部分交给成员。</small>
  </fieldset>;
}
