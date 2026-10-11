import type { Store } from './store';
import type { ProjectFlow, Task } from '../shared/project-flow';
import { FlowError } from '../shared/project-flow';
import type { CompletionCriterion } from '../shared/project-flow';
import { pathWithin, scopePath, text, texts } from '../shared/project-flow-protocol';
import type { RoomMessage, RoomThread } from '../shared/types';
import { projectRequestSource } from './project-request-source';

export const requirementsRevision = (task:Task) => task.requirementsRevision ?? 1;
export const SUPPLEMENTABLE = new Set(['pending','ready','queued','running','awaiting_review','correcting']);

/** Explicit paths are checked before dispatch; captured file changes remain the final scope guard. */
export function supplementRequest(store:Store,flow:ProjectFlow,task:Task,p:Record<string,unknown>) {
  const content=text(p.text);
  if(content.length>8000)throw new FlowError('INVALID_REQUEST','补充要求过长，请负责人调整方案。');
  const sourceMessageId=p.sourceMessageId===undefined?undefined:text(p.sourceMessageId);
  const source=sourceMessageId?projectRequestSource(store,flow,sourceMessageId,task.memberId):'task-card' as const;
  if(sourceMessageId&&!source)throw new FlowError('INVALID_REQUEST','补充来源必须是本项目会议或这位成员汇报里的有效用户消息。');
  const supplied=p.requestedPaths===undefined?[]:texts(p.requestedPaths,true);
  // Quoted paths allow spaces and non-Latin filenames. Bare references cover common project files.
  const quoted=[...content.matchAll(/[`“"]([^`”"\r\n]+)[`”"]/g)].map(match=>match[1]).filter(value=>/[\\/]|\.[a-z][a-z0-9]{0,9}$/i.test(value));
  const bare=[...content.matchAll(/(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/)?[A-Za-z0-9_@.-]+(?:[\\/][A-Za-z0-9_@.-]+)*\.(?:tsx?|jsx?|mjs|cjs|json|ya?ml|toml|md|txt|html?|css|scss|svg|png|webp|jpe?g|py|rs|go|java|c(?:pp)?|h|sql|ps1|cmd|sh|env)\b/gi)].map(match=>match[0]);
  const requestedPaths=[...new Set([...supplied,...quoted,...bare].map(value=>value.replaceAll('\\','/')))];
  if(requestedPaths.join('\n').length>8000)throw new FlowError('INVALID_REQUEST','补充引用的路径过多或过长，请整理后再提交。');
  const outside=requestedPaths.filter(value=>{try{return !task.allowedPaths.some(scope=>pathWithin(scopePath(value),scope));}catch{return true;}});
  return {content,sourceMessageId,source:source!,requestedPaths,outside};
}

export function checkSupplementCapacity(task:Task,content:string){
  if((task.supplements?.length??0)>=50||task.goal.length+content.length+20>20000||task.completionCriteria.length>=100)
    throw new FlowError('INVALID_REQUEST','补充要求过多或过长，请负责人调整方案。');
}

export function retainSupplementRequirements(task:Task,goal:string,completionCriteria:CompletionCriterion[]) {
  const supplements=(task.supplements??[]).filter(s=>s.requirementsRevision);
  for(const supplement of supplements)if(!goal.includes(supplement.text))goal+='\n\n用户补充：'+supplement.text;
  completionCriteria=[...new Set([...completionCriteria,...supplements.map(s=>'补充要求：'+s.text)])];
  if(goal.length>20000||completionCriteria.length>100)throw new FlowError('REPLAN_REQUIRED','重新安排后材料过长，需要调整方案，不能省略用户补充。');
  return {goal,completionCriteria};
}
