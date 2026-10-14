import {useEffect,useRef,useState} from 'react';
import {readableContent} from '../shared/content-presentation';
import type {Project,Snapshot} from '../shared/types';
import {descendantIds} from '../shared/project-tree';
import {criterionText,criterionKind,type Plan,type Round,type Task,type Integration,type Acceptance} from '../shared/project-flow';
import type {FlowTimelinePage,FlowTimelineItem,FlowProgressDetail,ProgressSection,UserChangeHistory} from '../shared/project-progress';
import {RoundResults} from './round-results';
import {WorkLog} from './work-log';
import {ProjectRecordView} from './project-record';
import {ReviewDetails} from './review-details';
import {Markdown} from './Markdown';
import {dateTime,type Invoke} from './ui';
import {Avatar,useTeam} from './members';
import {ChevronDown,ChevronRight,RefreshCw} from 'lucide-react';
const sectionLabels={plans:'方案版本',rounds:'各轮汇报',tasks:'任务记录',results:'成果版本',acceptances:'验收记录'};
const statusLabels:Record<string,string>={planning:'起草中',awaiting_plan:'待确认',active:'进行中',completed:'已完成',cancelled:'已取消',confirmed:'已确认',superseded:'已被替代',rejected:'已驳回',awaiting_confirmation:'待确认',draft:'草稿',pending:'未开始',executing:'执行中',accepted:'已验收',ready:'已准备',changes_requested:'要求修改',stale:'旧版本',awaiting_acceptance:'待验收',integrating:'整合中',checking:'检查中',blocked:'已阻塞',review_passed:'复核通过',review_skipped:'已提交',running:'执行中',awaiting_review:'待复核',queued:'排队中',correcting:'修正中',integrated:'已整合',escalated:'已交给你决定',passed:'检查通过',inconclusive:'无法下结论',assembling:'整合中',conflict:'有冲突',requested:'等待写回',applying:'正在写回',recovery_required:'写回需要处理'};
export const label=(s:string)=>statusLabels[s]??s;
function Who({id}:{id:string}){const member=useTeam().get(id);return <span className="progress-who">{member&&<Avatar member={member} size={16} ring={false}/>}{member?.name??id}</span>;}
export function ProjectProgressView({project,snapshot,invoke}:{project:Project;snapshot:Snapshot;invoke:Invoke}){
  const [page,setPage]=useState<FlowTimelinePage>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),ticket=useRef(0),[expanded,setExpanded]=useState<string>();
  const [includeChildren,setIncludeChildren]=useState(true),childIds=descendantIds(snapshot.projects,project.id),hasChildren=childIds.length>1,scopeIds=includeChildren?childIds:[project.id],scopeKey=JSON.stringify([...scopeIds].sort());
  const stamp=JSON.stringify([snapshot.projectFlows?.filter(f=>scopeIds.includes(f.projectId)),snapshot.runs.filter(r=>scopeIds.includes(r.projectId)&&r.flowOperationId).map(r=>[r.id,r.status,r.updatedAt])]);
  async function load(more=false){const mine=++ticket.current;setBusy(true);try{const next=await invoke<FlowTimelinePage>('projectFlow.timeline',{projectId:project.id,includeChildren:hasChildren&&includeChildren,limit:10,...(more&&page?.cursor?{cursor:page.cursor}:{})});if(mine===ticket.current){setPage(old=>more?{...next,items:[...(old?.items??[]),...next.items]}:next);setError('');}}catch(e){if(mine===ticket.current)setError((e as Error).message);}finally{if(mine===ticket.current)setBusy(false);}}
  useEffect(()=>{setPage(undefined);setExpanded(undefined);void load();return()=>{ticket.current++;};},[project.id,scopeKey,includeChildren]);
  // Once the user is paging history, keep that collection until an explicit refresh.
  useEffect(()=>{if(page&&!page.cursor&&page.items.length<10)void load();},[stamp]);
  const counts=page?.counts;
  return <aside className="project-progress" aria-label="项目进度">
    <header className="progress-head"><h2 title={page?.scope}>项目进度</h2><button type="button" className="icon-button" aria-label="刷新保存记录" title="重新读取保存的记录" disabled={busy} onClick={()=>void load()}><RefreshCw size={14} className={busy?'spin':''}/></button></header>
    {hasChildren&&<label className="progress-children"><input type="checkbox" checked={includeChildren} onChange={e=>setIncludeChildren(e.target.checked)}/>包含全部子项目</label>}
    {error&&<p className="round-results-error" role="alert">{error}</p>}{!page&&<p className="task-meta">正在读取项目历史…</p>}
    {page&&counts&&<section className="progress-counts" aria-label="全项目统计">
      <p className="progress-total">共 {counts.flows.total} 段工作：{counts.flows.active} 段进行中，{counts.flows.completed} 段已完成，{counts.flows.cancelled} 段已取消。</p>
      <dl>
        <dt>当前方案</dt><dd>轮次已验收 {counts.latestPlans.acceptedRounds}/{counts.latestPlans.rounds} · 任务已验收 {counts.latestPlans.acceptedTasks}/{counts.latestPlans.tasks}{counts.latestPlans.cancelledTasks?` · 取消 ${counts.latestPlans.cancelledTasks}`:''}</dd>
        <dt>历史累计</dt><dd>{counts.allSaved.plans} 个方案 · {counts.allSaved.rounds} 轮 · {counts.allSaved.tasks} 条任务 · {counts.allSaved.results} 个成果版本 · {counts.allSaved.acceptances} 条验收与驳回</dd>
      </dl>
      <small>{page.countScope}</small>
    </section>}
    {page?.items.map(flow=>{const open=expanded===flow.id;return <article className={`progress-flow status-${flow.status} ${open?'open':''}`} key={flow.id}>
      <button type="button" className="progress-flow-title" aria-expanded={open} onClick={()=>setExpanded(open?undefined:flow.id)}>{open?<ChevronDown size={14}/>:<ChevronRight size={14}/>}<strong>{flow.objective}</strong><span className="progress-status">{label(flow.status)}</span></button>
      <p className="progress-flow-meta"><Who id={flow.leadMemberId}/> 负责 · {dateTime(flow.createdAt)} 开始{flow.stage&&flow.status==='active'?' · '+flow.stage:''}</p>
      <p className="progress-flow-meta">{flow.adoptedPlanVersion!==undefined?'第 '+flow.adoptedPlanVersion+' 版方案':flow.plan?'第 '+flow.plan.version+' 版待确认，尚未开工':'尚无方案'} · 轮次已验收 {flow.rounds.accepted}/{flow.rounds.total}{flow.planCount>1?` · 共 ${flow.planCount} 个方案`:''}{flow.resultCount?` · ${flow.resultCount} 个成果版本`:''}{flow.lastAcceptedAt?` · 最近验收 ${dateTime(flow.lastAcceptedAt)}`:''}</p>
      {hasChildren&&<p className="progress-flow-meta">{(flow.projectPath??[flow.projectName??project.name]).join(' / ')}</p>}
      {flow.reportSummary&&<p className="progress-flow-summary">{flow.reportSummary}</p>}
      {open&&(()=>{const owner=snapshot.projects.find(p=>p.id===flow.projectId);return owner?<ProgressDetails key={flow.id} project={owner} flow={flow} invoke={invoke}/>:<p role="alert">这个项目的记录当前不可读取，请刷新。</p>;})()}
    </article>;})}
    {page&&!page.items.length&&<p className="task-meta">项目里还没有保存的工作流程。</p>}{page&&<footer className="progress-foot"><small title={'分页集合建立于 '+dateTime(page.capturedAt)}>已显示 {page.items.length} / {page.total} 段工作</small>{page.hasMore&&<button type="button" className="button small secondary" disabled={busy} onClick={()=>void load(true)}>更多工作</button>}</footer>}
  </aside>;
}
function ProgressDetails({project,flow,invoke}:{project:Project;flow:FlowTimelineItem;invoke:Invoke}){
  const [section,setSection]=useState<ProgressSection>('rounds'),[page,setPage]=useState<FlowProgressDetail>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),ticket=useRef(0),[record,setRecord]=useState(false),[log,setLog]=useState<{kind:'task'|'round';id:string}>();
  async function load(more=false){const mine=++ticket.current;setBusy(true);try{const result=await invoke<FlowProgressDetail>('projectFlow.progress.detail',{projectId:project.id,flowId:flow.id,section,limit:10,...(more&&page?.cursor?{cursor:page.cursor}:{})});if(mine===ticket.current){setPage(old=>more?{...result,items:[...(old?.items??[]),...result.items]}:result);setError('');}}catch(e){if(mine===ticket.current)setError((e as Error).message);}finally{if(mine===ticket.current)setBusy(false);}}
  useEffect(()=>{setPage(undefined);void load();return()=>{ticket.current++;};},[project.id,flow.id,section]);
  async function exportRound(id:string){try{const result=await invoke<{title:string;markdown:string}>('projectFlow.round.report.export',{projectId:project.id,roundId:id});await invoke('file.save',{name:result.title+'.md',content:result.markdown});}catch(e){setError((e as Error).message);}}
  return <div className="progress-details">
    <div className="segmented progress-tabs" role="tablist" aria-label="历史记录类别">{(Object.keys(sectionLabels) as ProgressSection[]).map(s=><button type="button" role="tab" key={s} aria-selected={s===section} className={s===section?'selected':''} onClick={()=>{setPage(undefined);setSection(s);}}>{sectionLabels[s]}</button>)}</div>
    <button type="button" className="link-button progress-record-link" onClick={()=>setRecord(true)}>查看本段项目记录</button>
    {error&&<p className="round-results-error" role="alert">{error}</p>}{page&&<p className="progress-scope">{page.scope}</p>}
    {(page?.section===section?page.items:[])?.map(item=><section key={item.id} className="progress-detail-record">
      {section==='plans'?(()=>{const p=item as Plan;return <><h3>第 {p.version} 版方案 · {label(p.status)}{p.id===flow.adoptedPlanId?' · 最后确认':p.id===flow.plan?.id?' · 当前方案':''}</h3><p>{p.objective}</p><p>{p.scope}</p><ul>{p.deliverables.map((s,i)=><li key={i}>{s}</li>)}</ul><h4>验收要求</h4><ul>{p.acceptanceCriteria.map(c=><li key={criterionText(c)}>{criterionText(c)} · {criterionKind(c)==='owner'?'你来定':criterionKind(c)==='judge'?'成员评价':'可核对'}</li>)}</ul><p>{p.rounds.length} 轮，方案声明 {p.tasks.length} 项任务；后续追加项见任务记录。</p></>;})()
      :section==='rounds'?(()=>{const r=item as Round;return <><h3>第 {r.index+1} 轮 · {r.title} · {label(r.status)}{r.planId!==flow.adoptedPlanId?' · 历史方案':''}</h3><p>{r.goal}</p>{r.report?<><Markdown text={readableContent(r.report.summary)}/><p>成果：{r.report.deliverables.join('、')}</p><p>遗留：{r.report.remainingIssues.join('；')||'无记录'}</p><p>下一步：{r.report.nextRoundSummary}</p><button className="link-button" onClick={()=>void exportRound(r.id)}>导出这轮汇报</button></>:<p>尚无保存汇报</p>}<button className="link-button" onClick={()=>setLog({kind:'round',id:r.id})}>查看这轮日志</button>{r.integrationId&&<RoundResults projectId={project.id} roundId={r.id} integrationId={r.integrationId} invoke={invoke}/>}</>;})()
      :section==='tasks'?(()=>{const t=item as Task;return <><h3>{t.title} · {label(t.status)}{t.planId!==flow.adoptedPlanId?' · 历史方案':''}</h3><p>{t.goal}</p><p>作者：<Who id={t.memberId}/>；复核人：{t.reviewerMemberId?<Who id={t.reviewerMemberId}/>:'无'}</p><p>许可范围：{t.allowedPaths.join('、')}</p><ul>{t.completionCriteria.map(c=><li key={criterionText(c)}>{criterionText(c)}</li>)}</ul>{t.confirmedAt&&<p>追加确认：{dateTime(t.confirmedAt)}</p>}<button className="link-button" onClick={()=>setLog({kind:'task',id:t.id})}>查看任务日志</button></>;})()
      :section==='results'?(()=>{const i=item as Integration;return <><h3>成果第 {i.sequence} 次 · {label(i.status)}</h3>{i.reportDraft&&<Markdown text={i.reportDraft.summary}/>}<p>{i.checkSummary}</p><ReviewDetails projectId={project.id} invoke={invoke} artifactId={i.version?.artifactId} assessments={i.assessments} strengths={i.strengths} sources={i.checkEvidence} owner={i.deferredUserCriteria}/><RoundResults projectId={project.id} roundId={i.roundId} integrationId={i.id} invoke={invoke}/></>;})()
      :(()=>{const a=item as Acceptance|UserChangeHistory;return <><h3>{'recordedVia' in a?'用户驳回':'验收'} · {label(a.status)}</h3><p>{a.actor==='user'?'你':'负责人'} · {a.acceptedAt?dateTime(a.acceptedAt):dateTime(a.createdAt)}</p><Markdown text={a.opinion||'无附加意见'}/><p>写回文件：{a.appliedPaths.join('、')||'未写回'}</p>{!!a.conflictPaths.length&&<p>冲突：{a.conflictPaths.join('、')}</p>}<RoundResults projectId={project.id} roundId={a.roundId} integrationId={a.integrationId} invoke={invoke}/></>;})()}
    </section>)}
    {page&&!page.items.length&&<p className="task-meta">暂无这类保存记录。</p>}{page&&<footer className="progress-foot"><small>显示 {page.items.length} / {page.total} 条记录</small>{page.hasMore&&<button type="button" className="button small secondary" disabled={busy} onClick={()=>void load(true)}>更多{sectionLabels[section]}</button>}</footer>}
    {record&&<ProjectRecordView project={project} flowId={flow.id} invoke={invoke} onClose={()=>setRecord(false)}/>}
    {log&&<WorkLog project={project} target={log} invoke={invoke} onClose={()=>setLog(undefined)}/>}
  </div>;
}
