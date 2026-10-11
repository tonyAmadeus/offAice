import type { Store } from './store';
import type { Decision, Plan, ProjectFlow, Round } from '../shared/project-flow';
import type { RoomMessage } from '../shared/types';

interface PendingReport {id:string;projectId:string;flowId:string;roundId:string;integrationId:string;report:NonNullable<Round['report']>;title:string;createdAt:string;publishedAt?:string;threadId?:string}
interface PendingCard {id:string;projectId:string;flowId:string;text:string;createdAt:string;author:'lead'|'user';flowPlan?:RoomMessage['flowPlan'];flowDecision?:RoomMessage['flowDecision'];publishedAt?:string;threadId?:string}
export function projectFlowCardWrite(store:Store,kind:'plan'|'decision',record:Plan|Decision){
  const id=kind==='plan'?`flow-plan:${record.id}`:`flow-decision:${record.id}:${record.status}`;
  if(store.get('room_flow_cards',id))return;
  const plan=kind==='plan'?record as Plan:undefined,decision=kind==='decision'?record as Decision:undefined;
  const card:PendingCard={id,projectId:record.projectId,flowId:record.flowId,createdAt:record.updatedAt,author:decision?.status==='answered'?'user':'lead',
    text:plan?[`【方案 · 第 ${plan.version} 版】`,plan.objective,`范围：${plan.scope}`,`交付：${plan.deliverables.join('、')}`,`验收标准：${plan.acceptanceCriteria.join('；')}`,`${plan.rounds.length} 轮，${plan.tasks.length} 项任务`].join('\n\n'):
      [`【决策 · ${decision!.title}】`,decision!.reason,decision!.status==='open'?`待你决定：${decision!.options.join(' / ')}`:decision!.status==='answered'?`你的选择：${decision!.answer?.choice??'已处理'}${decision!.answer?.opinion?'\n'+decision!.answer.opinion:''}`:decision!.status==='expired'?'这项决策已过期。':'这项决策已取消。'].join('\n\n'),
    ...(plan?{flowPlan:{flowId:plan.flowId,planId:plan.id,version:plan.version}}:{flowDecision:{flowId:decision!.flowId,decisionId:decision!.id,revision:decision!.revision,status:decision!.status}})};
  return {entity:'room_flow_cards',id,value:card};
}
export function stageFlowCard(store:Store,kind:'plan'|'decision',record:Plan|Decision){const write=projectFlowCardWrite(store,kind,record);if(write)store.put(write.entity,write.id,write.value);}
function reportThread(store:Store,flow:ProjectFlow){
  if(!store.get('projects',flow.projectId))return;
  const roomId=`project:${flow.projectId}`,id=flow.threadId??store.get<{id:string}>('room_cursors',roomId)?.id;
  const thread=id?store.get<{roomId:string}>('room_threads',id):undefined;
  return thread?.roomId===roomId?id:undefined;
}
export function publishFlowCards(store:Store){
  for(const card of store.list<PendingCard>('room_flow_cards').filter(item=>!item.publishedAt)){
    const flow=store.get<ProjectFlow>('project_flows',card.flowId),threadId=flow&&reportThread(store,flow);if(!flow||flow.projectId!==card.projectId||!threadId)continue;
    const author=card.author==='user'?'user':flow.leadMemberId;
    const message:RoomMessage={id:card.id,author,authorName:store.members().find(member=>member.id===author)?.name,threadId,text:card.text,at:card.createdAt,status:'done',flowPlan:card.flowPlan,flowDecision:card.flowDecision};
    store.transaction(()=>{if(!store.get('room_messages',message.id))store.roomScope(`project:${card.projectId}`).put('room_messages',message.id,message);store.put('room_flow_cards',card.id,{...card,publishedAt:new Date().toISOString(),threadId});});
  }
}
export function migrateFlowCards(store:Store){
  if(!store.get('room_migrations','flow-cards-v1'))store.transaction(()=>{for(const plan of store.list<Plan>('flow_plans'))stageFlowCard(store,'plan',plan);for(const decision of store.list<Decision>('flow_decisions'))stageFlowCard(store,'decision',decision);store.put('room_migrations','flow-cards-v1',{at:new Date().toISOString()});});
  publishFlowCards(store);
}
/** The round and its pending room message are committed together, before any UI delivery. */
export function stageRoundReport(store:Store,round:Round){
  if(!round.report||!round.integrationId)return;
  const id=`round-report:${round.id}:${round.integrationId}${round.reportRunId?':'+round.reportRunId:''}`;
  if(!store.get('room_reports',id))store.put('room_reports',id,{id,projectId:round.projectId,flowId:round.flowId,roundId:round.id,integrationId:round.integrationId,report:round.report,title:round.title,createdAt:round.updatedAt} satisfies PendingReport);
}
export function publishRoundReports(store:Store){
  for(const report of store.list<PendingReport>('room_reports').filter(r=>!r.publishedAt)){
    const flow=store.get<ProjectFlow>('project_flows',report.flowId),threadId=flow&&reportThread(store,flow);
    if(!flow||flow.projectId!==report.projectId||!threadId)continue;
    const p=report.report,text=[`【${report.title} · 轮次汇报】`,p.summary,`交付：${p.deliverables.join('、')}`,`验证：${p.validationSummary}`,...(p.systemNotes??[]).map(note=>`检查提示：${note.text}`),p.remainingIssues.length?`待处理：${p.remainingIssues.join('；')}`:'',p.nextRoundSummary?`后续：${p.nextRoundSummary}`:'',p.userDecisionNeeded].filter(Boolean).join('\n\n');
    const message:RoomMessage={id:report.id,author:flow.leadMemberId,authorName:store.members().find(m=>m.id===flow.leadMemberId)?.name,threadId,text,at:report.createdAt,status:'done',flowReport:{flowId:flow.id,roundId:report.roundId,integrationId:report.integrationId}};
    store.transaction(()=>{if(!store.get('room_messages',message.id))store.roomScope(`project:${report.projectId}`).put('room_messages',message.id,message);store.put('room_reports',report.id,{...report,publishedAt:new Date().toISOString(),threadId});});
  }
}
export function migrateRoundReports(store:Store){
  if(!store.get('room_migrations','flow-reports-v1'))store.transaction(()=>{for(const round of store.list<Round>('flow_rounds'))stageRoundReport(store,round);store.put('room_migrations','flow-reports-v1',{at:new Date().toISOString()});});
  publishRoundReports(store);
}
