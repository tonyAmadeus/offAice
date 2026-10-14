import {readableContent} from '../shared/content-presentation';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import type {Store} from './store';
import type {Project,MemberProfile,Session} from '../shared/types';
import {FlowError,type ProjectFlow,type Plan,type Round,type Task,type Submission,type Review,type Integration,type Acceptance,type RequestedRoundCheck} from '../shared/project-flow';
import type {MemberReport,MemberReportPage,ProjectRecord,RecordReceipt} from '../shared/project-workbench';
import {redact,resolveSafePath} from './security';
import {withProjectWrite,assertProjectBoundary} from './project-access';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const nameSafe=(s:string)=>s.replace(/[<>:"/\\|?*\x00-\x1f]/g,'-').trim().replace(/[. ]+$/,'').slice(0,70)||'项目记录';

/** Projections over AIROOM facts. Reading reports never creates an executor session. */
export class ProjectWorkbench {
  private writes=new Map<string,Promise<RecordReceipt|undefined>>();
  constructor(private store:Store){}
  private project(id:string){const p=this.store.get<Project>('projects',id);if(!p||p.kind)throw new FlowError('NOT_FOUND','工作项目不存在。');return p;}
  private flow(id:string,projectId?:unknown){const f=this.store.get<ProjectFlow>('project_flows',id);if(!f||projectId!==undefined&&f.projectId!==projectId)throw new FlowError('NOT_FOUND','工作记录不属于这个项目。');this.project(f.projectId);return f;}
  private records<T extends {flowId:string}>(entity:string,flowId:string){return this.store.list<T>(entity).filter(v=>v.flowId===flowId);}
  memberReports(p:Record<string,unknown>,onlyFlowId?:string):MemberReportPage {
    const project=this.project(String(p.projectId)),reports:MemberReport[]=[];
    const members=this.store.members(),names=new Map([...this.store.historicalMembers(),...members].map(m=>[m.id,m.name]));
    for(const flow of this.store.list<ProjectFlow>('project_flows').filter(f=>f.projectId===project.id&&(!onlyFlowId||f.id===onlyFlowId))){
      const plans=this.records<Plan>('flow_plans',flow.id),rounds=this.records<Round>('flow_rounds',flow.id),tasks=this.records<Task>('flow_tasks',flow.id),subs=this.records<Submission>('flow_submissions',flow.id),reviews=this.records<Review>('flow_reviews',flow.id),integrations=this.records<Integration>('flow_integrations',flow.id),accepts=this.records<Acceptance>('flow_acceptances',flow.id),requested=this.records<RequestedRoundCheck>('flow_requested_checks',flow.id);
      for(const round of rounds){
        const plan=plans.find(v=>v.id===round.planId),lead=round.leadMemberId??flow.leadMemberId,roundTasks=tasks.filter(t=>t.roundId===round.id);
        const roles=new Map<string,Set<MemberReport['role']>>();
        const add=(id:string,role:MemberReport['role'])=>{const set=roles.get(id)??new Set();set.add(role);roles.set(id,set);};
        roundTasks.forEach(t=>add(t.memberId,'author'));
        reviews.filter(r=>roundTasks.some(t=>t.id===r.taskId)).forEach(r=>add(r.reviewerMemberId,'reviewer'));
        const integration=integrations.find(i=>i.id===round.integrationId);
        if(round.report)add(lead,'lead');
        if(integration?.peerReview)add(integration.peerReview.memberId,'reviewer');
        requested.filter(c=>c.roundId===round.id&&c.status==='completed').forEach(c=>add(c.memberId,'reviewer'));
        for(const [memberId,roleSet] of roles)for(const role of roleSet){
          const authored=role==='author'?roundTasks.filter(t=>t.memberId===memberId):[],checked=role==='reviewer'?reviews.filter(r=>r.reviewerMemberId===memberId&&roundTasks.some(t=>t.id===r.taskId)):[];
          const authoredSubs=authored.map(t=>subs.find(s=>s.id===t.latestSubmissionId)).filter((s):s is Submission=>!!s);
          const checks:MemberReport['checks']=checked.map(r=>({id:r.id,taskId:r.taskId,status:r.status,findings:r.findings,assessments:r.assessments??[],strengths:r.strengths??[]}));
          if(role==='reviewer'&&integration?.peerReview?.memberId===memberId){const c=integration.peerReview;checks.push({id:integration.id+':peer',status:c.outcome,findings:c.findings,assessments:c.assessments??[],strengths:c.strengths??[]});}
          if(role==='reviewer')requested.filter(c=>c.roundId===round.id&&c.memberId===memberId).forEach(c=>checks.push({id:c.id,status:c.outcome??c.status,findings:c.findings??[],assessments:c.assessments??[],strengths:c.strengths??[]}));
          if(role==='lead'&&integration)checks.push({id:integration.id,status:integration.outcome??integration.status,findings:integration.findings,assessments:integration.assessments??[],strengths:integration.strengths??[]});
          const summary=role==='author'?authoredSubs.map(s=>s.userSummary?.trim()||s.summary):role==='lead'?[round.report!.summary]:checks.flatMap(c=>{const opinions=[...c.findings.map(f=>f.location+'：'+f.request),...c.assessments.map(a=>a.reason),...c.strengths];return opinions.length?opinions:[c.status==='passed'||c.status==='pass'?'没有补充意见。':'尚有待确认事项。'];});
          const at=[round.updatedAt,...authoredSubs.map(s=>s.updatedAt),...checked.map(r=>r.updatedAt)].sort().at(-1)!;
          reports.push({id:[round.id,memberId,role].join(':'),projectId:project.id,flowId:flow.id,planId:round.planId,roundId:round.id,memberId,memberName:names.get(memberId)??flow.memberNames?.[memberId]??memberId,role,title:'第 '+(round.index+1)+' 轮 · '+round.title,at,flowStatus:flow.status,planStatus:plan?.status??'历史方案',roundStatus:round.status,summary,
            tasks:authored.map(t=>{const sub=subs.find(s=>s.id===t.latestSubmissionId);return {id:t.id,title:t.title,status:t.status,sessionId:t.sessionId,submissionId:sub?.id,version:sub?.version,files:sub?.changes.map(c=>c.path)??[]};}),checks,
            remaining:[...new Set([...checks.flatMap(c=>c.findings.filter(f=>f.disposition==='requires-fix'||f.severity==='blocking').map(f=>f.location+'：'+f.request)),...(role==='lead'?round.report?.remainingIssues??[]:[])])],
            next:role==='lead'?[round.report!.nextRoundSummary]:authored.filter(t=>!['accepted','cancelled','integrated','review_passed','review_skipped'].includes(t.status)).map(t=>t.title+'：'+t.status),
            integrationId:round.integrationId,acceptances:accepts.filter(a=>a.roundId===round.id).map(a=>({id:a.id,status:a.status,opinion:a.opinion,actor:a.actor}))});
        }
      }
    }
    reports.sort((a,b)=>b.at.localeCompare(a.at)||b.id.localeCompare(a.id));
    const ids=new Set([...(project.memberIds??[]),...this.store.list<ProjectFlow>('project_flows').filter(f=>f.projectId===project.id).flatMap(f=>f.memberIds),...reports.map(r=>r.memberId)]),roster=[...ids].map(id=>({id,name:names.get(id)??reports.find(r=>r.memberId===id)?.memberName??id,historical:!project.memberIds?.includes(id),count:reports.filter(r=>r.memberId===id).length}));
    const scope=JSON.stringify([project.id,p.memberId??'*',onlyFlowId??'*']),selected=reports.filter(r=>p.memberId===undefined||r.memberId===p.memberId);
    let positions=selected.map(r=>r.id),offset=0;
    if(p.cursor){try{const c=JSON.parse(Buffer.from(String(p.cursor),'base64url').toString());if(c.v!==1||c.scope!==scope||!Array.isArray(c.ids)||!Number.isInteger(c.offset)||c.offset<0)throw Error();positions=c.ids;offset=c.offset;}catch{throw new FlowError('INVALID_CURSOR','汇报分页不属于当前项目或成员。');}}
    const limit=Math.max(1,Math.min(100,Number(p.limit)||20)),pageIds=positions.slice(offset,offset+limit),next=offset+pageIds.length,byId=new Map(selected.map(r=>[r.id,r])),hasMore=next<positions.length;
    return {members:roster,items:pageIds.flatMap(id=>byId.has(id)?[byId.get(id)!]:[]),total:positions.length,hasMore,cursor:hasMore?Buffer.from(JSON.stringify({v:1,scope,ids:positions,offset:next})).toString('base64url'):undefined,scope:'所选项目的全部已保存流程、方案版本和轮次；本次分页固定记录集合'};
  }
  record(p:Record<string,unknown>):ProjectRecord {
    const flow=this.flow(String(p.flowId),p.projectId),stored=this.store.get<ProjectRecord>('flow_project_records',flow.id);
    const record=stored??this.generate(flow);
    return {...record,markdown:stored?this.generate(flow).markdown:record.markdown,receipt:this.store.get<RecordReceipt>('flow_record_receipts',flow.id)};
  }
  roundExport(p:Record<string,unknown>){
    const round=this.store.get<Round>('flow_rounds',String(p.roundId));if(!round||round.projectId!==p.projectId)throw new FlowError('NOT_FOUND','轮次不属于这个项目。');
    const report=round.report;if(!report)throw new FlowError('NOT_FOUND','这个轮次还没有保存汇报。');
    return {title:'第 '+(round.index+1)+' 轮 · '+round.title,markdown:'# '+round.title+'\n\n'+readableContent(report.summary)+'\n\n## 成果\n'+report.deliverables.map(s=>'- '+s).join('\n')+'\n\n## 遗留问题\n'+(report.remainingIssues.map(s=>'- '+s).join('\n')||'无记录')+'\n\n## 下一步\n'+report.nextRoundSummary+'\n\n## 需要你判断\n'+report.userDecisionNeeded};
  }
  private generate(flow:ProjectFlow):ProjectRecord {
    const project=this.project(flow.projectId),plans=this.records<Plan>('flow_plans',flow.id).sort((a,b)=>a.version-b.version),plan=plans.find(p=>p.id===flow.activePlanId)??plans.at(-1),rounds=this.records<Round>('flow_rounds',flow.id),subs=this.records<Submission>('flow_submissions',flow.id),tasks=this.records<Task>('flow_tasks',flow.id);
    const title=project.name+' · '+(plan?.objective??flow.topic??'项目工作');
    const currentRounds=rounds.filter(r=>r.planId===plan?.id).sort((a,b)=>a.index-b.index);
    const latest=new Set(tasks.filter(t=>t.planId===plan?.id&&t.status!=='cancelled').map(t=>t.latestSubmissionId));
    const finalSubs=subs.filter(sub=>latest.has(sub.id));
    const files=[...new Set(finalSubs.flatMap(sub=>sub.changes.filter(c=>c.kind!=='deleted').map(c=>c.path)))];
    const remaining=[...new Set(currentRounds.flatMap(r=>r.report?.remainingIssues??[]))];
    const state=flow.status==='completed'?'已完成':flow.status==='cancelled'?'已取消':'进行中';
    const summary=[plan?.objective??flow.topic??'',state,...currentRounds.filter(round=>round.report).map(round=>round.title+'：'+readableContent(round.report!.summary)),...remaining].join('\n').slice(0,12000);
    const markdown=['# '+title,'状态：'+state,'## 目标',plan?.objective??flow.topic??'无记录',
      ...(plan?['## 方案',plan.scope,'## 成果',...plan.deliverables.map(item=>'- '+item)]:[]),
      ...currentRounds.flatMap(round=>round.report?['## '+round.title,readableContent(round.report.summary),...round.report.deliverables.map(item=>'- '+item)]:[]),
      ...(finalSubs.length?['## 成果说明',...finalSubs.map(sub=>readableContent(sub.userSummary?.trim()||sub.summary))]:[]),
      ...(files.length?['## 成果文件',...files.map(file=>'- '+file)]:[]),
      ...(remaining.length?['## 待处理事项',...remaining.map(item=>'- '+item)]:[]),
      ...(currentRounds.at(-1)?.report?.nextRoundSummary?['## 下一步',currentRounds.at(-1)!.report!.nextRoundSummary]:[])].join('\n\n');
    return {id:flow.id,flowId:flow.id,projectId:flow.projectId,title,summary,markdown:redact(markdown),generatedAt:new Date().toISOString(),status:flow.status};
  }
  checkpoint(flowId:string){
    const flow=this.flow(flowId);if(!['completed','cancelled'].includes(flow.status))return;
    if(!this.store.get('flow_project_records',flowId))this.store.put('flow_project_records',flowId,this.generate(flow));
  }
  async finish(flowId:string){
    const flow=this.flow(flowId);if(!['completed','cancelled'].includes(flow.status))return;
    this.checkpoint(flowId);
    if(this.project(flow.projectId).projectRecordToFolder&&['prepared','missing'].includes(this.store.get<RecordReceipt>('flow_record_receipts',flowId)?.state??'missing'))try{await this.write(flowId);}catch(error){if(!(error instanceof FlowError&&error.code==='SETTING_DISABLED'))this.store.put('flow_record_receipts',flowId,{id:flowId,flowId,projectId:flow.projectId,state:'failed',path:'',contentHash:'',updatedAt:new Date().toISOString(),error:redact((error as Error).message)});}
  }
  write(flowId:string):Promise<RecordReceipt|undefined> {
    const running=this.writes.get(flowId);if(running)return running;
    const promise=this.archive(flowId).finally(()=>this.writes.delete(flowId));this.writes.set(flowId,promise);return promise;
  }
  private async archive(flowId:string){
    const flow=this.flow(flowId),project=this.project(flow.projectId);
    if(!project.projectRecordToFolder)throw new FlowError('SETTING_DISABLED','请先开启本项目的记录写入设置。');
    if(!['completed','cancelled'].includes(flow.status))throw new FlowError('FLOW_ACTIVE','工作结束后才自动写入项目记录。');
    if(!this.store.get('flow_project_records',flowId))this.store.put('flow_project_records',flowId,this.generate(flow));
    assertProjectBoundary(this.store,flow.projectId,flow.writeBoundary);const record=this.record({flowId}),old=this.store.get<RecordReceipt>('flow_record_receipts',flowId);if(old?.state==='written')return old;
    const contentHash=digest(record.markdown),prefix='docs/airoom/'+record.generatedAt.slice(0,10)+'-'+nameSafe(record.title);
    let relative=old?.contentHash===contentHash?old.path:prefix+'.md',receipt:RecordReceipt={id:flowId,flowId,projectId:project.id,state:'prepared',path:relative,contentHash,updatedAt:new Date().toISOString()};
    try{
      for(let attempt=0;attempt<100;attempt++){
        receipt={...receipt,state:'prepared',path:relative,updatedAt:new Date().toISOString()};this.store.put('flow_record_receipts',flowId,receipt);
        let target=resolveSafePath(project.directory,relative);await fs.mkdir(path.dirname(target),{recursive:true});target=resolveSafePath(project.directory,relative);
        try{await withProjectWrite(this.store,project.id,project.directory,async check=>{check();await fs.writeFile(target,record.markdown,{flag:'wx'});},false,[relative]);break;}catch(error){
          if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
          if(old?.state==='prepared'&&old.path===relative&&old.contentHash===contentHash&&digest(await fs.readFile(target,'utf8'))===contentHash)break;
          if(attempt===99)throw Error('同名记录过多，请换一个目录后重试。');
          relative=prefix+'-'+flow.id.slice(0,8)+(attempt?'-'+attempt:'')+'.md';
        }
      }
      receipt={...receipt,state:'written',error:undefined,updatedAt:new Date().toISOString()};
    }catch(error){receipt={...receipt,state:'failed',error:redact((error as Error).message),updatedAt:new Date().toISOString()};}
    this.store.put('flow_record_receipts',flowId,receipt);return receipt;
  }
}
