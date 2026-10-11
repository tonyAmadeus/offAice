import type { AutomaticFeature, AutomaticOrigin, AutomaticPolicies, AutomaticUsage } from '../shared/automation';
import { AUTOMATIC_FEATURES, localParts, policiesOf } from '../shared/automation';
import type { ProviderId, Run, RunStatus } from '../shared/types';
import { Store } from './store';

export class AutomaticDenied extends Error {}
interface Attempt { id:string;feature:AutomaticFeature;day:string;runId:string;provider:ProviderId;at:string;status:RunStatus }
/** Daily limits count attempted background calls, independently of account quota percentages. */
export class AutomaticBudget {
  constructor(private store:Store,private policies:()=>AutomaticPolicies|undefined,private options:{now?:()=>number;quotaAllows?:(provider:ProviderId,model?:string)=>boolean}={}){
    for(const attempt of store.list<Attempt>('automatic_attempts'))if(attempt.status==='running'){
      const run=store.get<Run>('runs',attempt.runId);store.put('automatic_attempts',attempt.id,{...attempt,status:run&&['ended','completed','stopped','failed'].includes(run.status)?run.status:'unknown'});
    }
  }
  private now(){return this.options.now?.()??Date.now();}
  private day(){const reported=localParts(this.now()).day,last=this.store.get<{day:string}>('automatic_budget_state','main')?.day;return last&&last>reported?last:reported;}
  static validate(value:unknown):AutomaticPolicies{
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('自动发言的开关或每日上限没有设置正确，请重新设置。');
    const result:AutomaticPolicies={};
    for(const [id,policy] of Object.entries(value)){
      if(!Object.hasOwn(AUTOMATIC_FEATURES,id)||!policy||typeof policy!=='object'||typeof policy.enabled!=='boolean'||!Number.isInteger(policy.dailyLimit)||policy.dailyLimit<0||policy.dailyLimit>1000)throw new Error('自动功能需要独立开关和 0–1000 次的每日上限。');
      result[id as AutomaticFeature]={...policy,enabled:policy.enabled,dailyLimit:policy.dailyLimit};
    }
    return result;
  }
  reason(feature:AutomaticFeature,provider?:ProviderId,model?:string):string|undefined{
    const policy=policiesOf(this.policies())[feature];if(!policy?.enabled)return '这项自动发言还没开启，本次已跳过。';
    const used=this.store.get<{used:number}>('automatic_usage',`${this.day()}:${feature}`)?.used??0;
    if(used>=policy.dailyLimit)return '这项自动发言今天已达到每日上限，本次已跳过，明天可继续。';
    if(provider&&this.options.quotaAllows?.(provider,model)===false)return '成员的账号额度或余额暂时不够，本次已跳过自动发言。';
  }
  admit(origin:AutomaticOrigin,runId:string,provider:ProviderId,model?:string){
    return this.store.transaction(()=>{
      const denied=this.reason(origin.feature,provider,model);if(denied)throw new AutomaticDenied(denied);
      const id=origin.occurrenceId;if(this.store.get('automatic_attempts',id))throw new AutomaticDenied('这次自动发言已经处理，本次没有重复发送。');
      const day=this.day(),key=`${day}:${origin.feature}`,used=this.store.get<{used:number}>('automatic_usage',key)?.used??0;
      this.store.put('automatic_budget_state','main',{day});this.store.put('automatic_usage',key,{day,feature:origin.feature,used:used+1});
      this.store.put('automatic_attempts',id,{id,feature:origin.feature,day,runId,provider,at:new Date(this.now()).toISOString(),status:'running'} satisfies Attempt);
      return id;
    });
  }
  complete(id:string,status:RunStatus){const attempt=this.store.get<Attempt>('automatic_attempts',id);if(attempt)this.store.put('automatic_attempts',id,{...attempt,status});this.store.pruneHistory('automatic_attempts',500);}
  snapshot():AutomaticUsage[]{const day=this.day(),policies=policiesOf(this.policies());return (Object.keys(AUTOMATIC_FEATURES) as AutomaticFeature[]).map(feature=>({feature,day,used:this.store.get<{used:number}>('automatic_usage',`${day}:${feature}`)?.used??0,reserved:0,limit:policies[feature].dailyLimit,enabled:policies[feature].enabled}));}
}
