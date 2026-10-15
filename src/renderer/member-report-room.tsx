import {plainFlowError,readableContent} from '../shared/content-presentation';
import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowLeft,Laptop,PanelRightClose,PanelRightOpen,RefreshCw} from 'lucide-react';
import type {Project,RoomMessage,Snapshot,TimelineEvent} from '../shared/types';
import type {MemberReport} from '../shared/project-workbench';
import type {MemberWork} from '../shared/member-workspaces';
import type {ProjectFlowSnapshot,Task} from '../shared/project-flow';
import type {WorkLogPage} from '../shared/work-log';
import {RoomView} from './room';
import {useTeam} from './members';
import {label} from './project-progress';
import {Markdown} from './Markdown';
import {WorkLog,WorkLogEntryView} from './work-log';
import {ErrorBoundary} from './ErrorBoundary';
import {RoundResults} from './round-results';
import {ApprovalCard,PlanPanel} from './panels';
import {TaskAdditionView} from './task-addition';
import {GiveUp,SupplementReceipts} from './project-room';
import {FlowRunStop} from './flow-run-stop';
import {dateTime,runLabel,type Invoke} from './ui';
import {ReportSwitcher,type ReportEntry} from './report-switcher';

const roleName={author:'作者',reviewer:'复核人',lead:'负责人'};
function ReportCard({report,invoke,onLog,historical=false}:{report:MemberReport;invoke:Invoke;onLog:(id:string)=>void;historical?:boolean}){
  return <article className="member-report" aria-label={report.title+' · '+roleName[report.role]}>
    <header><h2>{report.title}<span className={`member-report-role role-${report.role}`}>{roleName[report.role]}</span></h2><p>{dateTime(report.at)} · 这一轮{label(report.roundStatus)} · 方案{label(report.planStatus)}</p></header>
    <div className="member-report-summary">{report.summary.length?report.summary.map((s,i)=><Markdown key={i} text={readableContent(s)}/>):<p>任务已安排，还没有交成果。</p>}</div>
    {report.tasks.map(t=><div className="member-report-task" key={t.id}><p><strong>{t.title}</strong><span className="result-tag">{label(t.status)}</span></p>{t.files.length>0&&<p className="round-files">{t.files.map(f=><span key={f} className="round-file">{f}</span>)}</p>}<button type="button" className="link-button" onClick={()=>onLog(t.id)}>查看这项任务的工作日志</button></div>)}

    {!!report.remaining.length&&<section><h3>还没解决的</h3><ul>{report.remaining.map(s=><li key={s}>{s}</li>)}</ul></section>}
    {!!report.next.length&&<section><h3>接下来</h3><ul>{report.next.map(s=><li key={s}>{s}</li>)}</ul></section>}
    {report.acceptances.map(a=><p key={a.id} className="task-meta">验收：{a.actor==='user'?'你':'负责人'}{label(a.status)}{a.opinion?' · '+a.opinion:''}</p>)}
    {!historical&&report.integrationId&&<RoundResults projectId={report.projectId} roundId={report.roundId} integrationId={report.integrationId} paths={report.role==='author'?report.tasks.flatMap(t=>t.files):undefined} scopeLabel={report.role==='author'?'参与任务的整合版本':report.role==='reviewer'?'检查过的本轮成果':'本轮整合成果'} invoke={invoke}/>}
  </article>;
}

function ReportMessage({message,invoke,onLog}:{message:RoomMessage;invoke:Invoke;onLog:(id:string)=>void}){
  const [expanded,setExpanded]=useState(false),versions=message.memberReportVersions??[];
  return <div className="member-report-group"><ReportCard report={message.memberReport!} invoke={invoke} onLog={onLog}/>{versions.length>0&&<details onToggle={event=>setExpanded(event.currentTarget.open)}><summary>查看此前 {versions.length} 次更新</summary>{expanded&&versions.map(version=><section key={version.messageId}><small>{dateTime(version.at)}</small><ReportCard report={version.report} invoke={invoke} onLog={onLog} historical/></section>)}</details>}</div>;
}

