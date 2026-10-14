import { FlowError, type ReviewFinding } from './project-flow';
import { object, text, texts, validateReview, payloadObject } from './project-flow-protocol';
import {assertReviewMeaning} from './project-flow-review';
import {normalizeFlowPayload,retainCommandProvenance} from './flow-format';
import type { AuthorResponse, JointDisposition, JointDisagreement, JointOpinion, JointSummary, JointVerification, JointVerificationRequest } from './joint-review';

function invalid(message:string):never{throw new FlowError('INVALID_PROTOCOL',message);}
function jointText(p:Record<string,unknown>,key:string,empty=false){
  try{return text(p[key],empty);}catch{invalid(`文字字段 ${key} 必须是${empty?'':'非空'}字符串，长度不超过 20000 字符；只修正此字段的格式，其他内容保持原样。`);}
}
/** Serialize structured prose losslessly, without asking a model to rewrite the proposal. */
export function normalizeJointReply(raw:unknown):unknown{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return raw;
  const value={...raw as Record<string,unknown>};
  for(const key of ['proposal','synthesis'])if(value[key]&&typeof value[key]==='object')value[key]=JSON.stringify(value[key],null,2);
  if(value.summary==null||typeof value.summary==='string'&&!value.summary.trim()){
    const body=['proposal','synthesis','userSummary'].map(key=>value[key]).find(item=>typeof item==='string'&&item.trim());
    if(body!==undefined)value.summary=body;
  }
  return value;
}
/** Formatting cannot replace already-valid prose. Retain the actual original, even if the
 * correction paraphrases it; decisions, issues and evidence still pass the strict guard. */
export function retainJointText(original:unknown,corrected:unknown):unknown{
  const prior=normalizeJointReply(original),next=normalizeJointReply(corrected);
  if(!prior||typeof prior!=='object'||!next||typeof next!=='object')return next;
  const result={...next as Record<string,unknown>};
  for(const key of ['summary','userSummary','proposal','synthesis']){
    const value=(prior as Record<string,unknown>)[key];
    if(typeof value==='string'&&value.length<=20000&&(value.trim()||key==='userSummary'))result[key]=value;
  }
  const findings=(prior as Record<string,unknown>).findings;
  if(Array.isArray(findings)&&Array.isArray(result.findings))result.findings=result.findings.map((value,index)=>{
    if(!value||typeof value!=='object'||Array.isArray(value))return value;
    const next={...value},before=findings[index];delete (next as Record<string,unknown>).candidate;
    if(before&&typeof before.candidate==='string'&&before.candidate.trim())Object.assign(next,{candidate:before.candidate});
    return next;
  });
  return retainCommandProvenance(prior,result);
}
function userSummary(p:Record<string,unknown>){if(p.userSummary===undefined)return {};const value=jointText(p,'userSummary',true).slice(0,2000);return value?{userSummary:value}:{};}
function exactIds(ids:string[],expected:string[],message:string){if(ids.length!==expected.length||new Set(ids).size!==ids.length||ids.some(id=>!expected.includes(id)))invalid(message);}
function reference(item:Record<string,unknown>,findings:ReviewFinding[],plural=false){
  const key=plural?'findingIds':'findingId',indexKey=plural?'findingIndexes':'findingIndex';
  if(item[key]!==undefined&&item[indexKey]!==undefined)invalid('问题编号和序号不能同时填写。');
  if(item[indexKey]!==undefined){
    const indexes=plural?item[indexKey]:[item[indexKey]];
    if(!Array.isArray(indexes)||indexes.some(i=>!Number.isInteger(i)||Number(i)<1||Number(i)>findings.length))invalid('问题序号不在本次材料中。');
    const ids=indexes.map(i=>findings[Number(i)-1].id);return plural?ids:ids[0];
  }
  return item[key]??(!plural&&findings.length===1?findings[0].id:undefined);
}
function findingIds(value:unknown,findings:ReviewFinding[]){const ids=texts(value);if(new Set(ids).size!==ids.length||ids.some(id=>!findings.some(f=>f.id===id)))invalid('只能引用本次评审的问题编号，不能重复。');return ids;}
/** A readable opinion survives incomplete metadata. Explicit claims remain the member's
 * claims; absent classification or proof is identified, never upgraded to verification. */
