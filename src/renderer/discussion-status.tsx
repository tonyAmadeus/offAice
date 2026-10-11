import { Check, Hand, Users, X } from 'lucide-react';
import type { RoomDiscussion } from '../shared/discussion';
import { DISCUSSION_LABELS, pendingDiscussionQuestion } from '../shared/discussion';
import type { RoomState } from '../shared/types';
import { Avatar, useTeam, type TeamMember } from './members';
import { useTicker } from './ui';
import {callUsageLabel} from '../shared/call-usage';

const LIVE = ['talking', 'raising', 'closing', 'summarizing'];
const BALLOT: Record<string, string> = { pending: '正在举手', invalid: '举手格式无效', stopped: '已撤回', failed: '举手需核对' };

function phaseLabel(d: RoomDiscussion) {
  if (d.phase === 'idle') return d.endedBy === 'user' ? '本次讨论已由你结束' : d.style === 'chat' ? '大家先聊到这儿' : DISCUSSION_LABELS.idle;
  if (d.phase === 'talking') return d.style === 'chat' ? '正在闲聊' : '正在开会';
  return DISCUSSION_LABELS[d.phase];
}

/** Who is in the room and how the conversation stands, in one bar: the invite chips double as the speakers' status. */
export function RoomPresence({ discussion: d, state, invited, ready, locked, busy, onToggle, onPause, onResume, onEnd, onConfigure,onHost,showNextStep=true,flowNextStep=false }: {
  discussion?: RoomDiscussion; state: RoomState; invited: string[]; ready: (member: TeamMember) => boolean; locked: boolean; busy: boolean;
  onToggle: (id: string) => void; onPause: () => void; onResume: () => void; onEnd: () => void;
  onConfigure?:(id:string)=>void;
  onHost?:(id:string)=>void;
  showNextStep?:boolean;
  /** A project flow step is already offered; skip the minutes suggestion so only one 下一步 shows. */
  flowNextStep?:boolean;
}) {
  const team = useTeam(), tick = useTicker(state.active, 15000), now = Math.max(tick, Date.now());
  const running = Boolean(d && d.phase !== 'idle');
  const handActive = Boolean(running && d?.handRaise && ['collecting','waiting', 'done'].includes(d.handRound?.status ?? ''));
  const name = (id: string) => team.get(id)?.name ?? '成员';
  const speechBudget=d?.budgetKind==='speech';
  const available = d?.limit ? Math.max(0, d.limit - (speechBudget?d.speechCalls??0:d.calls)) : undefined;
  const roundCost = !speechBudget&&d?.handRaise && d.members.length > 1 ? d.members.length + 1 : 1;
  const details = d ? [
    ...(d.phase !== 'idle' && d.reason ? [d.reason] : []),
    ...(d.phase === 'closing' ? ['正在确认每位成员是否还有遗漏或异议。'] : []),
    ...(handActive && d.handRound?.status === 'done' ? [d.handRound.fallback ? '没有人需要补充，等你说话' : `本轮补充：${name(d.handRound.selected ?? '')}`] : []),
  ] : [];
  const questions = d ? d.questions.filter(question => pendingDiscussionQuestion(question) && question.to === 'user').slice(d.style==='chat'?-3:0) : [];
  const nextStep=!showNextStep?undefined:d?.style!=='chat'&&questions.length?'下一步：在输入框回答上方问题。':d?.phase==='awaiting-host'?'下一步：点名一位已举手的成员继续发言。':d?.style!=='chat'&&d?.phase==='waiting_user'&&!flowNextStep?'下一步：整理会议纪要，核对本轮结论。':undefined;
  const budget = Boolean(d && (available !== undefined || d.minutes > 0));
  const tone = !d ? '' : LIVE.includes(d.phase) ? 'live' : ['blocked', 'budget'].includes(d.phase) ? 'warn' : ['paused', 'waiting_user','awaiting-host'].includes(d.phase) ? 'hold' : 'rest';
  return <section role="region" className={`room-presence ${d ? `phase-${d.phase}` : ''}`} aria-label="在场与讨论状态" aria-live="polite">
    <div className="room-presence-row">
      <span className="room-presence-label"><Users size={13} />在场</span>
      <div className="room-presence-members" role="group" aria-label="邀请谁加入">{team.members.map(member => {
        const on = invited.includes(member.id), ok = ready(member);
        const speaking = state.active && state.speaking === member.id;
        const ballot = handActive && on ? d?.handRound?.ballots[member.id] : undefined;
        const raised = ballot?.status === 'done' && (ballot.want ?? 0) > 0;
        const skipped=on?d?.skippedMembers?.[member.id]:undefined;
        const awaiting=d?.phase==='awaiting-host',pick=(awaiting||d?.phase==='raising'&&d.hostPick&&d.handRound?.status==='collecting')&&raised&&!skipped&&Boolean(onHost);
        const tag = skipped ? '已跳过' : speaking ? '发言中' : ballot?.status === 'done' ? (ballot.want ? `举手 ${ballot.want}/3` : '不补充') : ballot ? BALLOT[ballot.status] : undefined;
        const title = skipped?.reason || ballot?.why || ballot?.error || (!ok ? `${member.product} 还没准备好` : locked ? on ? '正在参与本次讨论' : '讨论进行中，结束后可以邀请' : on ? '点一下请 TA 离开' : '点一下邀请 TA');
        return <span key={member.id} className="guest-chip-group"><button type="button" className={`guest-chip member-${member.id} ${on ? 'on' : ''} ${locked ? 'locked' : ''} ${speaking ? 'speaking' : ''} ${ok ? '' : 'unready'}`}
          aria-pressed={on} aria-label={pick?'请 '+member.name+' 发言':undefined} disabled={pick?!ok||busy:awaiting?true:onConfigure&&on?busy:!ok||locked||busy} title={pick?ballot?.why:onConfigure&&on?'调整 '+member.name+' 的项目配置':title} onClick={() => pick?onHost!(member.id):onConfigure&&on?onConfigure(member.id):onToggle(member.id)}>
          <span className="guest-chip-avatar"><Avatar member={member} size={24} ring={false} mood={speaking ? 'working' : undefined} />{raised && <Hand size={11} className="guest-chip-hand" role="img" aria-label={`${member.name} 已举手`} />}</span>
          <span className="guest-chip-name">{member.name}</span>
          {tag ? <small className="guest-chip-tag">{tag}</small> : on && !locked && <Check size={12} />}
          {pick&&ballot?.why&&<small className="guest-chip-reason">{ballot.why}</small>}
        </button>{onConfigure&&on&&<button type="button" className="guest-chip-leave" aria-label={'请 '+member.name+' 离开'} title={'请 '+member.name+' 离开会议室'} disabled={locked||busy} onClick={()=>onToggle(member.id)}><X size={11}/></button>}</span>;
      })}</div>
      {d && <div className="room-presence-status">
        {d.callUsage&&<small className="room-presence-usage" aria-label="本次讨论调用次数" title={`${callUsageLabel(d.callUsage)}${speechBudget?` · 正式发言 ${d.speechCalls??0} 次 · 辅助调用 ${Math.max(0,d.calls-(d.speechCalls??0))} 次`:''}\n按实际运行记录计数；发言、举手、纪要、补正、重试均计入，未发出失败单列。`}>{`已发出 ${d.callUsage.delivered} 次 · 完成 ${d.callUsage.completed} 次`}{d.callUsage.unknown?<span className="room-presence-unknown"> · 结果未知 {d.callUsage.unknown} 次</span>:null}</small>}
        {budget && <small className="room-presence-usage room-presence-budget">{available !== undefined && <span aria-label="讨论剩余轮次" title={speechBudget?'只限制正式发言；举手、补正、重试和纪要另记。':`按普通接话每轮 ${roundCost} 次调用估算。`}>剩余 {available} 次{speechBudget?'正式发言':'调用'}{!speechBudget&&` · 普通接话约 ${Math.floor(available / roundCost)} 轮`}</span>}{d!.minutes > 0 && <span>{state.active && d!.deadline ? `剩余约 ${Math.max(0, Math.ceil((d!.deadline - now) / 60000))} 分钟` : `时长预算 ${d!.minutes} 分钟`}</span>}</small>}
        <span className={`room-phase ${tone}`} title={d.phase === 'idle' ? d.reason : undefined}>{phaseLabel(d)}</span>
        {!state.active && ['paused', 'blocked', 'budget'].includes(d.phase) && <button type="button" className="button small primary" disabled={busy} onClick={onResume}>{d.unknownRunId || d.unknownRunIds?.length ? '核对后继续' : '继续讨论'}</button>}
        {!state.active && ['waiting_user','idle'].includes(d.phase) && Object.keys(d.skippedMembers??{}).length>0 && <button type="button" className="button small secondary" disabled={busy} onClick={onResume}>{d.unknownRunId||d.unknownRunIds?.length?'核对后重新加入异常成员':'重新加入异常成员'}</button>}
      </div>}
    </div>
    {d && (details.length > 0 || questions.length > 0 || nextStep) && <div className="room-presence-detail">
      {nextStep&&<p className="room-next-step">{nextStep}</p>}
      {details.map(text => <p key={text}>{text}</p>)}
      {d.style==='chat'&&questions.length>0&&<p>这些问题可以稍后回答，大家会继续聊天。</p>}
      {questions.map(question => <p key={question.id} className="room-presence-question"><strong>{name(question.from)} 问你：</strong>{question.text}</p>)}
    </div>}
  </section>;
}