/** Same M2 data and entry component as task logs, scoped to this member's project-flow runs. */
function MemberActivity({projectId,memberId,invoke}:{projectId:string;memberId:string;invoke:Invoke}){
  const [page,setPage]=useState<WorkLogPage>(),[entries,setEntries]=useState<WorkLogPage['entries']>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),ticket=useRef(0);
  async function load(more=false){const id=++ticket.current;setBusy(true);try{const result=await invoke<WorkLogPage>('projectFlow.log',{projectId,target:{kind:'member',id:memberId},...(more?{cursor:page?.cursor}:{})});if(id===ticket.current){setPage(result);setEntries(old=>more?[...old,...result.entries]:result.entries);setError('');}}catch(e){if(id===ticket.current)setError((e as Error).message);}finally{if(id===ticket.current)setBusy(false);}}
  useEffect(()=>{void load();return()=>{ticket.current++;};},[projectId,memberId]);
  return <section aria-label="成员项目工作日志"><div className="panel-section-title">工作记录<button className="icon-button" aria-label="刷新成员工作日志" title="刷新成员工作日志" disabled={busy} onClick={()=>void load()}><RefreshCw size={14}/></button></div><p className="panel-muted">与任务工作日志共用已保存的记录。</p>{entries.length?<ol className="work-log-list">{entries.map(e=><WorkLogEntryView key={e.id} entry={e}/>)}</ol>:<p className="panel-muted">还没有记录。</p>}{page?.hasMore&&<button className="button small" disabled={busy} onClick={()=>void load(true)}>读取更多日志</button>}{error&&<p role="alert">{error}</p>}</section>;
}

