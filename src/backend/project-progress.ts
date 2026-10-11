import {randomUUID} from 'node:crypto';
import type {Store} from './store';
import type {Project} from '../shared/types';
import {descendantIds,projectRows} from '../shared/project-tree';
import {FlowError,type ProjectFlow,type Plan,type Round,type Task,type Integration,type Acceptance,type FlowRecord} from '../shared/project-flow';
import type {FlowTimelineItem,FlowTimelinePage,FlowProgressDetail,ProgressSection,ProjectProgressCounts,UserChangeHistory} from '../shared/project-progress';
const sections={plans:'flow_plans',rounds:'flow_rounds',tasks:'flow_tasks',results:'flow_integrations',acceptances:'flow_acceptances'} as const;
interface Cursor {v:1;scope:string;ids:string[];offset:number;capturedAt:string}
const encode=(value:Cursor)=>Buffer.from(JSON.stringify(value)).toString('base64url');
/** Fixed record-set paging avoids skipping work with equal timestamps or when a new flow is created. */
export class ProjectProgress {
  constructor(private store:Store){}
  private project(p:Record<string,unknown>){const project=this.store.get<Project>('projects',String(p.projectId));if(!project||project.kind)throw new FlowError('NOT_FOUND','工作项目不存在。');if(p.includeChildren!==undefined&&typeof p.includeChildren!=='boolean')throw new FlowError('INVALID_SCOPE','是否包含子项目必须明确。');return project;}
  private page<T extends {id:string}>(p:Record<string,unknown>,records:T[],scope:string){
    let cursor:Cursor={v:1,scope,ids:records.map(r=>r.id),offset:0,capturedAt:new Date().toISOString()};
    if(p.cursor)try{
      const c=JSON.parse(Buffer.from(String(p.cursor),'base64url').toString()) as Cursor,known=new Set(records.map(r=>r.id));
      if(c.v!==1||c.scope!==scope||!Array.isArray(c.ids)||c.ids.length>100000||c.ids.some(id=>typeof id!=='string'||!known.has(id))||new Set(c.ids).size!==c.ids.length||!Number.isInteger(c.offset)||c.offset<0||c.offset>c.ids.length||typeof c.capturedAt!=='string')throw Error();cursor=c;
    }catch{throw new FlowError('INVALID_CURSOR','分页记录不属于当前项目或当前记录类别，请重新读取。');}
    const limit=p.limit===undefined?10:Number(p.limit);if(!Number.isInteger(limit)||limit<1||limit>100)throw new FlowError('INVALID_REQUEST','每页数量须为 1 至 100。');
    const byId=new Map(records.map(r=>[r.id,r])),ids=cursor.ids.slice(cursor.offset,cursor.offset+limit),next={...cursor,offset:cursor.offset+ids.length},hasMore=next.offset<cursor.ids.length;
    return {items:ids.map(id=>byId.get(id)!),total:cursor.ids.length,hasMore,cursor:hasMore?encode(next):undefined,capturedAt:cursor.capturedAt,selected:cursor.ids};
  }
  timeline(p:Record<string,unknown>,stage?:{flowId:string;label:string}|{flowId:string;label:string}[]):FlowTimelinePage {
    const project=this.project(p),projects=this.store.list<Project>('projects'),projectIds=p.includeChildren===true?descendantIds(projects,project.id):[project.id],ids=new Set(projectIds),paths=new Map(projectRows(projects).map(r=>[r.project.id,r.path])),flows=this.store.list<ProjectFlow>('project_flows').filter(f=>ids.has(f.projectId)),owned=new Map(flows.map(f=>[f.id,f.projectId])),stages=new Map((Array.isArray(stage)?stage:stage?[stage]:[]).map(s=>[s.flowId,s.label]));
    const list=<T extends FlowRecord>(entity:string)=>this.store.list<T>(entity).filter(r=>owned.get(r.flowId)===r.projectId);
    const plans=list<Plan>('flow_plans'),rounds=list<Round>('flow_rounds'),tasks=list<Task>('flow_tasks'),results=list<Integration>('flow_integrations'),accepts=list<Acceptance>('flow_acceptances'),members=this.store.members();
    const items:FlowTimelineItem[]=flows.map(flow=>{
      const plan=plans.find(p=>p.id===flow.activePlanId),adopted=plans.filter(p=>p.flowId===flow.id&&(p.confirmedAt||p.status==='confirmed')).sort((a,b)=>b.version-a.version)[0],currentRounds=rounds.filter(r=>r.flowId===flow.id&&r.planId===adopted?.id),currentTasks=tasks.filter(t=>t.flowId===flow.id&&t.planId===adopted?.id),last=currentRounds.filter(r=>r.report).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||b.id.localeCompare(a.id))[0];
      const planSummary=plan?{id:plan.id,projectId:plan.projectId,flowId:plan.flowId,revision:plan.revision,version:plan.version,parentPlanId:plan.parentPlanId,status:plan.status,objective:plan.objective,scope:plan.scope,deliverables:plan.deliverables,createdAt:plan.createdAt,updatedAt:plan.updatedAt,roundCount:plan.rounds.length,taskCount:plan.tasks.length}:undefined;
      return {id:flow.id,projectId:flow.projectId,projectName:projects.find(p=>p.id===flow.projectId)?.name,projectPath:paths.get(flow.projectId),objective:plan?.objective??flow.topic??'未命名工作',status:flow.status,dispatchMode:flow.dispatchMode,createdAt:flow.createdAt,updatedAt:flow.updatedAt,leadMemberId:flow.leadMemberId,leadName:members.find(m=>m.id===flow.leadMemberId)?.name??flow.memberNames?.[flow.leadMemberId]??flow.leadMemberId,stage:flow.status==='completed'?'已完成':flow.status==='cancelled'?'已取消':stages.has(flow.id)?stages.get(flow.id)!:flow.status==='planning'?'正在起草方案':flow.status==='awaiting_plan'?'待你确认方案':flow.dispatchMode!=='running'?'已暂停':currentRounds.find(r=>r.id===flow.currentRoundId)?.status??'执行中',
        plan:planSummary,adoptedPlanId:adopted?.id,adoptedPlanVersion:adopted?.version,planCount:plans.filter(p=>p.flowId===flow.id).length,rounds:{total:currentRounds.length,accepted:currentRounds.filter(r=>r.status==='accepted').length},tasks:{total:currentTasks.length,accepted:currentTasks.filter(t=>t.status==='accepted').length,cancelled:currentTasks.filter(t=>t.status==='cancelled').length},
        resultCount:results.filter(r=>r.flowId===flow.id&&r.version).length,resultVersions:results.filter(r=>r.flowId===flow.id&&r.version).map(r=>({integrationId:r.id,roundId:r.roundId,sequence:r.sequence,status:r.status,version:r.version!})),lastAcceptedAt:accepts.filter(a=>a.flowId===flow.id&&a.status==='accepted').map(a=>a.acceptedAt??'').sort().at(-1)||undefined,reportSummary:last?.report?.summary};
    }).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
    const page=this.page(p,items,JSON.stringify(['timeline',project.id,p.includeChildren===true,[...projectIds].sort()])),chosen=new Set(page.selected),chosenFlows=flows.filter(f=>chosen.has(f.id)),chosenPlanIds=new Set(chosenFlows.flatMap(f=>{const adopted=plans.filter(p=>p.flowId===f.id&&(p.confirmedAt||p.status==='confirmed')).sort((a,b)=>b.version-a.version)[0];return adopted?[adopted.id]:[];})),activeRounds=rounds.filter(r=>chosen.has(r.flowId)&&chosenPlanIds.has(r.planId)),activeTasks=tasks.filter(t=>chosen.has(t.flowId)&&chosenPlanIds.has(t.planId));
    const counts:ProjectProgressCounts={flows:{total:chosenFlows.length,active:chosenFlows.filter(f=>!['completed','cancelled'].includes(f.status)).length,completed:chosenFlows.filter(f=>f.status==='completed').length,cancelled:chosenFlows.filter(f=>f.status==='cancelled').length},
      allSaved:{plans:plans.filter(r=>chosen.has(r.flowId)).length,rounds:rounds.filter(r=>chosen.has(r.flowId)).length,tasks:tasks.filter(r=>chosen.has(r.flowId)).length,results:results.filter(r=>chosen.has(r.flowId)&&r.version).length,acceptances:accepts.filter(r=>chosen.has(r.flowId)).length+rounds.filter(r=>chosen.has(r.flowId)).reduce((n,r)=>n+(r.userChangeRequests?.length??0),0)},
      latestPlans:{rounds:activeRounds.length,acceptedRounds:activeRounds.filter(r=>r.status==='accepted').length,tasks:activeTasks.length,acceptedTasks:activeTasks.filter(t=>t.status==='accepted').length,cancelledTasks:activeTasks.filter(t=>t.status==='cancelled').length}};
    return {projectId:project.id,projectIds,includeChildren:p.includeChildren===true,scope:(p.includeChildren===true?'所选项目及全部子项目':'所选项目')+'的全部保存工作，包含进行中、已完成和已取消的流程',countScope:'轮次与任务完成数按各段工作最后确认的方案统计；历史总数包含被替代方案。计数覆盖本次分页固定的全部流程，状态随保存事实更新。',counts,items:page.items,total:page.total,hasMore:page.hasMore,cursor:page.cursor,capturedAt:page.capturedAt};
  }
  detail(p:Record<string,unknown>):FlowProgressDetail {
    const project=this.project(p),flow=this.store.get<ProjectFlow>('project_flows',String(p.flowId));if(!flow||flow.projectId!==project.id)throw new FlowError('NOT_FOUND','工作不属于当前项目。');
    const section=String(p.section) as ProgressSection;if(!Object.hasOwn(sections,section))throw new FlowError('INVALID_REQUEST','记录类别不正确。');
    const records:FlowRecord[]=this.store.list<FlowRecord>(sections[section]).filter(r=>r.projectId===project.id&&r.flowId===flow.id&&(section!=='results'||!!(r as Integration).version));
    if(section==='acceptances')for(const round of this.store.list<Round>('flow_rounds').filter(r=>r.projectId===project.id&&r.flowId===flow.id))for(const change of round.userChangeRequests??[]){
      const value:UserChangeHistory={id:['user-change',round.id,change.id].join(':'),projectId:project.id,flowId:flow.id,schemaVersion:1,revision:1,createdAt:change.at,updatedAt:change.at,recordedVia:'user-change',roundId:round.id,integrationId:change.integrationId,actor:'user',opinion:change.opinion,status:'changes_requested',appliedPaths:[],conflictPaths:[]};
      records.push(value);
    }
    records.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
    const page=this.page(p,records,JSON.stringify(['detail',project.id,flow.id,section]));
    return {projectId:project.id,flowId:flow.id,section,scope:'本段工作的全部保存方案版本与记录，包含已被替代、驳回及取消的记录',total:page.total,hasMore:page.hasMore,cursor:page.cursor,items:page.items as FlowProgressDetail['items']};
  }
}
