export const AUTOMATION_TIME_ZONE='Asia/Shanghai';
export const AUTOMATION_PAUSE_FILE='automation-paused.flag';
export const AUTOMATION_RPC_METHODS=['automation.list','automation.save','automation.remove','automation.pause','automation.resume','automation.policy.save','automation.life.acknowledge'] as const;
export type AutomaticFeature='daily-opening'|'member-chat'|'scheduled-message';
export const AUTOMATIC_FEATURES:Record<AutomaticFeature,{label:string;dailyLimit:number}>={
  'daily-opening':{label:'每日开场',dailyLimit:1},'member-chat':{label:'成员闲聊',dailyLimit:4},'scheduled-message':{label:'定时发言',dailyLimit:4},
};
export interface AutomaticPolicy { enabled:boolean;dailyLimit:number }
export type AutomaticPolicies=Partial<Record<AutomaticFeature,AutomaticPolicy>>;
export interface AutomaticOrigin { feature:AutomaticFeature;jobId:string;occurrenceId:string;reservationId?:string }
export type TimedSchedule={kind:'once';at:string}|{kind:'daily';time:string;timeZone:string}|{kind:'interval';minutes:number};
export type LifeFeature='daily-opening'|'member-chat';
export interface DailyLifeOptions { memberChatMinutes:number }
export const DAILY_LIFE_DEFAULTS:DailyLifeOptions={memberChatMinutes:30};
export function dailyLifeOptions(value?:Partial<DailyLifeOptions>):DailyLifeOptions{return {memberChatMinutes:value?.memberChatMinutes??DAILY_LIFE_DEFAULTS.memberChatMinutes};}
export function validateDailyLife(value:unknown):DailyLifeOptions{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('成员闲聊设置无效。');
  const minutes=(value as DailyLifeOptions).memberChatMinutes;
  if(!Number.isInteger(minutes)||minutes<5||minutes>1440)throw new Error('成员闲聊间隔应为 5–1440 分钟。');
  return {memberChatMinutes:minutes};
}
export type TimedAction={kind:'notice';text:string;threadId?:string}|{kind:'local-event';event:string;memberId?:string}|{kind:'member-message';text:string;memberId:string;threadId:string;feature:AutomaticFeature}|{kind:'daily-opening';day:string;threadId:string}|{kind:'member-chat'};
export interface TimedJob {
  id:string;name:string;enabled:boolean;schedule:TimedSchedule;action:TimedAction;revision:number;
  createdAt:string;updatedAt:string;nextAt?:string;lastAt?:string;lastDueAt?:string;lastDay?:string;pausedReason?:string;system?:boolean;
  /** Built-in opt-in life features use normal pause and recovery rules, unlike maintenance timers. */
  managed?: LifeFeature;
}
export interface TimedOccurrence {
  id:string;jobId:string;jobRevision:number;key:string;dueAt:string;startedAt:string;finishedAt?:string;
  status:'running'|'done'|'skipped'|'failed'|'unknown';reason?:string;runId?:string;system?:boolean;
  /** Every paid step has its own durable occurrence and budget receipt, bound to its parent and topic. */
  parentOccurrenceId?:string;memberId?:string;memberIds?:string[];memberStamps?:string[];threadId?:string;step?:number;runIds?:string[];
}
export interface AutomaticUsage { feature:AutomaticFeature;day:string;used:number;reserved:number;limit:number;enabled:boolean }
export interface AutomationSnapshot {
  paused:boolean;timeZone:string;jobs:TimedJob[];recent:TimedOccurrence[];
  policies?:AutomaticPolicies;usage?:AutomaticUsage[];
}
const formatters=new Map<string,Intl.DateTimeFormat>();
export function localParts(at:number,timeZone=AUTOMATION_TIME_ZONE){
  let formatter=formatters.get(timeZone);if(!formatter){formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});formatters.set(timeZone,formatter);}
  const parts=Object.fromEntries(formatter.formatToParts(at).map(part=>[part.type,part.value]));
  return {day:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}`};
}
export function validateSchedule(value:TimedSchedule):TimedSchedule{
  if(value?.kind==='once'&&typeof value.at==='string'&&Number.isFinite(Date.parse(value.at)))return {kind:'once',at:new Date(value.at).toISOString()};
  if(value?.kind==='daily'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)){
    const timeZone=value.timeZone||AUTOMATION_TIME_ZONE;localParts(Date.now(),timeZone);return {kind:'daily',time:value.time,timeZone};
  }
  if(value?.kind==='interval'&&Number.isInteger(value.minutes)&&value.minutes>=1&&value.minutes<=43_200)return {kind:'interval',minutes:value.minutes};
  throw new Error('定时设置无效：请选择有效时间，或 1–43200 分钟的间隔。');
}
/** Every occurrence is later than `after`; daily jobs run only once on a local calendar date. */
export function nextOccurrence(schedule:TimedSchedule,after:number):string|undefined{
  if(schedule.kind==='once')return Date.parse(schedule.at)>after?schedule.at:undefined;
  if(schedule.kind==='interval')return new Date(after+schedule.minutes*60_000).toISOString();
  // Minute boundaries also handle DST gaps and repeated hours without inventing a local time.
  for(let at=Math.floor(after/60_000)*60_000+60_000,end=at+3*86_400_000;at<end;at+=60_000)if(localParts(at,schedule.timeZone).time===schedule.time)return new Date(at).toISOString();
  throw new Error('无法计算下一次触发时间。');
}
export function occurrenceKey(job:TimedJob,dueAt:string){return job.schedule.kind==='daily'?localParts(Date.parse(dueAt),job.schedule.timeZone).day:dueAt;}
export function policiesOf(saved?:AutomaticPolicies):Record<AutomaticFeature,AutomaticPolicy>{
  return Object.fromEntries(Object.entries(AUTOMATIC_FEATURES).map(([id,meta])=>[id,{enabled:saved?.[id as AutomaticFeature]?.enabled===true,dailyLimit:saved?.[id as AutomaticFeature]?.dailyLimit??meta.dailyLimit}])) as Record<AutomaticFeature,AutomaticPolicy>;
}
