import { useEffect, useState } from 'react';
import { CalendarClock, Clock, Pause, Play, Trash2 } from 'lucide-react';
import type { Snapshot } from '../shared/types';
import { AUTOMATIC_FEATURES, AUTOMATION_TIME_ZONE, dailyLifeOptions, policiesOf, type AutomaticFeature, type TimedJob, type TimedSchedule } from '../shared/automation';
import { Modal } from './modals';
import { useTeam } from './members';
import { errorText, type Invoke, type Notify } from './ui';

const labels={running:'正在执行',done:'已完成',skipped:'已跳过',failed:'失败',unknown:'待核对'};
const time=(at?:string)=>at?new Date(at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'没有后续触发';
const onceDefault=()=>{const date=new Date(Date.now()+120_000);return new Date(date.getTime()-date.getTimezoneOffset()*60_000).toISOString().slice(0,16);};
export function AutomationPanel({snapshot,invoke,notify,onClose}:{snapshot:Snapshot;invoke:Invoke;notify:Notify;onClose:()=>void}){
  const team=useTeam(),state=snapshot.automation;
  const policyKey=JSON.stringify(policiesOf(snapshot.settings.automationPolicies));
  const [policies,setPolicies]=useState(()=>policiesOf(snapshot.settings.automationPolicies));
  useEffect(()=>setPolicies(JSON.parse(policyKey)),[policyKey]);
  const savedInterval=dailyLifeOptions(snapshot.settings.dailyLife).memberChatMinutes;
  const [chatInterval,setChatInterval]=useState(savedInterval);
  useEffect(()=>setChatInterval(savedInterval),[savedInterval]);
  const jobs=state?.jobs.filter(job=>!job.managed)??[],lifeJobs=state?.jobs.filter(job=>job.managed)??[],recent=state?.recent.filter(item=>!item.system&&!item.parentOccurrenceId)??[];
  const [editing,setEditing]=useState<string>(),[name,setName]=useState(''),[text,setText]=useState(''),[action,setAction]=useState<'notice'|'member-message'>('notice'),[memberId,setMemberId]=useState(team.members[0]?.id??'claude');
  const [kind,setKind]=useState<TimedSchedule['kind']>('daily'),[daily,setDaily]=useState('09:00'),[zone,setZone]=useState(AUTOMATION_TIME_ZONE),[once,setOnce]=useState(onceDefault),[minutes,setMinutes]=useState(60),[enabled,setEnabled]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function perform(work:()=>Promise<unknown>,message?:string){if(busy)return;setBusy(true);setError('');try{await work();if(message)notify(message);}catch(error){setError(errorText(error));}finally{setBusy(false);}}
  function edit(job:TimedJob){if(job.managed||job.action.kind!=='notice'&&job.action.kind!=='member-message')return;setEditing(job.id);setName(job.name);setText(job.action.text);setAction(job.action.kind);setEnabled(job.enabled);if(job.action.kind==='member-message')setMemberId(job.action.memberId);setKind(job.schedule.kind);if(job.schedule.kind==='daily'){setDaily(job.schedule.time);setZone(job.schedule.timeZone);}else if(job.schedule.kind==='interval')setMinutes(job.schedule.minutes);else{const date=new Date(job.schedule.at);setOnce(new Date(date.getTime()-date.getTimezoneOffset()*60_000).toISOString().slice(0,16));}}
  function reset(){setEditing(undefined);setName('');setText('');setEnabled(false);setAction('notice');}
  function acknowledge(job?:TimedJob){return !job?.pausedReason||window.confirm('请先核对上次触发和活动记录。确认后只启用未来的触发，不会重发上次任务。');}
  async function save(){
    const previous=state?.jobs.find(job=>job.id===editing);if(enabled&&!acknowledge(previous))return;
    const jobAction=action==='notice'?{kind:action,text,threadId:snapshot.room.currentThreadId}:{kind:action,text,memberId,feature:'scheduled-message' as const,threadId:snapshot.room.currentThreadId??'room-main'};
    await perform(async()=>{const schedule:TimedSchedule=kind==='daily'?{kind,time:daily,timeZone:zone}:kind==='interval'?{kind,minutes}:{kind,at:new Date(once).toISOString()};await invoke('automation.save',{id:editing,name,enabled,schedule,action:jobAction,acknowledgeUnknown:Boolean(previous?.pausedReason&&enabled)});reset();},'定时任务已保存。');
  }
  async function toggle(job:TimedJob){if(!job.enabled||job.pausedReason){if(!acknowledge(job))return;}await perform(()=>invoke('automation.save',{...job,enabled:job.pausedReason?true:!job.enabled,acknowledgeUnknown:Boolean(job.pausedReason)}));}
  return <Modal title="自动功能与定时任务" subtitle="AIROOM 开着时按时间触发；关闭、重启或休眠时错过的不会补发。" onClose={onClose} className="automation-modal">
    <div className="modal-body">
      {!state?<p className="inline-notice">当前后端尚未支持定时任务，请更新应用后使用。</p>:<>
        <div className="automation-toolbar"><span>{state.paused?'定时任务已人工暂停':'定时任务运行中'}</span><button type="button" className="button small secondary" disabled={busy} onClick={()=>void perform(()=>invoke(state.paused?'automation.resume':'automation.pause'))}>{state.paused?<Play size={13}/>:<Pause size={13}/>} {state.paused?'恢复定时任务':'暂停定时任务'}</button></div>
        <section className="automation-budget"><h3>自动发言的每日预算</h3><p className="panel-muted">各类功能独立开启。开启后，只有已启用的任务会使用额度；手动对话和自由讨论沿用原来的预算。</p>
          {(Object.keys(AUTOMATIC_FEATURES) as AutomaticFeature[]).map(id=>{const usage=state.usage?.find(item=>item.feature===id);return <div className="automation-policy" key={id}><label><input type="checkbox" aria-label={`开启${AUTOMATIC_FEATURES[id].label}`} checked={policies[id].enabled} onChange={event=>setPolicies({...policies,[id]:{...policies[id],enabled:event.target.checked}})} />{AUTOMATIC_FEATURES[id].label}</label><label>每日上限<input type="number" min={0} max={1000} aria-label={`${AUTOMATIC_FEATURES[id].label}每日上限`} value={policies[id].dailyLimit} onChange={event=>setPolicies({...policies,[id]:{...policies[id],dailyLimit:Number(event.target.value)}})} />次</label><span>今日 {usage?.used??0} / {usage?.limit??policies[id].dailyLimit} 次</span></div>;})}
          <div className="automation-life"><p>每日开场：北京时间当天第一次打开窗口时，由可用成员轮流问候，最多一次。刚开启时等下一天首次打开；错过或暂停时不补发。</p><p>成员闲聊：窗口可见、聊天室空闲时，两位成员简短接话后结束。每段最多两次调用，都计入上限；作息和小动作只作为角色设定。</p><label className="automation-interval">成员闲聊间隔<input type="number" min={5} max={1440} aria-label="成员闲聊间隔分钟" value={chatInterval} onChange={event=>setChatInterval(Number(event.target.value))}/>分钟</label>
          {lifeJobs.map(job=><div key={job.id}>{job.pausedReason?<p className="inline-notice">{job.name} · {job.pausedReason}<button type="button" className="button small secondary" disabled={busy} onClick={()=>{if(acknowledge(job))void perform(()=>invoke('automation.life.acknowledge',{feature:job.managed,acknowledgeUnknown:true}));}}>核对后恢复{job.name}</button></p>:job.managed==='member-chat'&&job.enabled&&<small>下次检查闲聊：{time(job.nextAt)}</small>}</div>)}
          </div><p className="panel-muted">按北京时间每日零点更新预算。失败或结果未知的调用也计数；明确限流时停止自动调用。手动发言不受这里的每日预算限制。</p><button type="button" className="button small secondary" disabled={busy} onClick={()=>void perform(()=>invoke('automation.policy.save',{policies,dailyLife:{memberChatMinutes:chatInterval}}),'每日预算已保存。')}>保存每日预算</button>
        </section>
        <section className="automation-form"><h3>{editing?'编辑定时任务':'新增定时任务'}</h3><label className="field">任务名称<input aria-label="定时任务名称" value={name} maxLength={120} onChange={event=>setName(event.target.value)} /></label>
          <div className="automation-form-row"><label className="field">动作<select aria-label="定时任务动作" value={action} onChange={event=>setAction(event.target.value as typeof action)}><option value="notice">本地提醒 · 不用成员额度</option><option value="member-message">成员发言 · 使用每日预算</option></select></label>{action==='member-message'&&<label className="field">成员<select aria-label="定时发言成员" value={memberId} onChange={event=>setMemberId(event.target.value)}>{team.members.map(member=><option key={member.id} value={member.id}>{member.name}</option>)}</select></label>}</div>
          <label className="field">内容<textarea aria-label="定时任务内容" rows={2} maxLength={4000} value={text} onChange={event=>setText(event.target.value)} placeholder={action==='notice'?'提醒你要做的事':'请这位成员到时说什么'} /></label>
          <div className="automation-form-row"><label className="field">触发方式<select aria-label="定时触发方式" value={kind} onChange={event=>setKind(event.target.value as typeof kind)}><option value="daily">每天</option><option value="once">一次</option><option value="interval">固定间隔</option></select></label>{kind==='daily'?<label className="field">时间 · {zone}<input type="time" aria-label="每天触发时间" value={daily} onChange={event=>setDaily(event.target.value)} /></label>:kind==='once'?<label className="field">时间 · 本机时区<input type="datetime-local" aria-label="一次性触发时间" value={once} onChange={event=>setOnce(event.target.value)} /></label>:<label className="field">间隔分钟<input type="number" min={1} max={43200} aria-label="定时间隔分钟" value={minutes} onChange={event=>setMinutes(Number(event.target.value))} /></label>}</div>
          <label className="automation-enable"><input type="checkbox" checked={enabled} aria-label="启用此定时任务" onChange={event=>setEnabled(event.target.checked)} />启用此任务</label>
          {action==='member-message'&&!state.policies?.['scheduled-message']?.enabled&&<p className="inline-notice">定时发言的额度开关当前关闭。请先保存每日预算；只启用任务不会调用成员。</p>}
          <div className="automation-form-row"><button type="button" className="button small secondary" disabled={busy||!name.trim()||!text.trim()||kind==='once'&&!once||kind==='daily'&&!daily} onClick={()=>void save()}><CalendarClock size={14}/>{editing?'保存修改':'保存定时任务'}</button>{editing&&<button type="button" className="button small quiet" onClick={reset}>取消编辑</button>}</div>
        </section>
        <section className="automation-jobs"><h3>已保存的任务</h3>{!jobs.length?<p className="panel-muted">还没有定时任务。新任务默认关闭。</p>:jobs.map(job=><article className="automation-job" key={job.id}><div><strong>{job.name}</strong><small>{job.pausedReason?'待核对':job.enabled?'已启用':'未启用'} · 下次 {time(job.nextAt)}</small>{job.pausedReason&&<p className="inline-notice">{job.pausedReason}</p>}</div><div className="automation-job-actions">{job.action.kind!=='local-event'&&<button type="button" className="button small quiet" disabled={busy} onClick={()=>edit(job)}>编辑</button>}<button type="button" className="button small secondary" disabled={busy||!job.nextAt} onClick={()=>void toggle(job)}>{job.pausedReason?'核对后启用':job.enabled?'停用':'启用'}</button><button type="button" className="icon-button danger" aria-label={`删除定时任务 ${job.name}`} title={`删除定时任务 ${job.name}`} disabled={busy} onClick={()=>void perform(()=>invoke('automation.remove',{id:job.id}))}><Trash2 size={14}/></button></div></article>)}</section>
        <section className="automation-history"><h3>最近触发</h3>{recent.length?recent.slice(0,10).map(item=><p key={item.id}><Clock size={12}/><strong>{state.jobs.find(job=>job.id===item.jobId)?.name??'已删除的任务'}</strong><span>{time(item.startedAt)} · {labels[item.status]}{item.reason?` · ${item.reason}`:''}</span></p>):<p className="panel-muted">暂无触发记录。</p>}</section>
      </>}
      {error&&<p className="inline-notice error" role="alert">{error}</p>}
    </div><div className="modal-footer"><button type="button" className="button secondary" onClick={onClose}>关闭</button></div>
  </Modal>;
}
