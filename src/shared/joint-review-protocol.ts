import { FlowError, type ReviewFinding } from './project-flow';
import { object, text, texts, validateReview, payloadObject } from './project-flow-protocol';
import {assertReviewMeaning} from './project-flow-review';
import type { AuthorResponse, JointDisposition, JointDisagreement, JointOpinion, JointSummary, JointVerification, JointVerificationRequest } from './joint-review';

function invalid(message:string):never{throw new FlowError('INVALID_PROTOCOL',message);}
function userSummary(p:Record<string,unknown>){if(p.userSummary===undefined)return {};const value=text(p.userSummary,true).slice(0,2000);return value?{userSummary:value}:{};}
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
/** Findings and evidence use the same parser as ordinary task and round reviews. */
export function validateJointOpinion(raw:unknown):JointOpinion{
  const p=payloadObject(raw,'joint-independent');
  const review=validateReview({verdict:'inconclusive',verificationComplete:false,criteriaResults:[],findings:p.findings??[],evidence:p.evidence??[]},[]);
  return {summary:text(p.summary),...userSummary(p),...(p.proposal===undefined?{}:{proposal:text(p.proposal)}),findings:review.findings.map((f,i)=>({...f,id:`pending-${i}`})),unverifiedItems:texts(p.unverifiedItems??[],true),evidence:review.evidence};
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
  const p={...payloadObject(raw,'joint-summary')};p.dispositions??=[];p.disagreements??=[];p.verificationRequests??=[];
  if(!Array.isArray(p.dispositions)||!Array.isArray(p.disagreements)||!Array.isArray(p.verificationRequests)||p.dispositions.length>100||p.disagreements.length>100||p.verificationRequests.length>100)invalid('汇总列表无效。');
  const dispositions:JointDisposition[]=p.dispositions.map(raw=>{const d=object(raw,['findingId','findingIndex','action','reason'],['action','reason']),action=text(d.action);if(!['accept','defer','reject'].includes(action))invalid('问题处置只能是 accept、defer、reject。');return {findingId:text(reference(d,findings)),action:action as JointDisposition['action'],reason:text(d.reason)};});
  exactIds(dispositions.map(d=>d.findingId),findings.map(f=>f.id),'每条问题必须有且只有一项处置及理由。');
  const disagreements:JointDisagreement[]=p.disagreements.map(raw=>{const d=object(raw,['findingIds','findingIndexes','reason','affectsAcceptance'],['reason','affectsAcceptance']);if(typeof d.affectsAcceptance!=='boolean')invalid('是否影响验收必须是布尔值。');return {findingIds:findingIds(reference(d,findings,true),findings),reason:text(d.reason),affectsAcceptance:d.affectsAcceptance};});
  const verificationRequests:JointVerificationRequest[]=p.verificationRequests.map(raw=>{const v=object(raw,['findingIds','findingIndexes','instruction','memberId'],['instruction']);return {findingIds:findingIds(reference(v,findings,true),findings),instruction:text(v.instruction),...(v.memberId===undefined?{}:{memberId:text(v.memberId)})};});
  if(p.recommendedSlotId!==undefined&&!candidateSlotIds.includes(text(p.recommendedSlotId)))invalid('推荐候选必须引用本次独立产出的编号。');
  return {summary:text(p.summary),...userSummary(p),dispositions,disagreements,verificationRequests,...(p.recommendedSlotId===undefined?{}:{recommendedSlotId:text(p.recommendedSlotId)}),...(p.synthesis===undefined?{}:{synthesis:text(p.synthesis)})};
}
export function validateJointVerification(raw:unknown,expectedIds:string[]):JointVerification{
  const p=payloadObject(raw,'verification'),ids=texts(p.findingIds??expectedIds),outcome=text(p.outcome);
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
      for(const field of ['findingId','location','request','evidence','reason','newSubmissionId','instruction','memberId'])if(typeof item[field]==='string'&&match?.[field]!==item[field])invalid('格式补正改变了问题内容或依据。');
      for(const field of ['affectsAcceptance','findingIds','findingIndex','findingIndexes'])if(item[field]!==undefined&&JSON.stringify(item[field])!==JSON.stringify(match?.[field]))invalid('格式补正改变了验收分歧或问题编号。');
      for(const [field,values] of [['stance',['agree','dispute','fixed-new-version']],['action',['accept','defer','reject']]] as const)if(values.includes(String(item[field]) as never)&&match?.[field]!==item[field])invalid('格式补正改变了作者立场或问题处置。');
    }
  }
}
