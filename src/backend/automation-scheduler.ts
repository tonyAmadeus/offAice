import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { AutomationSnapshot, LifeFeature, TimedAction, TimedJob, TimedOccurrence, TimedSchedule } from '../shared/automation';
import { AUTOMATION_TIME_ZONE, localParts, nextOccurrence, occurrenceKey, validateSchedule } from '../shared/automation';
import { Store } from './store';

export interface TimedResult { status:'done'|'skipped'|'failed'|'unknown';reason?:string;runId?:string;runIds?:string[] }
interface Host { run(job:TimedJob,occurrence:TimedOccurrence):Promise<TimedResult>;changed():void }
/** Runs only while AIROOM is open. A claimed occurrence is never replayed after a crash. */
export class AutomationScheduler {
  private timer?:NodeJS.Timeout;private pending?:Promise<void>;private stopped=false;
  constructor(private store:Store,private host:Host,private options:{now?:()=>number;tickMs?:number;graceMs?:number}={}){
    for(const item of store.list<TimedOccurrence>('timed_occurrences'))if(item.status==='running'){
      store.put('timed_occurrences',item.id,{...item,status:'unknown',finishedAt:this.at(),reason:'上次触发未确认完成，未自动重发。'});
      const job=store.get<TimedJob>('timed_jobs',item.jobId);if(job&&!job.system)store.put('timed_jobs',job.id,{...job,pausedReason:'上次触发结果待核对，请确认后重新启用。'});
    }
    // Startup skips elapsed triggers, including ones missed while the app was closed.
    for(const job of store.list<TimedJob>('timed_jobs'))if(job.nextAt&&Date.parse(job.nextAt)<=this.now())this.skip(job,'AIROOM 关闭或重启期间错过的触发，未补发。');
  }
  private now(){return this.options.now?.()??Date.now();}
  private at(){return new Date(this.now()).toISOString();}
  get paused(){return this.store.get<{paused:boolean}>('automation_state','main')?.paused===true;}
  start(){if(this.timer||this.stopped)return;this.timer=setInterval(()=>void this.tick().catch(()=>{}),this.options.tickMs??1000);this.timer.unref();}
  snapshot():AutomationSnapshot{return {paused:this.paused,timeZone:AUTOMATION_TIME_ZONE,jobs:this.store.list<TimedJob>('timed_jobs').filter(job=>!job.system),recent:this.store.recent<TimedOccurrence>('timed_occurrences',40,false)};}
  save(input:{id?:string;name:string;enabled?:boolean;schedule:TimedSchedule;action:TimedAction;acknowledgeUnknown?:boolean},system=false,managed?:LifeFeature):TimedJob{
    if(this.stopped)throw new Error('定时服务正在退出。');
    const previous=input.id?this.store.get<TimedJob>('timed_jobs',input.id):undefined;
    if(input.id&&!previous)throw new Error('定时任务已删除，请刷新。');if(previous?.system&&!system||previous?.managed&&!managed)throw new Error('内部定时任务不能修改。');
    if(previous?.pausedReason&&input.enabled===true&&!input.acknowledgeUnknown&&!managed)throw new Error('请先核对上次触发结果，确认后重新启用。');
    if(!input.name?.trim()||input.name.length>120)throw new Error('请输入不超过 120 字的任务名称。');
    const schedule=validateSchedule(input.schedule),at=this.at(),nextAt=nextOccurrence(schedule,Math.max(this.now(),Date.parse(previous?.lastDueAt??'')||0));
    if(!nextAt)throw new Error('一次性任务必须选择未来的时间。');
    if(this.store.list<TimedJob>('timed_jobs').filter(job=>!job.system&&!job.managed).length>=100&&!previous&&!system&&!managed)throw new Error('最多保留 100 个定时任务。');
    const job:TimedJob={id:previous?.id??randomUUID(),name:input.name.trim(),enabled:input.enabled===true,schedule,action:structuredClone(input.action),revision:(previous?.revision??0)+1,createdAt:previous?.createdAt??at,updatedAt:at,nextAt,lastDueAt:previous?.lastDueAt,lastDay:previous?.lastDay,...(previous?.pausedReason&&!input.acknowledgeUnknown?{pausedReason:previous.pausedReason}:{}),...(system?{system:true}:{}),...(managed?{managed}:{})};
    this.store.put('timed_jobs',job.id,job);this.host.changed();return job;
  }
  system(name:string,minutes:number,action:TimedAction){const old=this.store.list<TimedJob>('timed_jobs').find(job=>job.system&&job.name===name);if(old?.nextAt)return old;return this.save({id:old?.id,name,enabled:true,schedule:{kind:'interval',minutes},action},true);}
  managed(feature:LifeFeature,input:{name:string;enabled:boolean;schedule:TimedSchedule;action:TimedAction}){
    const previous=this.store.list<TimedJob>('timed_jobs').find(job=>job.managed===feature);
    if(previous&&previous.enabled===input.enabled&&JSON.stringify(previous.schedule)===JSON.stringify(input.schedule)&&JSON.stringify(previous.action)===JSON.stringify(input.action))return previous;
    return this.save({...input,id:previous?.id},false,feature);
  }
  disableManaged(feature:LifeFeature){const job=this.store.list<TimedJob>('timed_jobs').find(job=>job.managed===feature);if(job?.enabled){this.store.put('timed_jobs',job.id,{...job,enabled:false,revision:job.revision+1,updatedAt:this.at()});this.host.changed();}}
  hold(id:string,reason:string){const job=this.store.get<TimedJob>('timed_jobs',id);if(job&&!job.system){this.store.put('timed_jobs',id,{...job,pausedReason:reason,updatedAt:this.at()});this.host.changed();}}
  acknowledgeManaged(feature:LifeFeature){
    const job=this.store.list<TimedJob>('timed_jobs').find(job=>job.managed===feature);if(!job)return;
    if(this.store.list<TimedOccurrence>('timed_occurrences').some(item=>item.jobId===job.id&&item.status==='running'))throw new Error('请先等待当前发言结束，再核对恢复。');
    this.store.put('timed_jobs',job.id,{...job,pausedReason:undefined,revision:job.revision+1,updatedAt:this.at(),nextAt:job.schedule.kind==='interval'?nextOccurrence(job.schedule,this.now()):undefined});this.host.changed();
  }
  remove(id:string){const job=this.store.get<TimedJob>('timed_jobs',id);if(job?.system||job?.managed)throw new Error('内置自动功能请使用每日预算中的开关。');this.store.delete('timed_jobs',id);this.host.changed();}
  pause(){this.store.put('automation_state','main',{paused:true,at:this.at()});this.host.changed();}
  resume(){if(this.stopped)throw new Error('定时服务正在退出。');for(const job of this.store.list<TimedJob>('timed_jobs'))if(!job.system&&job.nextAt&&Date.parse(job.nextAt)<=this.now())this.skip(job,'你暂停期间到点的任务已跳过，恢复后不会补发。');this.store.put('automation_state','main',{paused:false,at:this.at()});this.host.changed();}
  current(item:TimedOccurrence){const job=this.store.get<TimedJob>('timed_jobs',item.jobId);return !this.stopped&&Boolean(job?.enabled&&!job.pausedReason&&job.revision===item.jobRevision&&(job.system||!this.paused));}
  private id(job:TimedJob,key:string){return createHash('sha256').update(JSON.stringify([job.id,key])).digest('hex');}
  private advance(job:TimedJob){
    const lastDueAt=[job.lastDueAt,job.nextAt].filter((at):at is string=>Boolean(at)).sort().at(-1),day=job.schedule.kind==='daily'&&job.nextAt?localParts(Date.parse(job.nextAt),job.schedule.timeZone).day:undefined;
    this.store.put('timed_jobs',job.id,{...job,lastDueAt,lastDay:[job.lastDay,day].filter(Boolean).sort().at(-1),nextAt:nextOccurrence(job.schedule,Math.max(this.now(),Date.parse(lastDueAt??'')||0)),lastAt:this.at()});
  }
  private skip(job:TimedJob,reason:string){
    if(!job.nextAt)return;const key=occurrenceKey(job,job.nextAt),id=this.id(job,key);
    if(!this.store.get('timed_occurrences',id))this.store.put('timed_occurrences',id,{id,jobId:job.id,jobRevision:job.revision,key,dueAt:job.nextAt,startedAt:this.at(),finishedAt:this.at(),status:'skipped',reason,...(job.system?{system:true}:{})} satisfies TimedOccurrence);
    this.advance(job);
  }
  tick():Promise<void>{if(this.pending)return this.pending;if(this.stopped)return Promise.resolve();const pending=this.drain();this.pending=pending;void pending.finally(()=>{if(this.pending===pending)this.pending=undefined;}).catch(()=>{});return pending;}
  private async drain(){
    let changed=false;
    for(const candidate of this.store.list<TimedJob>('timed_jobs')){
      if(this.stopped)break;const job=this.store.get<TimedJob>('timed_jobs',candidate.id);
      if(!job?.nextAt||Date.parse(job.nextAt)>this.now())continue;
      if(job.lastDueAt&&Date.parse(job.nextAt)<=Date.parse(job.lastDueAt)||job.schedule.kind==='daily'&&job.lastDay&&occurrenceKey(job,job.nextAt)<=job.lastDay){this.skip(job,'这个时间点的任务已经处理，本次没有重复执行。');changed=true;continue;}
      if(!job.enabled||job.pausedReason||this.paused&&!job.system){this.skip(job,'任务没有开启或已暂停，这次已跳过。');changed=true;continue;}
      if(!job.system&&this.now()-Date.parse(job.nextAt)>(this.options.graceMs??120_000)){this.skip(job,'任务约定的时间已错过，这次已跳过，不会补发。');changed=true;continue;}
      const key=occurrenceKey(job,job.nextAt),id=this.id(job,key);
      const item:TimedOccurrence={id,jobId:job.id,jobRevision:job.revision,key,dueAt:job.nextAt,startedAt:this.at(),status:'running',...(job.system?{system:true}:{})};
      const claimed=this.store.transaction(()=>{if(this.store.get('timed_occurrences',id)){this.advance(job);return false;}this.store.put('timed_occurrences',id,item);this.advance(job);return true;});
      changed=true;if(!claimed)continue;
      this.host.changed();
      let result:TimedResult;
      try{result=this.current(item)?await this.host.run(job,item):{status:'skipped',reason:'任务的设置已经变更或已暂停，这次已跳过。'};}catch(error){result={status:'failed',reason:(error as Error).message};}
      this.store.put('timed_occurrences',id,{...(this.store.get<TimedOccurrence>('timed_occurrences',id)??item),...result,finishedAt:this.at()});
      const latest=this.store.get<TimedJob>('timed_jobs',job.id);
      if(result.status==='unknown'&&latest&&!latest.system)this.store.put('timed_jobs',job.id,{...latest,pausedReason:'这次任务的结果还不确定，已暂停。请查看活动记录，核对后再开启。'});
      this.host.changed();
    }
    if(changed){
      // The per-job watermark retains deduplication after old diagnostic rows are pruned.
      this.store.pruneHistory('timed_occurrences',500,false);this.store.pruneHistory('timed_occurrences',20,true);
      this.host.changed();
    }
  }
  async close(){this.stopped=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.pending;}
}
