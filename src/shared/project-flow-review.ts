import {FlowError,type Evidence,type ReviewPayload,type ReviewFinding} from './project-flow';
import {criterionKind,criterionText,type CompletionCriterion} from './project-flow';

export function commandEvidenceProblem(e:Evidence){
  if(e.kind!=='command')return;
  if(e.source!=='observed')return 'missing-completion';
  if(e.exitCode!==undefined&&e.observedExitCode!==undefined&&e.exitCode!==e.observedExitCode)return 'exit-code-mismatch';
  if(e.exitCode===0&&e.executionStatus==='failed')return 'failed-execution';
}
/** Keep an unverified numeric claim visible without inventing a native exit code. */
export function commandExitCodeNotes(evidence:Evidence[]){
  return [...new Set(evidence.filter(e=>e.kind==='command'&&e.source==='observed'&&e.exitCodeSource==='reported'&&e.exitCode!==undefined).map(e=>
    '退出码未核实：'+e.description+'（'+(e.command??'').slice(0,160)+'）；成员填写 '+e.exitCode+'，'+
    (e.observedExitCode!==undefined?'原生记录为 '+e.observedExitCode+'。':e.executionStatus==='failed'?'原生记录显示执行失败，但未提供退出码。':'原生记录确认命令已完成，但未提供退出码。')))];
}

