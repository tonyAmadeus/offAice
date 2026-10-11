import type {Run} from './types';
import type {FlowOperation} from './project-flow';

/** Counts receipts, not messages or model claims. In-flight calls are included. */
export interface CallUsage {total:number;delivered:number;completed:number;notSent:number;withdrawn:number;unknown:number;corrections:number;retries:number}
export function callUsage(runs:Run[],roles:Record<string,{correction?:boolean;retry?:boolean}>={}):CallUsage{
  const unique=[...new Map(runs.map(run=>[run.id,run])).values()];
  return {total:unique.length,delivered:unique.filter(r=>['sent','confirmed'].includes(r.delivery)).length,
    completed:unique.filter(r=>['ended','completed'].includes(r.status)&&['sent','confirmed'].includes(r.delivery)).length,
    notSent:unique.filter(r=>r.status==='failed'&&r.delivery==='prepared').length,withdrawn:unique.filter(r=>r.delivery==='withdrawn').length,
    unknown:unique.filter(r=>r.status==='unknown'||r.delivery==='unknown').length,
    corrections:unique.filter(r=>roles[r.id]?.correction||r.origin?.callKind==='correction').length,
    retries:unique.filter(r=>roles[r.id]?.retry||r.origin?.callKind==='retry').length};
}
export function callUsageLabel(usage:CallUsage,estimate?:number,estimateScope='基础预计'){
  return `累计尝试 ${usage.total} 次 · 已发出 ${usage.delivered} 次 · 已完成 ${usage.completed} 次${estimate===undefined?'':` · ${estimateScope} ${estimate} 次`}`+
    (usage.corrections||usage.retries?`（含补正 ${usage.corrections} 次、重试 ${usage.retries} 次）`:'')+
    (usage.notSent?` · 未发出失败 ${usage.notSent} 次`:'')+(usage.withdrawn?` · 未发出已撤回 ${usage.withdrawn} 次`:'')+(usage.unknown?` · 结果未知 ${usage.unknown} 次`:'');
}
export function jointCallRoles(operations:FlowOperation[],runs:Run[]){
  const roles:Record<string,{correction?:boolean;retry?:boolean}>={};
  const byId=new Map(runs.map(run=>[run.id,run]));
  for(const op of operations){
    if(op.correctionRunId)roles[op.correctionRunId]={correction:true};
    for(const priorId of op.connectionRetryRunIds??[]){const prior=byId.get(priorId),next=[op.runId,op.correctionRunId].map(id=>id?byId.get(id):undefined).filter((run):run is Run=>Boolean(run&&prior&&run.createdAt>=prior.createdAt)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0];if(next)roles[next.id]={...roles[next.id],retry:true};}
  }
  return roles;
}