export function validateJointOpinion(raw:unknown,options:{candidate?:boolean}={}):JointOpinion{
  const p=payloadObject(normalizeJointReply(normalizeFlowPayload(raw,'joint-independent')),'joint-independent'),unverifiedItems=texts(p.unverifiedItems??[],true),replyNotes:string[]=[];
  const values=p.findings??[];if(!Array.isArray(values)||values.length>100)invalid('问题清单无效。');
  const missing=(value:unknown)=>value==null||typeof value==='string'&&!value.trim();
  const findings:ReviewFinding[]=values.map((value,index)=>{
    const f=object(value,['location','kind','severity','evidence','request','previousFindingId','candidate'],[]),label=`第 ${index+1} 条意见`,kind=missing(f.kind)?'suspected':f.kind,severity=missing(f.severity)?'optional':f.severity;
    if(!['verified','suspected','suggestion'].includes(String(kind))||!['blocking','should-fix','optional'].includes(String(severity)))invalid('问题类型或严重程度无效。');
    if(f.previousFindingId!==undefined)invalid('圆桌独立意见不能引用未派发的上次问题。');
    if(missing(f.kind))unverifiedItems.push(label+'未注明是否已经证实，暂按待核实意见保留。');
    if(missing(f.severity))unverifiedItems.push(label+'未注明严重程度，系统未将其自动作为阻塞条件；仍需核对。');
    if(missing(f.evidence)&&kind==='verified')unverifiedItems.push(label+'声称已证实但未提供依据，保留原判断，尚未核实。');
    if(missing(f.request)&&severity!=='optional')replyNotes.push(label+'未单列修改建议，原问题和严重程度已保留。');
    return {id:`pending-${index}`,location:missing(f.location)?'未注明位置':text(f.location),kind:kind as ReviewFinding['kind'],severity:severity as ReviewFinding['severity'],evidence:missing(f.evidence)?'':text(f.evidence),request:missing(f.request)?'':text(f.request),...(f.previousFindingId===undefined?{}:{previousFindingId:text(f.previousFindingId)}),...(typeof f.candidate==='string'&&f.candidate.trim()?{candidate:f.candidate.trim().slice(0,8)}:{})};
  });
  const evidence=validateReview({verdict:'inconclusive',verificationComplete:false,criteriaResults:[],findings:[],evidence:p.evidence??[]},[]).evidence;
  const summary=jointText(p,'summary'),proposal=p.proposal===undefined?options.candidate?summary:undefined:jointText(p,'proposal');
  if(options.candidate&&p.proposal===undefined)unverifiedItems.push('未单列候选正文，已将成员实际答复原文保留为候选；未补写或扩充内容。');
  return {summary,...userSummary(p),...(proposal===undefined?{}:{proposal}),findings,unverifiedItems:[...new Set(unverifiedItems)],evidence,...(replyNotes.length?{replyNotes}:{})};
}
export function validateAuthorResponse(raw:unknown,findings:ReviewFinding[]):AuthorResponse[]{
  const p=payloadObject(raw,'author-response');if(!Array.isArray(p.responses)||p.responses.length>100)invalid('作者答复列表无效。');
  const result=p.responses.map(raw=>{const r=object(raw,['findingId','findingIndex','stance','reason','evidence','newSubmissionId'],['stance','reason']),stance=text(r.stance);
    if(!['agree','dispute','fixed-new-version'].includes(stance))invalid('作者只能同意、附依据反对、或引用新版本修复。');
    const evidence=text(r.evidence??(stance==='agree'?'':undefined),stance==='agree');if(stance==='fixed-new-version'&&!r.newSubmissionId)invalid('已在新版本修复必须引用已保存的新提交。');
    if(stance!=='fixed-new-version'&&r.newSubmissionId!==undefined)invalid('只有新版本修复可引用 newSubmissionId。');
    return {findingId:text(reference(r,findings)),stance:stance as AuthorResponse['stance'],reason:text(r.reason),evidence,...(r.newSubmissionId===undefined?{}:{newSubmissionId:text(r.newSubmissionId)})};});
  exactIds(result.map(r=>r.findingId),findings.map(f=>f.id),'作者必须对每条问题答复一次，不能遗漏或重复。');return result;
}
export function validateJointSummary(raw:unknown,findings:ReviewFinding[],candidateSlotIds:string[]):JointSummary{
  const p={...payloadObject(normalizeJointReply(normalizeFlowPayload(raw,'joint-summary')),'joint-summary')},replyNotes:string[]=[];p.dispositions??=[];p.disagreements??=[];p.verificationRequests??=[];
  if(!Array.isArray(p.dispositions)||!Array.isArray(p.disagreements)||!Array.isArray(p.verificationRequests)||p.dispositions.length>100||p.disagreements.length>100||p.verificationRequests.length>100)invalid('汇总列表无效。');
  const dispositions:JointDisposition[]=p.dispositions.map(raw=>{const d=object(raw,['findingId','findingIndex','action','reason'],[]),action=d.action==null?'defer':text(d.action),findingId=text(reference(d,findings));if(!['accept','defer','reject'].includes(action))invalid('问题处置只能是 accept、defer、reject。');if(d.action==null||d.reason==null||typeof d.reason==='string'&&!d.reason.trim())replyNotes.push('问题 '+(findings.findIndex(f=>f.id===findingId)+1)+' 的处置说明不完整，保留原问题待补充。');return {findingId,action:action as JointDisposition['action'],reason:d.reason==null||typeof d.reason==='string'&&!d.reason.trim()?'汇总未提供处置理由，原问题保留待补充。':text(d.reason)};});
  const missing=findings.filter(f=>!dispositions.some(d=>d.findingId===f.id));
  if(missing.length){replyNotes.push(`汇总未逐项说明 ${missing.length} 条问题的处置，未说明的项目已保留为待定。`);dispositions.push(...missing.map(f=>({findingId:f.id,action:'defer' as const,reason:'汇总未提供这条问题的处置，原问题保留待补充。'})));}
  exactIds(dispositions.map(d=>d.findingId),findings.map(f=>f.id),'每条问题必须有且只有一项处置及理由。');
  const disagreements:JointDisagreement[]=p.disagreements.map(raw=>{const d=object(raw,['findingIds','findingIndexes','reason','affectsAcceptance'],['reason','affectsAcceptance']);if(typeof d.affectsAcceptance!=='boolean')invalid('是否影响验收必须是布尔值。');return {findingIds:findingIds(reference(d,findings,true),findings),reason:text(d.reason),affectsAcceptance:d.affectsAcceptance};});
  const verificationRequests:JointVerificationRequest[]=p.verificationRequests.map(raw=>{const v=object(raw,['findingIds','findingIndexes','instruction','memberId'],['instruction']);return {findingIds:findingIds(reference(v,findings,true),findings),instruction:text(v.instruction),...(v.memberId===undefined?{}:{memberId:text(v.memberId)})};});
  if(p.recommendedSlotId!==undefined&&!candidateSlotIds.includes(text(p.recommendedSlotId)))invalid('推荐候选必须引用本次独立产出的编号。');
  return {summary:jointText(p,'summary'),...userSummary(p),dispositions,disagreements,verificationRequests,...(p.recommendedSlotId===undefined?{}:{recommendedSlotId:text(p.recommendedSlotId)}),...(p.synthesis===undefined?{}:{synthesis:jointText(p,'synthesis')}),...(replyNotes.length?{replyNotes}:{})};
}
export function validateJointVerification(raw:unknown,expectedIds:string[]):JointVerification{
  const supplied=normalizeFlowPayload(raw,'verification'),p=payloadObject(supplied&&typeof supplied==='object'?{outcome:'inconclusive',...supplied}:supplied,'verification'),ids=texts(p.findingIds??expectedIds),outcome=text(p.outcome);
  exactIds(ids,expectedIds,'验证必须逐一覆盖派发的问题编号。');if(!['confirmed','refuted','inconclusive'].includes(outcome))invalid('验证结论无效。');
  const evidence=validateReview({verdict:'inconclusive',verificationComplete:false,criteriaResults:[],findings:[],evidence:p.evidence??[]},[]).evidence;
  if(outcome!=='inconclusive'&&!evidence.length)invalid('确认或证伪必须有验证依据。');
  return {findingIds:ids,outcome:outcome as JointVerification['outcome'],evidence,summary:text(p.summary)};
}