/** Human sign-off is a later workflow gate, not a fact that a member can verify in a file. */
export function isUserAcceptanceCriterion(criterion:string,userName=''){
  const name=userName.trim().replace(/[.*+?^{}$()|[\]\\]/g,'\\$&');
  const subject='(?:用户(?!名|编号|字段)|主人|人类|人工|客户|\\b(?:human|user|client|customer|owner)\\b'+(name?'|(?<![a-z0-9_])'+name+'(?![a-z0-9_])':'')+')';
  const namedSubject=subject+'\\s*(?:[（(][^()（）]{1,40}[）)]\\s*)?';
  const match=(pattern:string,clause:string)=>new RegExp(pattern,'i').test(clause);
  // Check each clause so describing a button elsewhere cannot hide a real sign-off gate.
  return criterion.split(/[，,；;。！？!\n]/).some(clause=>{
    // Product behavior, UI labels and instructions are independently verifiable.
    if(/确认(?:框|对话框|按钮|弹窗)|验收按钮|\b(?:dialog|modal)\b|\bconfirmation\s+(?:box|button|window)\b/i.test(clause))return false;
    if(match(namedSubject+'(?:可(?:以)?|能够|能|支持|点击|按下|选择|删除|保存|登录|输入|填写|打开|查看|在|通过|\\s+(?:can|could|may|clicks?|selects?|enters?)\\b)',clause))return false;
    if(match(namedSubject+'(?:已|已经)?确认(?:删除|保存|安装|退出|取消|登录|操作)',clause))return false;
    if(match(namedSubject+"(?:['’]s\\s*|的\\s*)?(?:确认|验收|批准|approval|acceptance|confirmation)\\s*(?:状态|字段|按钮|图标|流程|(?:status|field|button|label|flow)\\b)",clause))return false;
    if(match(subject+'\\s+(?:(?:has|had|already)\\s+)*confirm(?:ed|s)?\\s+(?:the\\s+)?(?:deletion|save|installation|logout|action)\\b',clause))return false;
    if(match('(?:README|文档|说明书|帮助|documentation|document|guide|manual).{0,30}(?:说明|描述|介绍|解释|记录|包含|explain|describe|document|outline).{0,40}'+subject,clause))return false;
    if(match('(?:界面|页面|按钮|列表|字段|日志|记录|\\bUI\\b|screen|page|button|field|label).{0,20}(?:显示|记录|包含|写入|show|display|contain).{0,30}'+subject,clause))return false;
    return match(namedSubject+'(?:的\\s*)?(?:(?:已经完成|已经|已|最终|亲自|完成|待|等待|需要|必须|应|需|进行)\\s*){0,3}(?:确认|验收|认可|满意|批准|同意|签字|签收)',clause)
      ||match(namedSubject+'对\\s*(?:本轮(?:结果|成果|成品)?|最终(?:结果|成果|成品|方案)?|交付(?:物|成果)|成果|成品|方案|结果)\\s*(?:已|已经|表示)?(?:确认|认可|满意|批准|同意)',clause)
      ||match(subject+"(?:['’]s)?\\s+(?:(?:has|have|had|is|was|must|should|needs?\\s+to|to|been|already|will)\\s+){0,3}(?:approv(?:e[ds]?|al)|accept(?:ed|ance|s)?|confirm(?:ed|ation|s)?|sign[\\s-]?off|signed\\s+off)\\b",clause)
      ||match('(?:approved|accepted|confirmed|approval|sign[\\s-]?off)\\s+(?:by|from|of)\\s+(?:the\\s+)?'+subject,clause)
      ||match('(?:确认|验收|批准).{0,8}(?:由|经)\\s*'+subject,clause);
  });
}
export function memberCriteria(criteria:CompletionCriterion[],userName=''){
  const owner=(c:CompletionCriterion)=>criterionKind(c)==='owner'||isUserAcceptanceCriterion(criterionText(c),userName);
  return {required:[...new Set(criteria.filter(c=>!owner(c)&&criterionKind(c)==='check').map(criterionText))],judged:[...new Set(criteria.filter(c=>!owner(c)&&criterionKind(c)==='judge').map(criterionText))],deferred:[...new Set(criteria.filter(owner).map(criterionText))]};
}
export function rejectUserCriteria(criteria:CompletionCriterion[],userName=''){
  const invalid=criteria.filter(c=>criterionKind(c)!=='owner'&&isUserAcceptanceCriterion(criterionText(c),userName)).map(criterionText);
  if(invalid.length)throw new FlowError('INVALID_PROTOCOL','未标成 owner 的成员完成标准不能依赖用户确认或验收；请使用带 text 和 kind 的 JSON 对象，例如 '+JSON.stringify({text:invalid[0],kind:'owner'})+'，留待用户验收。不要只在字符串前添加 owner: 前缀。待修正标准：'+invalid.join('、'));
}
/** Preserve the member's verdict. Eligibility to advance is a separate, evidence-based outcome. */
export function assessReview(payload:ReviewPayload,required:string[],deferred:string[]=[],previous:ReviewFinding[]=[],overruled:string[]=[],judged:string[]=[]){
  const negative=(payload.assessments??[]).filter(a=>judged.includes(a.criterion)&&a.rating==='not'&&a.reason.trim());
  const reasons:string[]=[],findings=payload.findings.map(f=>{const old=previous.find(p=>p.id===f.previousFindingId||p.location===f.location&&p.request===f.request),check=old&&payload.previousFindingChecks?.find(c=>c.findingId===old.id),suppressed=old&&overruled.includes(old.id);
    const evaluative=negative.length>0&&f.kind!=='suspected'&&Boolean(f.location.trim()&&f.request.trim());
    const needsFix=!suppressed&&check?.resolved!==true&&(f.kind==='verified'&&Boolean(f.evidence.trim())||evaluative)&&f.severity!=='optional'&&(!previous.length||Boolean(old)||f.severity==='blocking');
    if(old&&check?.resolved&&f.kind==='verified'&&f.severity!=='optional')reasons.push('旧问题核对与问题清单相互矛盾：'+f.location);
    return {...f,...(old?{previousFindingId:old.id}:{}),disposition:needsFix?'requires-fix' as const:'advice' as const};}),observedDefects=findings.filter(f=>f.disposition==='requires-fix');
  const missing=required.filter(c=>!payload.criteriaResults.some(r=>r.criterion===c&&r.verified&&Boolean(r.evidence.trim())));
  const unbound=payload.evidence.filter(e=>e.kind==='command'&&e.source!=='observed');
  const conflicting=payload.evidence.filter(e=>['exit-code-mismatch','failed-execution'].includes(commandEvidenceProblem(e)??''));
  const onlyDeferredIncomplete=deferred.length>0&&!missing.length&&payload.criteriaResults.some(r=>deferred.includes(r.criterion)&&!r.verified)&&payload.criteriaResults.filter(r=>!r.verified).every(r=>deferred.includes(r.criterion));
  if(missing.length)reasons.push('未能核实：'+missing.join('、'));
  if(!payload.verificationComplete&&required.length&&!onlyDeferredIncomplete)reasons.push('必要验证尚未完成。');
  if(unbound.length)reasons.push('命令缺少实际完成记录：'+unbound.map(e=>e.command).join('、'));
  if(conflicting.length)reasons.push('退出码声明与原生执行结果矛盾：'+conflicting.map(e=>e.command).join('、'));
  const mismatches=payload.evidence.filter(e=>e.kind==='source'&&e.sourceVerification==='mismatch');
  if(mismatches.length)reasons.push('来源引用与本机原文不一致：'+mismatches.map(e=>e.title).join('、'));
  // A suspected missing input cannot become a blocking defect merely by using severity=blocking.
  if(payload.findings.some(f=>f.kind==='suspected'&&f.severity==='blocking'))reasons.push('疑似阻塞问题需要查证，尚未证实。');
  const missingOldChecks=previous.some(f=>!payload.previousFindingChecks?.some(c=>c.findingId===f.id&&Boolean(c.evidence.trim())));
  const missingEvidence=!payload.evidence.length&&(required.length>0||previous.length>0);
  if(missingOldChecks)reasons.push('旧问题核对缺少依据。');
  if(missingEvidence)reasons.push('复核缺少验证依据。');
  let outcome:ReviewPayload['verdict'];
  if(missingOldChecks||missingEvidence||conflicting.length||mismatches.length)outcome='inconclusive';
  else if(observedDefects.length){outcome='changes_requested';reasons.push(...observedDefects.map(f=>f.request));}
  else if((payload.verdict==='inconclusive'&&!(judged.length>0&&!required.length&&judged.every(c=>payload.assessments?.some(a=>a.criterion===c&&['meets','partly'].includes(a.rating)))))||reasons.length){outcome='inconclusive';}
  else outcome='pass'; // An optional-only (or empty) issue list cannot request changes.
  // A legacy "user has not accepted" is explicitly deferred. Do not invent verified=true for it.
  if(outcome==='inconclusive'&&(!required.length&&deferred.length||onlyDeferredIncomplete)&&!reasons.length&&!unbound.length&&!payload.findings.length)outcome='pass';
  return {outcome,reasons,findings,advice:(payload.assessments??[]).filter(a=>judged.includes(a.criterion)&&a.rating==='partly').map(a=>a.criterion+'：'+a.reason)};
}

