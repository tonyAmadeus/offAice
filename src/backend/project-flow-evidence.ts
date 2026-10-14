import type {Evidence} from '../shared/project-flow';
import type {TimelineEvent} from '../shared/types';
import { observeTool } from '../shared/work-log';

interface ToolData {command?:string;input?:{command?:string};rawInput?:{command?:string};id?:string|number;tool_use_id?:string|number;toolCallId?:string|number;exitCode?:number;status?:string;type?:string;is_error?:boolean}
const data=(event:TimelineEvent)=>event.data&&typeof event.data==='object'?event.data as ToolData:undefined;
export const eventCommand=(event:TimelineEvent)=>observeTool(event)?.command;
const exitCode=(event:TimelineEvent)=>observeTool(event)?.exitCode;
const failed=(event:TimelineEvent)=>observeTool(event)?.phase==='failed';
const sameId=(a:unknown,b:unknown)=>a!==undefined&&a!==''&&a===b;
function completes(start:TimelineEvent,end:TimelineEvent){
  const s=data(start),d=data(end);if(!s||!d||start.runId!==end.runId)return false;
  const terminal=['completed','failed'].includes(observeTool(end)?.phase??'');
  return terminal&&(start.id===end.id||sameId(s.id,d.id)||d.type==='tool_result'&&sameId(s.id,d.tool_use_id)||sameId(s.toolCallId,d.toolCallId));
}

/** Decode one serialized argv value, including adjacent quoted segments. Never evaluate shell syntax. */
function quotedArgument(input:string):string|undefined {
  let body='',quote='',index=0;
  for(;index<input.length;index++){
    const char=input[index];
    if(quote==="'"){if(char==="'")quote='';else body+=char;continue;}
    if(quote==='"'){
      if(char==='"'){quote='';continue;}
      if(char==='\\'&&index+1<input.length&&['"','\\','$','\x60','\n'].includes(input[index+1])){
        const escaped=input[++index];if(escaped!=='\n')body+=escaped;
      }else body+=char;
      continue;
    }
    if(/\s/.test(char))break;
    if([';', '&', '|', '<', '>', '(', ')'].includes(char))return;
    if(char==="'"||char==='"'){quote=char;continue;}
    if(char==='\\'){
      if(index+1===input.length)return;
      const escaped=input[++index];if(escaped!=='\n')body+=escaped;
    }else body+=char;
  }
  if(quote||input.slice(index).trim())return;
  return body;
}

/** Remove only recognized launch wrappers; inner command bytes remain exact. */
function unwrapCommand(command:string):string|undefined {
  const executable=command.match(/^\s*(?:"([^"]+)"|'([^']+)'|([^\s'"]+))\s+([\s\S]+)$/);
  if(!executable)return;
  const shell=(executable[1]??executable[2]??executable[3]).split(/[\\/]/).at(-1)?.toLowerCase();
  let rest=executable[4],flag:RegExpExecArray|null;
  if(['powershell','powershell.exe','pwsh','pwsh.exe'].includes(shell??'')){
    while((flag=/^-(?:NoProfile|NoLogo|NonInteractive)\s+/i.exec(rest)))rest=rest.slice(flag[0].length);
    flag=/^-Command\s+/i.exec(rest);
  }else if(['cmd','cmd.exe'].includes(shell??'')){
    while((flag=/^\/(?:d|s)\s+/i.exec(rest)))rest=rest.slice(flag[0].length);
    flag=/^\/c\s+/i.exec(rest);
  }else if(['bash','bash.exe','sh','sh.exe'].includes(shell??'')){
    flag=/^(?:--login\s+)?-(?:lc|c)\s+/.exec(rest);
  }else return;
  if(!flag)return;
  const body=rest.slice(flag[0].length);
  return body.startsWith("'")||body.startsWith('"')?quotedArgument(body):body;
}
function commandForMatching(command:string):string {
  for(let depth=0;depth<8;depth++){
    const body=unwrapCommand(command);if(body===undefined||body===command)break;
    command=body;
  }
  return command;
}

/** Command completion and the member's exit-code claim are independent observations. */
export function bindFlowEvidence(evidence:Evidence[],allEvents:TimelineEvent[],runIds:string[]):Evidence[]{
  const events=allEvents.filter(e=>runIds.includes(e.runId)&&e.fidelity==='native'&&['tool','output'].includes(e.kind));
  return evidence.map(e=>{
    if(e.kind!=='command'&&!e.commandKindInferred)return {...e,eventIds:e.eventIds.filter(id=>events.some(event=>event.id===id)),source:e.eventIds.some(id=>events.some(event=>event.id===id))?'observed':'reported'};
    const command=typeof e.command==='string'?commandForMatching(e.command):undefined;
    const starts=events.filter(event=>{const native=eventCommand(event);return typeof native==='string'&&command!==undefined&&commandForMatching(native)===command;}),completed=events.filter(end=>starts.some(start=>completes(start,end)));
    // Prefer a recorded matching invocation; otherwise keep a completion whose code is unavailable.
    const matching=e.exitCode===undefined?completed:completed.filter(event=>exitCode(event)===e.exitCode&&!(e.exitCode===0&&failed(event)));
    const unknown=completed.filter(event=>exitCode(event)===undefined&&!(e.exitCode===0&&failed(event)));
    const selected=matching.length?matching:unknown.length?unknown:completed,end=selected.at(-1),observed=end?exitCode(end):undefined;
    return {...e,eventIds:selected.map(event=>event.id),source:completed.length?'observed':'reported',
      ...(end?{executionStatus:failed(end)?'failed' as const:'completed' as const}:{}),
      ...(observed===undefined?{}:{observedExitCode:observed}),
      ...(e.exitCode===undefined?{}:{exitCodeSource:observed===e.exitCode?'observed' as const:'reported' as const})};
  });
}