/** A correction repairs shape once; it cannot add evidence, drop an issue, or change a ruling. */
export function assertJointMeaning(original:unknown,corrected:unknown){
  assertReviewMeaning(original,corrected);
  if(!original||typeof original!=='object'||!corrected||typeof corrected!=='object')return;
  const before=original as Record<string,unknown>,after=corrected as Record<string,unknown>;
  for(const key of ['proposal','synthesis','summary','userSummary','recommendedSlotId'])if(typeof before[key]==='string'&&before[key]!==after[key])invalid('格式补正改变了候选或汇总结论。');
  for(const key of ['findingIds','unverifiedItems'])if(Array.isArray(before[key])&&JSON.stringify(before[key])!==JSON.stringify(after[key]))invalid('格式补正改变了问题范围或未核实事项。');
  if(['confirmed','refuted','inconclusive'].includes(String(before.outcome))&&before.outcome!==after.outcome)invalid('格式补正改变了验证结论。');
  for(const key of ['findings','responses','dispositions','disagreements','verificationRequests']){
    if(!Array.isArray(before[key]))continue;const prior=before[key] as Record<string,unknown>[],next=after[key] as Record<string,unknown>[];
    if(!Array.isArray(next)||prior.length!==next.length)invalid('格式补正增删了问题、答复或验证任务。');
    for(const [index,item] of prior.entries())if(item&&typeof item==='object'){
      const match=typeof item.findingId==='string'?next.find(n=>n?.findingId===item.findingId):next[index];
      for(const field of ['findingId','location','request','evidence','reason','newSubmissionId','instruction','memberId','candidate'])if(typeof item[field]==='string'&&match?.[field]!==item[field])invalid('格式补正改变了问题内容、依据或候选归属。');
      for(const field of ['affectsAcceptance','findingIds','findingIndex','findingIndexes'])if(item[field]!==undefined&&JSON.stringify(item[field])!==JSON.stringify(match?.[field]))invalid('格式补正改变了验收分歧或问题编号。');
      for(const [field,values] of [['stance',['agree','dispute','fixed-new-version']],['action',['accept','defer','reject']]] as const)if(values.includes(String(item[field]) as never)&&match?.[field]!==item[field])invalid('格式补正改变了作者立场或问题处置。');
    }
  }
}
