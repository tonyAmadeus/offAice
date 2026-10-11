import type { TimelineEvent } from './types';

export type LogTarget = { kind:'task'|'round'|'session'|'member'; id:string };
export interface ToolObservation {
  schemaVersion:1; toolCallId?:string; nativeTurnId?:string;
  kind:'command'|'file'|'tool'; phase:'started'|'progress'|'completed'|'failed'|'unknown';
  command?:string; paths:string[]; exitCode?:number;
}
export interface WorkLogEntry {
  id:string; sequence:number; at:string; runId:string; sessionId:string; memberId:string;
  kind:TimelineEvent['kind']; text:string; detail:string; fidelity:TimelineEvent['fidelity'];
  sourceEventIds:string[]; tool?:ToolObservation;
}
export interface LogRun {id:string;memberId:string;stage:string;status:string;delivery:string;error?:string;configuration?:string}
export interface LogRecord {id:string;runId:string;kind:'submission'|'review'|'report'|'reply';text:string}
export interface WorkLogPage {
  projectId:string; target:LogTarget; title:string; entries:WorkLogEntry[]; runs:LogRun[];
  through:number; scannedThrough:number; hasMore:boolean; cursor?:string; checkpoint:string;
  records:LogRecord[];
  canWrite:boolean; receipts:LogReceipt[];
}
export interface LogExport {name:string;content:string;hash:string;through:number;entryCount:number;checkpoint:string}
export interface LogReceipt {
  id:string;projectId:string;roundId:string;target:LogTarget;acceptanceId:string;
  checkpoint:string;path:string;hash?:string;state:'prepared'|'written'|'failed';error?:string;at:string;
}
export const LOG_READS=['projectFlow.log','projectFlow.log.export'] as const;

/** Decode explicit native fields only. Human prose and process termination cannot prove a tool succeeded. */
export function observeTool(event:TimelineEvent):ToolObservation|undefined {
  if(!['tool','output'].includes(event.kind))return;
  const d=(event.data&&typeof event.data==='object'?event.data:{}) as Record<string,any>;
  const input=d.input??d.rawInput??{}, command=[d.command,input.command].find(v=>typeof v==='string');
  const code=typeof d.exitCode==='number'&&Number.isSafeInteger(d.exitCode)?d.exitCode:undefined;
  const status=String(d.status??''),type=String(d.type??''),id=d.toolCallId??d.tool_use_id??d.itemId??d.id;
  const terminal=d.airoomPhase==='completed'||type==='tool_result'||['completed','failed'].includes(status)||!status&&code!==undefined;
  const failure=d.is_error===true||status==='failed'||code!==undefined&&code!==0;
  const phase=failure&&terminal?'failed':terminal?'completed':d.airoomPhase==='started'||type==='tool_use'?'started':['in_progress','running','pending'].includes(status)?'progress':'unknown';
  const rawPaths=[d.path,input.file_path,input.path,...(Array.isArray(d.changes)?d.changes.map((v:any)=>v.path):[]),...(Array.isArray(d.locations)?d.locations.map((v:any)=>v.path):[])];
  const paths=[...new Set(rawPaths.filter((v):v is string=>typeof v==='string'))].slice(0,100);
  if(event.kind==='output'&&!id&&!command&&code===undefined)return;
  return {schemaVersion:1,...(typeof id==='string'||typeof id==='number'?{toolCallId:String(id)}:{}),...(typeof d.turnId==='string'?{nativeTurnId:d.turnId}:{}),kind:command?'command':paths.length||['fileChange','read','edit','delete'].includes(type||d.kind)?'file':'tool',phase,command,paths,exitCode:code};
}