/** A format-only retry may fix keys and enums, but cannot turn uncertainty into a verified fact. */
export function assertReviewMeaning(original:unknown,corrected:unknown){
  if(!original||typeof original!=='object'||!corrected||typeof corrected!=='object')return;
  const before=original as Record<string,unknown>,after=corrected as Record<string,unknown>;
  if(Array.isArray(after.assessments))for(const raw of after.assessments){
    const next=raw as Record<string,unknown>,prior=Array.isArray(before.assessments)?before.assessments.find((a:Record<string,unknown>)=>a.criterion===next.criterion):undefined;
    // A misspelled key may be repaired, but only with an existing, unambiguous rating.
    const rating=prior?.rating??prior?.assessment;
    const conflicting=prior?.rating!==undefined&&prior?.assessment!==undefined&&prior.rating!==prior.assessment;
    if(!prior||conflicting||!['meets','partly','not'].includes(String(rating))||rating!==next.rating||prior.reason!==next.reason)throw new FlowError('FORMAT_MEANING_CHANGED','格式补正新增或改变了成员评价。');
  }
  if(Array.isArray(before.evidence)&&Array.isArray(after.evidence))for(const raw of before.evidence){const prior=raw as Record<string,unknown>;if(prior.kind!=='source')continue;const next=after.evidence.find((e:Record<string,unknown>)=>e.kind==='source'&&e.location===prior.location&&e.title===prior.title&&e.excerpt===prior.excerpt);if(!next)throw new FlowError('FORMAT_MEANING_CHANGED','格式补正改变了来源或引用原文。');}
  if(Array.isArray(after.evidence))for(const raw of after.evidence){const next=raw as Record<string,unknown>;if(next.kind!=='source')continue;if(!Array.isArray(before.evidence)||!before.evidence.some((e:Record<string,unknown>)=>e.kind==='source'&&e.location===next.location&&e.title===next.title&&e.excerpt===next.excerpt))throw new FlowError('FORMAT_MEANING_CHANGED','格式补正不能新增来源位置或引用。');}
  if(['pass','changes_requested','inconclusive'].includes(String(before.verdict))&&before.verdict!==after.verdict)throw new FlowError('FORMAT_MEANING_CHANGED','格式补正改变了原复核结论。');
  if(typeof before.verificationComplete==='boolean'&&before.verificationComplete!==after.verificationComplete)throw new FlowError('FORMAT_MEANING_CHANGED','格式补正改变了原验证完成状态。');
  if(Array.isArray(before.criteriaResults)&&Array.isArray(after.criteriaResults))for(const item of before.criteriaResults){
    if(!item||typeof item!=='object')continue;const prior=item as Record<string,unknown>,next=after.criteriaResults.find((c:Record<string,unknown>)=>c.criterion===prior.criterion);
    if(typeof prior.verified==='boolean'&&(!next||next.verified!==prior.verified))throw new FlowError('FORMAT_MEANING_CHANGED','格式补正改变了完成标准的核实状态。');
    if(prior.verified===true&&typeof prior.evidence==='string'&&next?.evidence!==prior.evidence)throw new FlowError('FORMAT_MEANING_CHANGED','格式补正新增或改变了验证依据。');
  }
  if(Array.isArray(after.criteriaResults))for(const item of after.criteriaResults){const next=item as Record<string,unknown>,prior=Array.isArray(before.criteriaResults)?before.criteriaResults.find((c:Record<string,unknown>)=>c.criterion===next.criterion):undefined;
    if(!prior&&(next.verified===true||next.evidence))throw new FlowError('FORMAT_MEANING_CHANGED','格式补正为原输出中没有的标准新增了验证声明。');
  }
  if(Array.isArray(before.findings)&&Array.isArray(after.findings))for(const [index,item] of before.findings.entries()){const prior=item as Record<string,unknown>,next=after.findings.find((f:Record<string,unknown>)=>prior.location!==undefined&&f.location===prior.location&&f.request===prior.request)??after.findings[index];
    if(['verified','suspected','suggestion'].includes(String(prior.kind))&&(!next||next.kind!==prior.kind))throw new FlowError('FORMAT_MEANING_CHANGED','格式补正改变了问题是否已经证实。');
    if(['blocking','should-fix','optional'].includes(String(prior.severity))&&(!next||next.severity!==prior.severity))throw new FlowError('FORMAT_MEANING_CHANGED','格式补正改变了问题严重程度。');
    for(const field of ['location','request'])if(typeof prior[field]==='string'&&(!next||next[field]!==prior[field]))throw new FlowError('FORMAT_MEANING_CHANGED','格式补正改变了问题位置或修改要求。');
    if(typeof prior.evidence==='string'&&next&&next.evidence!==prior.evidence)throw new FlowError('FORMAT_MEANING_CHANGED','格式补正改变了问题依据。');
  }
  if(Array.isArray(after.findings))for(const [index,item] of after.findings.entries()){const next=item as Record<string,unknown>,prior=Array.isArray(before.findings)?before.findings.find((f:Record<string,unknown>)=>next.location!==undefined&&f.location===next.location&&f.request===next.request)??before.findings[index]:undefined;if(!prior&&next.kind==='verified')throw new FlowError('FORMAT_MEANING_CHANGED','格式补正新增了已核实的问题。');}
  if(Array.isArray(before.evidence)&&Array.isArray(after.evidence))for(const [index,item] of after.evidence.entries()){
    const next=item as Record<string,unknown>;if(typeof next.result!=='string')continue;
    const unchanged=before.evidence.some((prior:Record<string,unknown>)=>prior?.result===next.result),prior=before.evidence[index] as Record<string,unknown>|undefined;
    // A command may become an inspection of the existing tool result. Keep its slot and full text.
    const migrated=before.evidence.length===after.evidence.length&&prior?.kind==='command'&&next.kind==='inspection'&&
      typeof prior.result==='string'&&Boolean(prior.result.trim())&&next.result.startsWith(prior.result)&&
      (next.command===undefined||next.command===prior.command)&&(next.exitCode===undefined||next.exitCode===prior.exitCode);
    if(!unchanged&&!migrated)throw new FlowError('FORMAT_MEANING_CHANGED','格式补正新增了验证结果声明。命令转 inspection 时须保持依据条数和顺序，并把原 result（含标点）完整保留为前缀。');
  }
  if(Array.isArray(after.previousFindingChecks))for(const item of after.previousFindingChecks){const next=item as Record<string,unknown>,prior=Array.isArray(before.previousFindingChecks)?before.previousFindingChecks.find((c:Record<string,unknown>)=>c.findingId===next.findingId):undefined;
    if(!prior||typeof prior.resolved==='boolean'&&prior.resolved!==next.resolved||prior.evidence!==next.evidence)throw new FlowError('FORMAT_MEANING_CHANGED','格式补正新增或改变了旧问题的核实结果。');
  }
  if(Array.isArray(before.rulings)&&Array.isArray(after.rulings))for(const item of before.rulings){const prior=item as Record<string,unknown>,next=after.rulings.find((r:Record<string,unknown>)=>r.findingId===prior.findingId);if(['uphold-author','uphold-review','inconclusive'].includes(String(prior.verdict))&&(!next||next.verdict!==prior.verdict)||typeof prior.reason==='string'&&next?.reason!==prior.reason)throw new FlowError('FORMAT_MEANING_CHANGED','格式补正改变了异议裁定。');}
}
