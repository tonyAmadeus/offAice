import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {validatePlan,validateReview,validateSubmission,flowPrompt} from '../src/shared/project-flow-protocol';
import {memberCriteria,assessReview,assertReviewMeaning} from '../src/shared/project-flow-review';
import {criterionText,criterionKind,type ReviewPayload} from '../src/shared/project-flow';
import {bindSourceEvidence} from '../src/backend/source-evidence';
import {harness,plan,passing,proof} from './helpers/project-flow-harness';

test('typed criteria accept owner sign-off and preserve old strings as check without rewriting them',()=>{
  const p=plan();p.acceptanceCriteria=[{text:'主人满意最终风格',kind:'owner'}];
  p.tasks[0].completionCriteria=['A 正确',{text:'叙述清楚',kind:'judge'},{text:'最终色调偏好',kind:'owner'}];
  const parsed=validatePlan(p,['claude','dsh','codex']);
  assert.equal(parsed.tasks[0].completionCriteria[0],'A 正确');assert.equal(criterionKind(parsed.tasks[0].completionCriteria[0]),'check');
  assert.deepEqual(memberCriteria(parsed.tasks[0].completionCriteria),{required:['A 正确'],judged:['叙述清楚'],deferred:['最终色调偏好']});
  p.acceptanceCriteria=['主人确认'];assert.throws(()=>validatePlan(p,['claude','dsh','codex']),/owner/);
  const before=JSON.stringify(parsed);memberCriteria(parsed.acceptanceCriteria);assert.equal(JSON.stringify(parsed),before);
});

test('judge positive or partial ratings need reasons, do not invent verified facts, and check still uses the proof gate',()=>{
  const payload=validateReview({verdict:'inconclusive',verificationComplete:false,criteriaResults:[],findings:[],evidence:[],assessments:[{criterion:'结构清晰',rating:'partly',reason:'结尾可再收紧'}],strengths:['开头清楚']},[]);
  const result=assessReview(payload,[],[],[],[],['结构清晰']);assert.equal(result.outcome,'pass');assert.deepEqual(result.advice,['结构清晰：结尾可再收紧']);assert.equal(payload.criteriaResults.length,0);
  assert.equal(assessReview(payload,['文件存在'],[],[],[],['结构清晰']).outcome,'inconclusive');
  assert.throws(()=>validateReview({...payload,assessments:[{criterion:'结构清晰',rating:'excellent',reason:'好'}]},[]),/评价/);
});

test('negative judgment needs a concrete problem and follows the existing repeat-return policy',()=>{
  const payload:ReviewPayload={verdict:'changes_requested',verificationComplete:false,criteriaResults:[],evidence:proof,findings:[],assessments:[{criterion:'论证充分',rating:'not',reason:'第二节结论没有解释'}]};
  assert.equal(assessReview(payload,[],[],[],[],['论证充分']).outcome,'pass');
  payload.findings=[{location:'第二节',kind:'suggestion',severity:'should-fix',evidence:'',request:'补足结论到依据之间的推导'}];
  const first=assessReview(payload,[],[],[],[],['论证充分']);assert.equal(first.outcome,'changes_requested');
  const old={...first.findings[0],id:'old'};
  const repeated={...payload,previousFindingChecks:[{findingId:'old',resolved:false,evidence:'仍缺推导'}],findings:[{...payload.findings[0],previousFindingId:'old'}]};
  assert.equal(assessReview(repeated,[],[],[old],[],['论证充分']).outcome,'changes_requested');
  const later={...payload,previousFindingChecks:[{findingId:'old',resolved:true,evidence:'已补充'}],findings:[{...payload.findings[0],location:'第三节',request:'新增说明'}]};
  assert.equal(assessReview(later,[],[],[old],[],['论证充分']).outcome,'pass');
});

test('source schema preserves original quotes and does not accept forged verification or executable URLs',()=>{
  const source={kind:'source',title:'资料',location:'https://example.com/article',excerpt:'引用原文'};
  const submission=validateSubmission({summary:'报告',completionResults:[],evidence:[source]});
  assert.equal(submission.evidence[0].sourceVerification,'unverified');
  assert.throws(()=>validateSubmission({summary:'报告',completionResults:[],evidence:[{...source,sourceVerification:'verified'}]}),/不支持的字段/);
  assert.throws(()=>validateSubmission({summary:'报告',completionResults:[],evidence:[{...source,location:'javascript:alert(1)'}]}),/链接/);
});

