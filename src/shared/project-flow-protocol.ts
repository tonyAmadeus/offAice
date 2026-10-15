import { FLOW_CONTRACTS, contractHint } from './flow-contract';
import { FLOW_LIMITS, FlowError, type MeetingResponse, type PlanPayload, type ReviewPayload, type SubmissionPayload, type RoundReport,type ReviewFinding,type NextRoundRecommendation,type Task,type CompletionCriterion } from './project-flow';
import {rejectUserCriteria} from './project-flow-review';
import {AMBIGUOUS_FIELDS,hasInferredCommand,normalizeFlowPayload,parseCompatibleJson} from './flow-format';

const fail=(message:string):never=>{throw new FlowError('INVALID_PROTOCOL',message);};
export function object(value:unknown,keys:string[],required=keys):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))return fail('需要 JSON 对象。');
  const item=value as Record<string,unknown>;
  // Name the fields, so the one format correction knows exactly what to change.
  const extra=Object.keys(item).filter(key=>!keys.includes(key)),missing=required.filter(key=>!(key in item));
  if(extra.length||missing.length)return fail(['字段不符合结构。',extra.length?`不支持的字段：${extra.slice(0,8).join('、')}。`:'',missing.length?`缺少的字段：${missing.join('、')}。`:'',`允许的字段：${keys.join('、')}。`].filter(Boolean).join(''));return item;
}
export function payloadObject(value:unknown,kind:string){const contract=FLOW_CONTRACTS[kind];if(!contract)return fail('未知的提交用途');return object(normalizeFlowPayload(value,kind),contract.allowed,contract.required);}
export function text(value:unknown,empty=false):string { if(typeof value!=='string'||(!empty&&!value.trim())||value.length>20000)return fail('文字字段不能为空或超过长度限制。');return value.trim(); }
export function texts(value:unknown,empty=false):string[] { if(!Array.isArray(value)||(!empty&&!value.length)||value.length>FLOW_LIMITS.tasks)return fail('列表内容不正确。');return value.map(x=>text(x)); }
const bool=(value:unknown)=>{if(typeof value!=='boolean')return fail('需要明确的布尔值。');return value;};
export function parseCompletionCriteria(value:unknown):CompletionCriterion[]{
  if(!Array.isArray(value)||!value.length||value.length>100)return fail('完成标准需要非空列表。');
  const result=value.map(item=>{if(typeof item==='string')return text(item);const c=object(item,['text','kind']);if(!['check','judge','owner'].includes(String(c.kind)))return fail('标准类别只能是 check、judge 或 owner。');return {text:text(c.text),kind:c.kind as 'check'|'judge'|'owner'};});
  if(new Set(result.map(c=>typeof c==='string'?c:c.text)).size!==result.length)return fail('完成标准不能重复。');return result;
}
function assessments(value:unknown):NonNullable<ReviewPayload['assessments']>{
  if(!Array.isArray(value)||value.length>100)return fail('评价列表无效。');
  const items=value.map(raw=>{const a=object(raw,['criterion','rating','reason']);if(!['meets','partly','not'].includes(String(a.rating)))return fail('评价只能是 meets、partly 或 not。');return {criterion:text(a.criterion),rating:a.rating as 'meets'|'partly'|'not',reason:text(a.reason)};});
  if(new Set(items.map(a=>a.criterion)).size!==items.length)return fail('同一标准不能重复评价。');return items;
}
export function scopePath(value:string){const normalized=value.replaceAll('\\','/').replace(/\/$/,'');if(normalized==='.')return '.';if(!normalized||normalized.startsWith('/')||/[:*?\x00]/.test(normalized)||normalized.split('/').some(p=>!p||p==='..'||p==='.'||['.git','.airoom'].includes(p.toLowerCase())))return fail('修改范围只能是项目内明确的相对文件或目录。');return normalized;}
export const pathWithin=(file:string,scope:string)=>{const f=file.replaceAll('\\','/').toLowerCase(),s=scope.toLowerCase();return s==='.'||f===s||f.startsWith(s+'/');};
export const scopesOverlap=(a:string[],b:string[])=>a.some(x=>b.some(y=>pathWithin(x,y)||pathWithin(y,x)));
/** Find a top-level JSON object without confusing braces inside strings with object boundaries. */
function lastReplyObject(raw:string,onRepair?:()=>void):unknown {
  let start=-1,quoted=false,escaped=false,found=false,last:unknown,lastError:string|undefined;const stack:string[]=[];
  for(let i=0;i<raw.length;i++){
    const char=raw[i];
    if(start<0){if(char==='{'||char==='['){start=i;stack.push(char);quoted=false;escaped=false;}continue;}
    if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
    if(char==='"'){quoted=true;continue;}
    if(char==='{'||char==='['){stack.push(char);continue;}
    if(char!=='}'&&char!==']')continue;
    if(stack.at(-1)!==(char==='}'?'{':'['))return fail('JSON 的括号结构不完整。');
    stack.pop();if(stack.length)continue;
    const candidate=raw.slice(start,i+1);start=-1;
    // Prose after a reply may hold brackets, such as a Markdown link "[说明](a.md)", "[1]" or "{name}".
    // Only text shaped like JSON fields counts as a later reply attempt.
    const fieldLike=/"[^"\n]*"\s*:/.test(candidate);
    if(candidate[0]==='['){if(fieldLike&&/^\[\s*\{/.test(candidate))lastError='正式提交必须是 JSON 对象，不能放在数组内。';continue;}
    // An empty "{}" in later prose carries nothing and never replaces a reply found before it.
    try{const value=parseCompatibleJson(candidate);if(found&&!fieldLike)continue;last=value;found=true;lastError=undefined;}catch{if(fieldLike)lastError='最后的正式 JSON 回复有语法错误。';}
  }
  if(start>=0){
    // Only close containers. JSON.parse still rejects missing values, commas and unfinished strings.
    if(!quoted&&raw[start]==='{'){
      const tail=raw.slice(start).trim().replace(/\s*```\s*$/, '').trimEnd();
      try{last=JSON.parse(tail+[...stack].reverse().map(c=>c==='{'?'}':']').join(''));found=true;lastError=undefined;onRepair?.();}
      catch{return fail('最后的 JSON 回复不完整，请返回完整对象。');}
    }else return fail('最后的 JSON 回复不完整，请返回完整对象。');
  }
  if(lastError)return fail(lastError);
  if(!found)return fail('未找到完整 JSON 对象。');
  return last;
}
export function parseReply(raw:string,kind:string,onRepair?:()=>void):unknown {
  if(new TextEncoder().encode(raw).byteLength>FLOW_LIMITS.replyBytes)return fail('结构化回复超过 128 KiB。');
  let parsed:unknown;try{parsed=parseCompatibleJson(raw.trim());}catch{parsed=lastReplyObject(raw,onRepair);}
  const incoming=object(parsed,Object.keys(parsed&&typeof parsed==='object'?parsed:{}));
  // The dispatched operation already supplies these routing labels. Missing labels do not
  // invalidate a reply; explicit mismatches still cannot be consumed by another operation.
  if(['protocol','version','kind','payload'].some(key=>Object.hasOwn(incoming,key))){
    const payloadKeys=[...(FLOW_CONTRACTS[kind]?.allowed??[]),...(kind==='integration-check'?['report','nextRoundRecommendation']:[])];
    const envelope=object(incoming,['protocol','version','kind','payload',...payloadKeys],['payload']);
    if(envelope.payload&&typeof envelope.payload==='object'&&!Array.isArray(envelope.payload)){
      const payload={...envelope.payload as Record<string,unknown>};
      for(const key of payloadKeys.filter(key=>Object.hasOwn(envelope,key))){
        if(Object.hasOwn(payload,key)&&JSON.stringify(payload[key])!==JSON.stringify(envelope[key]))throw new FlowError(AMBIGUOUS_FIELDS,'回复内外层的 '+key+' 内容不一致，已保留原回复，请明确采用哪一份。');
        payload[key]=envelope[key];
      }
      envelope.payload=payload;
    }
    if(envelope.protocol!==undefined&&envelope.protocol!=='airoom.project-flow'||envelope.version!==undefined&&envelope.version!==1||envelope.kind!==undefined&&envelope.kind!==kind)return fail('协议名称、版本或用途不匹配。');
    return normalizeFlowPayload(envelope.payload,kind,true);
  }
  return normalizeFlowPayload(incoming,kind,true);
}
export function validatePlan(raw:unknown,memberIds:string[],notes?:string[],userName=''):PlanPayload {
  const p=payloadObject(raw,'plan');
  if(!Array.isArray(p.rounds)||!p.rounds.length||p.rounds.length>FLOW_LIMITS.rounds||!Array.isArray(p.tasks)||!p.tasks.length||p.tasks.length>FLOW_LIMITS.tasks)return fail('需要 1–20 轮和 1–200 个任务。');
  const roundKeys=new Set(p.rounds.map(value=>(value as {key?:unknown})?.key));
  const generated=(prefix:string,index:number,used:Set<unknown>)=>{let key=`${prefix}${index+1}`;while(used.has(key))key+='-auto';used.add(key);return key;};
  const rounds=p.rounds.map((value,index)=>{const r={...object(value,['key','title','goal','requiresUserAcceptance','completionCriteria','reviewLevel'],['title','goal'])};r.key??=generated('r',index,roundKeys);if(r.reviewLevel!==undefined&&!['high','medium','low'].includes(String(r.reviewLevel)))return fail('轮次复核程度无效。');return {key:text(r.key),title:text(r.title),goal:text(r.goal),requiresUserAcceptance:r.requiresUserAcceptance===undefined?true:bool(r.requiresUserAcceptance),completionCriteria:r.completionCriteria===undefined?undefined:parseCompletionCriteria(r.completionCriteria),...(r.reviewLevel===undefined?{}:{reviewLevel:r.reviewLevel as 'high'|'medium'|'low'})};});
  if(new Set(rounds.map(r=>r.key)).size!==rounds.length)return fail('轮次 key 不能重复。');if(!rounds.at(-1)!.requiresUserAcceptance)notes?.push('最后一轮固定需要用户验收。');rounds.at(-1)!.requiresUserAcceptance=true;
  const taskFields=['key','roundKey','title','memberId','goal','inputs','completionCriteria','dependencies','allowedPaths'];
  const taskKeys=new Set(p.tasks.map(value=>(value as {key?:unknown})?.key));
  const tasks=p.tasks.map((value,index)=>{const t={...object(value,[...taskFields,'reviewerMemberId','review','reuse'],['title','memberId','goal','completionCriteria','allowedPaths'])};t.key??=generated('t',index,taskKeys);if(t.roundKey===undefined&&rounds.length===1)t.roundKey=rounds[0].key;const memberId=text(t.memberId);if(!memberIds.includes(memberId))return fail('任务成员不在已选择的团队中。');const reviewerMemberId=t.reviewerMemberId===undefined?undefined:text(t.reviewerMemberId);if(reviewerMemberId&&(!memberIds.includes(reviewerMemberId)||reviewerMemberId===memberId))return fail('复核人必须是团队内另一名成员。');if(!Array.isArray(t.allowedPaths)||!t.allowedPaths.length)return fail('任务 '+text(t.key)+' 的 allowedPaths 必须至少包含一个实际要修改的项目内相对路径。只读核验使用自动复核阶段，不要新增空范围任务。');return {key:text(t.key),roundKey:text(t.roundKey),title:text(t.title),memberId,goal:text(t.goal),inputs:texts(t.inputs??[],true),completionCriteria:parseCompletionCriteria(t.completionCriteria),dependencies:texts(t.dependencies??[],true),allowedPaths:texts(t.allowedPaths).map(scopePath),...(reviewerMemberId?{reviewerMemberId}:{}),...(t.review===undefined?{}:{review:bool(t.review)}),...(t.reuse===undefined?{}:{reuse:text(t.reuse)})};});
  const byKey=new Map(tasks.map(t=>[t.key,t]));if(byKey.size!==tasks.length)return fail('任务 key 不能重复。');
  const roundIndex=new Map(rounds.map((r,i)=>[r.key,i]));
  for(const task of tasks){if(!roundIndex.has(task.roundKey))return fail('任务引用了不存在的轮次。');for(const dep of task.dependencies){const other=byKey.get(dep);if(!other||roundIndex.get(other.roundKey)!>roundIndex.get(task.roundKey)!)return fail('依赖不存在或指向未来轮次。');}}
  const visited=new Set<string>(),visiting=new Set<string>();
  const visit=(key:string)=>{if(visiting.has(key))return fail('任务依赖成环。');if(visited.has(key))return;visiting.add(key);for(const dep of byKey.get(key)!.dependencies)visit(dep);visiting.delete(key);visited.add(key);};tasks.forEach(t=>visit(t.key));
  // Add deterministic scope dependencies only after a valid explicit topological order.
  const ordered=[...visited].map(key=>byKey.get(key)!);
  for(let i=0;i<ordered.length;i++)for(let j=0;j<i;j++){const later=ordered[i],earlier=ordered[j];if(later.roundKey===earlier.roundKey&&scopesOverlap(later.allowedPaths,earlier.allowedPaths)&&!later.dependencies.includes(earlier.key)){later.dependencies.push(earlier.key);notes?.push(later.key+' 和 '+earlier.key+' 的修改范围重叠，已安排 '+later.key+' 在 '+earlier.key+' 之后。');}}
  for(const task of tasks)if(task.allowedPaths.includes('.')&&tasks.filter(t=>t.roundKey===task.roundKey).length>1)notes?.push(task.key+' 的修改范围是整个项目，会和本轮其他任务排队执行。');
  if(rounds.some(r=>!tasks.some(t=>t.roundKey===r.key)))return fail('每一轮至少需要一项任务。');
  const acceptanceCriteria=parseCompletionCriteria(p.acceptanceCriteria);rejectUserCriteria(acceptanceCriteria,userName);for(const task of tasks)rejectUserCriteria(task.completionCriteria,userName);
  for(const round of rounds){if(round.completionCriteria&&round.completionCriteria.length>5)return fail('每轮需要 1–5 条完成标准。');round.completionCriteria??=[...new Set(tasks.filter(t=>t.roundKey===round.key).flatMap(t=>t.completionCriteria))].slice(0,5);rejectUserCriteria(round.completionCriteria,userName);}
  return {objective:text(p.objective),scope:text(p.scope),deliverables:texts(p.deliverables),acceptanceCriteria,rounds,tasks};
}
function evidence(value:unknown):SubmissionPayload['evidence'] {
  if(!Array.isArray(value)||!value.length||value.length>100)return fail('提交必须附带检查依据。');
  return value.map((raw,index)=>{
    const e=object(raw,['kind','description','command','exitCode','result','eventIds','source','title','location','excerpt'],['kind']);
    if(!['command','quote','inspection','source'].includes(String(e.kind)))return fail('验证依据 kind 只能是 command、quote、inspection 或 source，收到 "'+String(e.kind).slice(0,40)+'"。');
    if(e.kind==='source'){
      const sourceText=(value:unknown,field:string)=>{try{return text(value);}catch{return fail(`evidence[${index}].${field} 必须是非空字符串，长度不超过 20000 字符。请只补正这个字段，保留原来源位置和引用原文。`);}};
      const location=absent(e.location)?'':sourceText(e.location,'location'),excerpt=absent(e.excerpt)?'':sourceText(e.excerpt,'excerpt');
      // A display label is not source evidence. Fill it from existing metadata, without a model call.
      const missingTitle=e.title==null||typeof e.title==='string'&&!e.title.trim();
      const title=sourceText(missingTitle?(typeof e.description==='string'&&e.description.trim()?e.description:location||'未完整标注的来源'):e.title,'title');
      if(/^[a-z]+:/i.test(location)&&!/^[a-z]:[\\/]/i.test(location)){try{if(!['http:','https:'].includes(new URL(location).protocol))return fail('来源链接只支持 http 或 https。');}catch{return fail('来源链接无效。');}}
      return {kind:'source' as const,title,location,excerpt,description:e.description===undefined?title:text(e.description),result:e.result===undefined?excerpt:text(e.result),eventIds:e.eventIds===undefined?[]:texts(e.eventIds,true),source:'reported' as const,sourceVerification:'unverified' as const,sourceNote:'尚未核对来源和引用。'};
    }
    if(e.kind==='command'&&!e.command||e.exitCode!==undefined&&(typeof e.exitCode!=='number'||!Number.isSafeInteger(e.exitCode))||e.source!==undefined&&!['observed','reported'].includes(String(e.source)))return fail('命令依据需要命令文本，退出码必须是整数。');
    return {kind:e.kind as 'command'|'quote'|'inspection',description:text(e.description),result:text(e.result),...(e.command!==undefined?{command:text(e.command)}:{}),...(hasInferredCommand(e)?{commandKindInferred:true as const}:{}),...(e.exitCode!==undefined?{exitCode:e.exitCode as number}:{}),eventIds:e.eventIds===undefined?[]:texts(e.eventIds,true),source:'reported' as const};
  });
}
function criteria(value:unknown,allowEmpty=false){if(!Array.isArray(value)||!allowEmpty&&!value.length||value.length>100)return fail('需要逐项核对完成标准。');return value.map(x=>{const c=object(x,['criterion','verified','evidence']);return {criterion:text(c.criterion),verified:bool(c.verified),evidence:text(c.evidence,true)};});}
const absent=(value:unknown)=>value==null||typeof value==='string'&&!value.trim();
function submissionSummary(p:Record<string,unknown>,notes:string[]){
  if(!absent(p.summary))return text(p.summary);
  if(typeof p.userSummary==='string'&&p.userSummary.trim()){notes.push('未单独填写成果摘要，沿用成员已有说明。');return text(p.userSummary);}
  if(!Object.values(p).some(value=>typeof value==='string'?Boolean(value.trim()):Array.isArray(value)&&value.length))return fail('成果回复没有可保留的正文或记录。');
  notes.push('成员未单独填写成果说明；请结合实际文件和复核记录查看。');
  return '成员已提交记录，未单独填写成果说明。';
}
export function validateSubmission(raw:unknown):SubmissionPayload {
  const p=object(normalizeFlowPayload(raw,'submission'),FLOW_CONTRACTS.submission.allowed,[]),replyNotes:string[]=[];
  const summary=submissionSummary(p,replyNotes),items=p.evidence??[];
  if(Array.isArray(items)&&!items.length)replyNotes.push('未单独提供检查依据，成果保留，完成情况由后续复核或用户验收确认。');
  let disputes:SubmissionPayload['disputes'];if(p.disputes!==undefined){if(!Array.isArray(p.disputes)||p.disputes.length>100)return fail('异议列表无效。');disputes=p.disputes.map(raw=>{const d=object(raw,['findingId','reason']);return {findingId:text(d.findingId),reason:text(d.reason)};});if(new Set(disputes.map(d=>d.findingId)).size!==disputes.length)return fail('同一问题不能重复提出异议。');}
  return {...(typeof p.userSummary==='string'&&p.userSummary.trim()?{userSummary:p.userSummary.trim().slice(0,2000)}:{}),summary,evidence:Array.isArray(items)&&!items.length?[]:evidence(items),completionResults:criteria(p.completionResults??[],true),...(replyNotes.length?{replyNotes}:{}),...(disputes?{disputes}:{}),...(p.outOfScopeExplanation!==undefined?{outOfScopeExplanation:text(p.outOfScopeExplanation,true)}:{})};
}
export function validateReview(raw:unknown,requiredCriteria:string[],previous:ReviewFinding[]=[]):ReviewPayload {
  const supplied=object(normalizeFlowPayload(raw,'review'),FLOW_CONTRACTS.review.allowed,[]);
  // Missing fields are tolerated below; a reply with no fields at all has nothing to keep.
  if(!Object.keys(supplied).length)return fail('复核回复是空对象，没有结论、问题或依据。');
  // Absence means no reported check, never a successful check. assessReview evaluates the
  // actual required criteria and evidence separately from accepting this readable reply.
  const p:Record<string,unknown>={verdict:'inconclusive',verificationComplete:false,criteriaResults:[],findings:[],evidence:[],...supplied};
  if(!['pass','changes_requested','inconclusive'].includes(String(p.verdict)))return fail('复核结论无效。');if(!Array.isArray(p.findings)||p.findings.length>FLOW_LIMITS.findings)return fail('问题清单无效。');
  const findings:ReviewPayload['findings']=p.findings.map(x=>{const fields=['location','kind','severity','evidence','request'],f=object(x,[...fields,'previousFindingId'],fields);if(!['verified','suspected','suggestion'].includes(String(f.kind))||!['blocking','should-fix','optional'].includes(String(f.severity)))return fail('问题类型或严重程度无效。');const previousFindingId=f.previousFindingId===undefined?undefined:text(f.previousFindingId);if(previousFindingId&&!previous.some(f=>f.id===previousFindingId))return fail('previousFindingId 必须引用材料中的上次问题。');return {location:text(f.location),kind:f.kind as 'verified'|'suspected'|'suggestion',severity:f.severity as 'blocking'|'should-fix'|'optional',evidence:text(f.evidence,f.kind!=='verified'),request:text(f.request,true),...(previousFindingId?{previousFindingId}:{})};});
  let previousFindingChecks:ReviewPayload['previousFindingChecks'];if(p.previousFindingChecks!==undefined){if(!Array.isArray(p.previousFindingChecks)||p.previousFindingChecks.length>100)return fail('旧问题核对列表无效。');previousFindingChecks=p.previousFindingChecks.map(raw=>{const c=object(raw,['findingId','resolved','evidence']);return {findingId:text(c.findingId),resolved:bool(c.resolved),evidence:text(c.evidence,true)};});}
  if(previousFindingChecks&&new Set(previousFindingChecks.map(c=>c.findingId)).size!==previousFindingChecks.length)return fail('旧问题核对不能重复引用 findingId。');
  if(previousFindingChecks?.some(c=>!previous.some(f=>f.id===c.findingId)))return fail('旧问题核对不能引用不存在的 findingId。');
  if(!previous.length&&previousFindingChecks?.length)return fail('首次复核不能引用不存在的旧问题。');
  for(const finding of findings){const old=previous.find(f=>f.id===finding.previousFindingId||finding.location!=='未注明位置'&&Boolean(finding.request)&&f.location===finding.location&&f.request===finding.request);if(old)finding.previousFindingId=old.id;}
  for(const check of previousFindingChecks??[])if(!check.resolved&&check.evidence&&!findings.some(f=>f.previousFindingId===check.findingId)){const old=previous.find(f=>f.id===check.findingId);if(old)findings.push({location:old.location,kind:old.kind,severity:old.severity,evidence:check.evidence,request:old.request,previousFindingId:old.id});}
  return {verdict:p.verdict as ReviewPayload['verdict'],verificationComplete:bool(p.verificationComplete),criteriaResults:criteria(p.criteriaResults,true),findings,evidence:Array.isArray(p.evidence)&&p.evidence.length===0?[]:evidence(p.evidence),...(previousFindingChecks?{previousFindingChecks}:{}),...(p.assessments===undefined?{}:{assessments:assessments(p.assessments)}),...(p.strengths===undefined?{}:{strengths:texts(p.strengths,true)})};
}
export function validateReport(raw:unknown,taskKeys:string[]=[]):RoundReport {const p=object(normalizeFlowPayload(raw,'round-report'),FLOW_CONTRACTS['round-report'].allowed,[]),replyNotes:string[]=[];
  const summary=submissionSummary(p,replyNotes);
  if(p.completedTaskKeys==null)replyNotes.push('未单独列出任务编号，已按本轮实际任务记录关联。');
  if(p.deliverables==null)replyNotes.push('未单独列出交付物，请查看本轮实际文件改动。');
  let meetingResponses:MeetingResponse[]|undefined;
  if(p.meetingResponses!==undefined){if(!Array.isArray(p.meetingResponses)||p.meetingResponses.length>200)return fail('会议要求处理列表无效。');meetingResponses=p.meetingResponses.map(raw=>{const item=object(raw,['messageId','disposition','summary','paths']);if(!['noted','answered','in-scope-fix','scope-change','needs-user'].includes(String(item.disposition)))return fail('会议要求处理方式无效。');return {messageId:text(item.messageId),disposition:item.disposition as MeetingResponse['disposition'],summary:text(item.summary),paths:texts(item.paths??[],true).map(scopePath)};});}
  return {summary,completedTaskKeys:texts(p.completedTaskKeys??taskKeys,true),deliverables:texts(p.deliverables??[],true),validationSummary:absent(p.validationSummary)?'成员未单独提供验证说明，请以本轮实际复核记录为准。':text(p.validationSummary),remainingIssues:texts(p.remainingIssues??[],true),nextRoundSummary:text(p.nextRoundSummary??'',true),userDecisionNeeded:text(p.userDecisionNeeded??'',true),...(replyNotes.length?{replyNotes}:{}),...(meetingResponses?{meetingResponses}:{})};}
export function validateNextRound(raw:unknown,tasks:Task[],userName=''):NextRoundRecommendation {
  const p={...payloadObject(raw,'next-round')};p.taskAdjustments??=[];
  if(!['as-planned','adjusted','replan'].includes(String(p.mode))||!Array.isArray(p.taskAdjustments)||p.taskAdjustments.length>FLOW_LIMITS.tasks)return fail('下一轮建议结构无效。');
  const taskAdjustments=p.taskAdjustments.map(raw=>{const a=object(raw,['taskId','goal','inputs','completionCriteria'],['taskId']),taskId=text(a.taskId),task=tasks.find(t=>t.id===taskId);
    if(!task)return fail('轻量调整只能引用下一轮已有任务。');
    if(!['pending','ready'].includes(task.status)||task.sessionId||task.latestSubmissionId)return fail('已经开工的任务保留原要求，不能通过下一轮确认改写。');
    if(a.goal===undefined&&a.inputs===undefined&&a.completionCriteria===undefined)return fail('任务调整至少需要一项具体修改。');
    const completionCriteria=a.completionCriteria===undefined?undefined:parseCompletionCriteria(a.completionCriteria);if(completionCriteria)rejectUserCriteria(completionCriteria,userName);
    return {taskId,...(a.goal===undefined?{}:{goal:text(a.goal)}),...(a.inputs===undefined?{}:{inputs:texts(a.inputs,true)}),...(completionCriteria?{completionCriteria}:{})};
  });
  if(new Set(taskAdjustments.map(a=>a.taskId)).size!==taskAdjustments.length)return fail('同一任务不能重复调整。');
  const completionCriteria=p.completionCriteria===undefined?undefined:parseCompletionCriteria(p.completionCriteria);if(completionCriteria){if(completionCriteria.length>5)return fail('每轮应有 1–5 条完成标准。');rejectUserCriteria(completionCriteria,userName);}
  if(p.mode!=='adjusted'&&(taskAdjustments.length||completionCriteria)||p.mode==='adjusted'&&!taskAdjustments.length&&!completionCriteria)return fail('按原计划或修改方案不能包含轻量修改；按调整开始需要具体调整。');
  return {mode:p.mode as NextRoundRecommendation['mode'],summary:p.mode==='as-planned'?'按原计划':text(p.summary),taskAdjustments,...(completionCriteria?{completionCriteria}:{})};
}
/** Members only see an example payload; the fixed values are spelled out so a reply does not invent its own (2026-10-06: a submission used evidence kind "tool"). */
export const FLOW_FIELD_RULES='固定取值：evidence[].kind 只能是 command（实际运行过的命令，必须填 command）、quote（引用的文件原文）、inspection（查看、读写文件或用工具检查的结果）或 source（来源原文，须带 location、excerpt，title 可选）；verdict 只能是 pass、changes_requested 或 inconclusive；findings[].kind 只能是 verified、suspected 或 suggestion；findings[].severity 只能是 blocking、should-fix 或 optional。不要使用其他取值。kind 为 command 时，command 必须逐字填写你实际运行过的命令，不能概括或改写；概括的检查、读写文件或没有实际运行的命令，请用 inspection。findings 的必填字段是 location（问题位置）、kind、severity、evidence（依据）；blocking 和 should-fix 还须 request（修改要求），optional 的观察没有修改要求时可省略 request；旧问题可加 previousFindingId 引用材料中的 id，不要加 title、detail 等其他字段。';
export const FLOW_CRITERIA_RULES='方案、任务追加、重新安排和下一轮调整中的 acceptanceCriteria、completionCriteria 每项使用 {"text":"标准原文","kind":"check"} 对象，kind 只能是 check、judge 或 owner。例如 {"text":"文件内容符合要求","kind":"check"}、{"text":"表达清楚","kind":"judge"}、{"text":"用户确认最终成果","kind":"owner"}。不要写成 "owner: 用户确认" 或 "judge：表达清楚" 这样的字符串；字符串只兼容旧版 check，不会读取冒号前的类别。提交或复核结果里的 criterion 只填对应 text 原文，不带类别前缀。';
function stageStructure(kind:string){
  const optional='无内容的可选列表和备注可以省略。不要为填格式编造内容。';
  if(kind==='plan')return optional+' rounds 每项 {key?:string,title:string,goal:string,requiresUserAcceptance?:boolean,completionCriteria?:数组}；tasks 每项 {key?:string,roundKey?:string,title:string,memberId:string,goal:string,inputs?:string[],completionCriteria:数组,dependencies?:string[],allowedPaths:string[],reviewerMemberId?:string,review?:boolean,reuse?:string}。省略的 key 由程序生成；只有一轮时 roundKey 可省略；有依赖时明确填写被引用任务的 key。每个任务的 allowedPaths 必须非空；deliverables 必须非空，不为只读核验编造写入路径。只读检查使用系统自动阶段，不要另建空范围任务。';
  if(kind==='joint-summary')return optional+' 引用可用 findingIndex（从 1 开始）或 findingIndexes 替代长编号。';
  if(kind==='author-response')return optional+' responses 每项 {findingId?:string,stance:agree|dispute|fixed-new-version,reason:string,evidence?:string,newSubmissionId?:string}。可以用 findingIndex（从 1 开始）代替编号；同意时 evidence 可省略，反对必须有依据。';
  if(kind==='verification')return optional+' outcome 只能是 confirmed、refuted 或 inconclusive。findingIds 可省略，程序按本次派发范围绑定，显式填写时仍逐项核对。confirmed/refuted 必须有真实 evidence。';
  if(kind==='submission')return optional+' completionResults 每项 {criterion:string,verified:boolean,evidence:string}；disputes 每项 {findingId:string,reason:string}，只引用 fixes 中的真实问题；已有 disputeRulings 必须遵守，不得继续要求修改已裁定支持作者的同一问题。';
  if(kind==='round-report')return optional+' meetingResponses 每项 {messageId:string,disposition:noted|answered|in-scope-fix|scope-change|needs-user,summary:string,paths:string[]}，逐条对应 pendingUserMessages，不编造已完成的修改。';
  if(kind==='next-round')return optional+' mode 只能是 as-planned、adjusted 或 replan；taskAdjustments 每项 {taskId:string,goal?:string,inputs?:string[],completionCriteria?:数组}，只能引用未开工的现有任务。';
  if(kind==='task-addition')return optional+' completionCriteria 为标准数组，allowedPaths 为非空相对路径数组，inScope 为布尔值，scopeReason 说明范围判断。不自行执行任务。';
  if(kind==='task-rearrange')return optional+' memberId 只选材料提供的实际成员；goal、reason 为字符串，completionCriteria 为标准数组；不能扩大路径范围或重置退回次数。';
  if(kind==='adjudication')return optional+' rulings 每项 {findingId:string,verdict:uphold-author|uphold-review|inconclusive,reason:string}，逐条裁定提供的 disputes；只核实异议，不修改作者版本。';
  if(kind==='joint-independent'||kind==='joint-peer')return optional+' unverifiedItems 为字符串数组；findings 每项 {location:string,kind:verified|suspected|suggestion,severity:blocking|should-fix|optional,evidence:string,request?:string'+(kind==='joint-peer'?',candidate:string（这条问题针对的方案字母）':'')+'}。未单列修改建议可省略 request；无法确认是否属实时用 suspected，依据不足时写明未核实，不为填满字段编造信息。';
  return optional+' findings 每项 {location:string,kind:verified|suspected|suggestion,severity:blocking|should-fix|optional,evidence:string,request:string,previousFindingId?:string}；criteriaResults/completionResults 每项 {criterion:string,verified:boolean,evidence:string}；evidence 每项 {kind,description:string,result:string,command?:string,exitCode?:number,eventIds?:string[]}。';
}
export const FLOW_EVIDENCE_RULES='evidence 每项 {kind,description:string,result:string,command?:string,exitCode?:number,eventIds?:string[]}；kind 只能是 command、quote、inspection 或 source。command 必须逐字填写实际运行的命令，不概括；未运行命令的查看、读写或检查使用 inspection。inspection、quote 的 description 和 result 可只填其中已有完整观察的一项，应用原样沿用，不新增核实声明。source 必须填 location、excerpt；title 为可选的展示标题，省略时沿用已有 description 或来源位置，不另行编造；核对原文与引用；外部来源不可访问时明确未核实，不伪造，也不只因这一点判不通过。本机引用按原文核对。exitCode 仅在工具实际提供数字退出码时填写；工具没有提供则省略，不要猜测。工具标记 completed 只表示命令已完成，不代表退出码为 0 或验证成功。';
const reviewStages=new Set(['review','integration-check','peer-review','requested-check']);
const planningStages=new Set(['plan','task-addition','task-rearrange','next-round']);
const REVIEW_DECISION_RULES='check 类逐条填写 criteriaResults；judge 类写 assessments:[{criterion,rating:meets|partly|not,reason}]，不要求 verified；owner 与 deferredUserCriteria 留待用户验收，成员不判断。首次退回 changes_requested 必须有已核实的 blocking 或 should-fix 问题；judge 只有 not 并有具体问题才退回，meets 和 partly 不阻塞，partly 理由保留为建议。仅有 optional 问题且必要标准已核实时判 pass，并保留建议。再次复核先逐条填写 previousFindingChecks:[{findingId,resolved,evidence}] 对应 previousFindings；漏项、依据为空或 evidence 为空只能 inconclusive，不能靠补正补造检查事实。旧问题未解决可退回；新发现的只有 blocking 才能再次退回，新的 should-fix 和 optional 作为建议，必要标准已核实时判 pass。已有 disputeRulings 必须遵守，不得继续要求修改已裁定支持作者的同一问题。缺材料记为 suspected，查明真实缺陷才记 verified；非阻塞的 suspected should-fix 作为建议，不阻塞必要标准已核实时的 pass；疑似 blocking 未查明为 inconclusive。';
function stagePolicy(kind:string,fields:unknown){
  const allowed=FLOW_CONTRACTS[kind]?.allowed??[];
  const rules=[allowed.includes('evidence')?FLOW_EVIDENCE_RULES:''];
  if(reviewStages.has(kind))rules.push('verdict 只能是 pass、changes_requested 或 inconclusive。findings 不加 title、detail 等其他字段；旧问题可用 previousFindingId 引用材料中的真实 id。',REVIEW_DECISION_RULES);
  if(planningStages.has(kind))rules.push(FLOW_CRITERIA_RULES,'check 为可核对事实、judge 由成员评价、owner 由用户决定。completionCriteria 不能仅重复本轮目标；涉及用户确认或验收的标准必须标成 owner；产品界面、文档行为可以作为标准。需要用户在真实浏览器/设备中亲自操作、而执行成员没有相应工具的实操验收标为 owner；可通过代码、命令或自动化测试核对的产品行为仍为 check，不能一概转给用户。');
  if(kind==='submission')rules.push('check 类逐条填写 completionResults；judge 由成员评价，不因没有 verified 判无法下结论；owner 留待用户验收，不要求成员验证用户已同意。');
  if(kind==='joint-independent'||kind==='joint-peer')rules.push('问题只使用所列 findings 字段，不加 title、detail 或自行生成 id；缺材料记 suspected，查明真实缺陷才记 verified；不要把建议或未核实事项编造成已核实问题。');
  if(fields&&typeof fields==='object'&&'nextRoundRecommendation' in fields)rules.push(FLOW_CRITERIA_RULES);
  return rules.filter(Boolean).join('\n');
}
export const flowPrompt=(kind:string,fields:unknown,context:unknown)=>`只返回 JSON：${JSON.stringify({protocol:'airoom.project-flow',version:1,kind,payload:fields})}
这是程序接收的工作提交。最终回复只含上述 JSON 对象，不加角色台词、动作描写、问候、解释或 Markdown 围栏。所有成员都遵守同一提交格式。
${contractHint(kind)}
${(FLOW_CONTRACTS[kind]?.allowed??[]).filter(key=>['summary','userSummary','proposal','synthesis'].includes(key)).join('、')||'给用户看的文字字段'}及交付文件的正文写成可直接阅读的中文成稿；不要混入校验过程、运行记录、内部编号、协议字段、材料指纹或追溯信息。程序要求的证据与检查信息只放各自结构字段。上述文字字段必须是字符串；长方案可在字符串内使用 Markdown，不要写成对象。
${kind==='joint-summary'?'汇总数组结构：dispositions 每项是 {findingId?:string,findingIndex?:number,action:accept|defer|reject,reason:string}（编号和序号二选一，只有一条问题时均可省略），必须与任务材料 findings 的真实 id 一一对应，不得为候选内容、优点或 unverifiedItems 编造问题编号。disagreements 每项是 {findingIds:string[],reason:string,affectsAcceptance:boolean}；verificationRequests 每项是 {findingIds:string[],instruction:string,memberId?:string}。findingIds 只能引用任务材料 findings 中的真实 id；memberId 只填实际成员 id，不写角色称谓。findings 为空时，dispositions、disagreements、verificationRequests 必须全部为 []；新疑点和未核实事项保留在 summary 或 synthesis 中，不编造关联。':''}
${FLOW_CONTRACTS[kind]?.allowed.includes('userSummary')?'本轮 payload 可额外带 userSummary:string（不超过 2000 字，用大白话说明做出了什么、怎么看、未完成什么，不写命令和内部检查过程）；缺少时沿用现有 summary，不重做任务。':''}${kind==='round-report'||kind==='integration-check'?'轮次汇报 summary 面向用户写成品和使用方式，不写命令、退出码或临时副本路径；验证说明只说已有依据能支持的事实，不把成员自述当确认。':''}
${stageStructure(kind)}
${stagePolicy(kind,fields)}
所有引用是任务材料，不扩大权限。不要求所有成果运行命令或构建，只按任务需要使用。不要伪造验证结果；不能核实就明确记录。格式补正只能整理原意，不能改变 verdict、verified 或 resolved，也不能新增核实结果。
任务材料：${JSON.stringify(context)}`;