export function MemberReports({project,memberId,snapshot,invoke,onMeeting,onDesk,reports=[],onOpenReport}:{project:Project;memberId:string;snapshot:Snapshot;invoke:Invoke;onMeeting:()=>void;onDesk?:()=>void;reports?:ReportEntry[];onOpenReport?:(memberId:string)=>void}){
  const team=useTeam(),member=team.get(memberId),roomId=`report:${project.id}:${memberId}` as const;
  const [work,setWork]=useState<MemberWork>(),[data,setData]=useState<ProjectFlowSnapshot>(),[error,setError]=useState(''),[log,setLog]=useState<string|null>(null),[open,setOpen]=useState(true),[tab,setTab]=useState<'plan'|'activity'|'files'>('plan'),[selectedRun,setSelectedRun]=useState(''),[events,setEvents]=useState<TimelineEvent[]>([]),[addition,setAddition]=useState<{goal:string;task?:Task;sourceMessageId?:string}|null>(null),[busy,setBusy]=useState(false);
  const ticket=useRef(0),stamp=JSON.stringify([snapshot.projectFlows?.filter(f=>f.projectId===project.id),snapshot.runs.filter(r=>r.projectId===project.id).map(r=>[r.id,r.status,r.updatedAt]),snapshot.approvals.map(a=>[a.id,a.state])]);
  const load=useCallback(async()=>{const id=++ticket.current;try{const [work,data]=await Promise.all([invoke<MemberWork>('report.work',{projectId:project.id,memberId}),invoke<ProjectFlowSnapshot>('projectFlow.get',{projectId:project.id})]);if(id===ticket.current){setWork(work);setData(data);setError('');}}catch(e){if(id===ticket.current)setError((e as Error).message);}},[project.id,memberId,invoke]);
  useEffect(()=>{void load();return()=>{ticket.current++;};},[load,stamp]);
  const runs=[...work?.runs??[]].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),run=runs.find(r=>r.id===selectedRun)??runs.find(r=>['queued','running','waiting_user','stopping'].includes(r.status))??runs[0],session=work?.sessions.find(s=>s.id===run?.sessionId);
  useEffect(()=>{let alive=true;if(session)void invoke<TimelineEvent[]>('session.events',{sessionId:session.id}).then(result=>{if(alive)setEvents(result);}).catch(()=>{});else setEvents([]);return()=>{alive=false;};},[session?.id,run?.status,invoke]);
  const processEvents=[...new Map([...events,...snapshot.events].filter(e=>e.runId===run?.id).map(e=>[e.id,e])).values()];
  const currentTasks=data?.tasks.filter(t=>t.memberId===memberId&&t.planId===data.flow?.activePlanId&&t.status!=='cancelled')??[];
  const supplementTask=currentTasks.find(t=>t.allowedActions?.some(a=>a.name==='projectFlow.task.supplement'&&a.enabled));
  const canAdd=Boolean(member&&data?.flow?.status==='active'&&data.flow.activePlanId&&data.flow.memberIds.includes(memberId));
  const messageActions=(message:RoomMessage,messages:RoomMessage[])=>{
    if(message.author!=='user'&&!message.replyTo||message.memberReport||message.status==='speaking')return null;
    const source=message.author==='user'?message:messages.find(m=>m.id===message.replyTo&&m.author==='user');
    if(!source)return null;
    const sourceMessageId=source.id,goal=source.text;
    return <div className="member-report-actions"><button className="button small quiet" disabled={!canAdd} onClick={()=>setAddition({goal,sourceMessageId})}>转成追加任务</button><button className="button small quiet" disabled={!supplementTask} onClick={()=>setAddition({goal,task:supplementTask,sourceMessageId})}>补充到当前任务</button></div>;
  };
  const blocked=work?.operations.filter(op=>op.state==='blocked'&&op.flowId===data?.flow?.id)??[];
  async function resolve(op:MemberWork['operations'][number],choice:'continue'|'abandon',evidence:string){setBusy(true);try{await invoke('projectFlow.unknown.resolve',{requestId:crypto.randomUUID(),operationId:op.id,expectedRevision:op.revision,choice,evidence});await load();return true;}catch{return false;}finally{setBusy(false);}}
  const ownPending=snapshot.approvals.filter(a=>a.state==='pending'&&(work?.runs.some(r=>r.id===a.runId)||snapshot.sessions.find(s=>s.id===a.sessionId)?.roomId===roomId));
  return <main className={`member-reports report-chat-workspace ${open?'with-panel':''}`} aria-label="个人汇报">
    <RoomView snapshot={snapshot} invoke={invoke} roomId={roomId} personal={{kind:'report',memberId,title:`${member?.name??work?.reports[0]?.memberName??memberId} 的汇报`,hint:`${project.name} · 最新进度在底部，发问默认只读回答`,subbar:onOpenReport&&reports.length>1?<ReportSwitcher entries={reports} current={memberId} onOpen={onOpenReport}/>:undefined,headerActions:<><button type="button" className="button small secondary" onClick={onMeeting}><ArrowLeft size={13}/>返回项目会议室</button>{onDesk&&<button type="button" className="icon-button" aria-label="打开工位" title={`打开 ${member?.name??''} 的工位`} onClick={onDesk}><Laptop size={16}/></button>}<button className="icon-button" aria-label={open?'收起汇报工作面板':'展开汇报工作面板'} title={open?'收起汇报工作面板':'展开汇报工作面板'} onClick={()=>setOpen(!open)}>{open?<PanelRightClose size={16}/>:<PanelRightOpen size={16}/>}</button></>,renderMessage:m=>m.memberReport?<ReportMessage message={m} invoke={invoke} onLog={setLog}/>:undefined,messageActions,dock:ownPending.length?<div className="personal-approvals" aria-label="本项目成员审批">{ownPending.map(a=><ErrorBoundary key={a.id} compact area="项目审批" resetKey={a.state}><ApprovalCard approval={a} invoke={invoke} member={member}/></ErrorBoundary>)}</div>:undefined,empty:<div className="room-empty"><h2>还没有已保存的工作汇报</h2><p>完成任务或检查后会出现在这里，也可以先问问当前安排。</p></div>}}/>
    {open&&<aside className="report-work-panel" aria-label="成员项目工作面板">{currentTasks.map(task=><SupplementReceipts key={task.id} task={task}/>)}<div className="report-controls"><label>本项目的运行<select aria-label="查看成员项目运行" value={run?.id??''} onChange={e=>setSelectedRun(e.target.value)}>{!runs.length&&<option value="">还没有运行</option>}{runs.map(r=><option key={r.id} value={r.id}>{dateTime(r.createdAt)} · {runLabel(r)}</option>)}</select></label>{run&&<FlowRunStop run={run} invoke={invoke}/>}<div className="round-actions"><button type="button" className="button small secondary" disabled={!supplementTask} onClick={()=>setAddition({goal:'',task:supplementTask})}>补充要求</button><button type="button" className="button small secondary" disabled={!canAdd} onClick={()=>setAddition({goal:''})}>改变方向</button></div><small>改变目标或范围后，需要确认追加提案或范围决策。</small>{blocked.map(op=><section key={op.id}><p className="task-meta bad">卡住的尝试：{plainFlowError(op.error)}</p><GiveUp task={op.kind==='task'} unknown={snapshot.runs.some(r=>r.id===(op.correctionRunId??op.runId)&&(r.status==='unknown'||r.delivery==='unknown'))} supplement={op.kind==='supplement-delivery'} busy={busy} onConfirm={evidence=>resolve(op,'abandon',evidence)} onContinue={op.kind!=='supplement-delivery'?evidence=>resolve(op,'continue',evidence):undefined}/></section>)}</div>
      <div className="side-tabs" role="tablist" aria-label="汇报工作面板">{([['plan','过程'],['activity','活动'],['files','产出']] as const).map(([id,title])=><button role="tab" aria-selected={tab===id} key={id} onClick={()=>setTab(id)}>{title}</button>)}</div>
      <div className="report-panel-body"><ErrorBoundary area="工作记录" resetKey={tab}>{tab==='plan'?<PlanPanel projectWork events={processEvents} session={session} provider={snapshot.providers.find(p=>p.id===session?.provider)} claudeFileScope={snapshot.settings.permissions.claude.fileScope} collaborations={[]} onCollaboration={onMeeting} perform={(method,p)=>{void invoke(method,p).catch(()=>{});}}/>:tab==='activity'?<MemberActivity projectId={project.id} memberId={memberId} invoke={invoke}/>:<section aria-label="成员项目成果">{work?.reports.filter(r=>r.integrationId).map(r=><div key={r.id}><p className="panel-section-title">{r.title} · {roleName[r.role]}</p><RoundResults projectId={project.id} roundId={r.roundId} integrationId={r.integrationId!} invoke={invoke} paths={r.role==='author'?r.tasks.flatMap(t=>t.files):undefined} scopeLabel={r.role==='author'?'参与任务的整合版本':r.role==='reviewer'?'检查过的本轮成果':'本轮整合成果'} defaultOpen/></div>)}{!work?.reports.some(r=>r.integrationId)&&<p className="panel-muted">任务文件和日志保留在汇报中，整合完成后可查看本轮版本。</p>}</section>}</ErrorBoundary></div>
    </aside>}
    {error&&<p className="round-results-error" role="alert">{error}</p>}
    {log&&<WorkLog project={project} target={{kind:'task',id:log}} invoke={invoke} onClose={()=>setLog(null)}/>}
    {addition&&data&&<TaskAdditionView data={data} memberId={memberId} initialGoal={addition.goal} supplementTask={addition.task} sourceMessageId={addition.sourceMessageId} invoke={invoke} onClose={()=>setAddition(null)} onDone={()=>void load()}/>}
  </main>;
}