test('local source line ranges are verified against actual text, while foreign paths and external URLs stay unverified',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM source-evidence-'));
  try{
    await writeFile(path.join(root,'资料.md'),'第一行\n可引用原文\n第三行');
    const evidence=validateSubmission({summary:'报告',completionResults:[],evidence:[{kind:'source',title:'资料',location:'资料.md:2',excerpt:'可引用原文'}]}).evidence;
    assert.equal(bindSourceEvidence(evidence,root)[0].sourceVerification,'verified');
    assert.equal(bindSourceEvidence([{...evidence[0],location:'资料.md:3'}],root)[0].sourceVerification,'mismatch');
    assert.equal(bindSourceEvidence([{...evidence[0],location:'../外部.md'}],root)[0].sourceVerification,'unverified');
    const external=bindSourceEvidence([{...evidence[0],location:'https://example.com',source:'observed',sourceVerification:'verified'}],root);
    assert.equal(external[0].sourceVerification,'unverified');assert.equal(external[0].source,'reported');
    assert.equal(assessReview({...passing(['文件存在']),evidence:external},['文件存在']).outcome,'pass');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('format correction cannot change a rating, reason or source quote',()=>{
  const original={assessments:[{criterion:'结构',rating:'not',reason:'缺少结尾'}],evidence:[{kind:'source',title:'资料',location:'a.md:2',excerpt:'原文'}]};
  assert.doesNotThrow(()=>assertReviewMeaning(original,structuredClone(original)));
  assert.throws(()=>assertReviewMeaning(original,{...original,assessments:[{criterion:'结构',rating:'meets',reason:'缺少结尾'}]}),/评价/);
  assert.throws(()=>assertReviewMeaning(original,{...original,evidence:[{...original.evidence[0],excerpt:'新造的原文'}]}),/来源/);
  assert.match(flowPrompt('plan',{},{}),/主观|judge/);
});

test('format correction can rename an unambiguous assessment key without changing its meaning',()=>{
  const original={assessments:[{criterion:'结构',assessment:'meets',reason:'章节清楚'}]};
  const corrected={assessments:[{criterion:'结构',rating:'meets',reason:'章节清楚'}]};
  assert.doesNotThrow(()=>assertReviewMeaning(original,corrected));
  for(const prior of [
    {...original.assessments[0],assessment:'partly'},
    {...original.assessments[0],reason:'新的理由'},
    {...original.assessments[0],assessment:undefined},
    {...original.assessments[0],assessment:'pass'},
    {...original.assessments[0],rating:'not'},
  ])assert.throws(()=>assertReviewMeaning({assessments:[prior]},corrected),/评价/);
  assert.throws(()=>assertReviewMeaning({assessments:[]},corrected),/评价/);
});

test('mixed non-engineering criteria proceed through task review, integration, owner acceptance, and saved evaluations',async()=>{
  const p=plan();p.objective='形成一份内容清楚的报告';p.acceptanceCriteria=[{text:'最终风格由主人确认',kind:'owner'}];
  p.tasks[0].completionCriteria=['A 正确',{text:'结构清楚',kind:'judge'},{text:'色调符合偏好',kind:'owner'}];
  const h=await harness({plan:p,handler:async c=>{
    if(c.kind==='submission'){const task=c.material.task;await writeFile(path.join(c.ctx.cwd,task.allowedPaths[0]),'引用资料\n新内容');return {summary:'报告已写好',completionResults:memberCriteria(task.completionCriteria).required.map(criterion=>({criterion,verified:true,evidence:'核对内容'})),evidence:[{kind:'source',title:'本机资料',location:task.allowedPaths[0]+':1',excerpt:'引用资料'}]};}
    if(['review','integration-check'].includes(c.kind)){const result=passing(c.material.criteria??c.material.task.completionCriteria);return {...result,assessments:(c.material.judgedCriteria??[]).map((criterion:string)=>({criterion,rating:'partly',reason:'结尾可以精简'})),strengths:['资料交代清楚']};}
  }});
  try{
    await h.confirm();const s=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');
    assert.ok(s.reviews.find(r=>r.taskId===s.tasks[0].id)?.assessments?.some(a=>a.rating==='partly'));
    assert.ok(s.submissions.some(s=>s.evidence.some(e=>e.sourceVerification==='verified')));
    assert.ok(s.rounds[0].deferredUserCriteria?.includes('色调符合偏好'));
    assert.ok(!s.integrations[0].criteriaResults?.some(r=>r.criterion==='色调符合偏好'));
    await h.accept();await h.wait(s=>s.flow?.status==='completed');assert.match(await h.original(),/引用资料/);
    assert.equal(h.calls.filter(c=>c.correction).length,0);
  }finally{await h.dispose();}
});
