import test from 'node:test';
import assert from 'node:assert/strict';
import { jointCost } from '../src/shared/joint-review';
import { validateAuthorResponse,validateJointOpinion,validateJointSummary,validateJointVerification } from '../src/shared/joint-review-protocol';
import type { ReviewFinding } from '../src/shared/project-flow';
const finding:ReviewFinding={id:'f1',location:'文档结论',kind:'verified',severity:'blocking',evidence:'原稿缺少来源',request:'补上出处'};
test('joint review baseline costs match the agreed proposal and artifact stages',()=>{
  assert.equal(jointCost(3,'proposal').baseCalls,7);assert.equal(jointCost(3,'artifact').baseCalls,5);assert.equal(jointCost(3,'answer').baseCalls,5);assert.equal(jointCost(3,'proposal',false).baseCalls,4);
});
test('joint opinions share finding validation and cannot manufacture a verified finding without evidence',()=>{
  const {id,...payload}=finding;
  assert.equal(validateJointOpinion({summary:'需补出处',findings:[payload],unverifiedItems:[]}).findings[0].severity,'blocking');
  assert.throws(()=>validateJointOpinion({summary:'结论',findings:[{...payload,evidence:''}],unverifiedItems:[]}),/文字字段/);
  assert.throws(()=>validateJointOpinion({summary:'结论',findings:[{...payload,severity:'urgent'}],unverifiedItems:[]}),/严重程度/);
});
test('optional user summaries retain the original findings and strict evidence contract',()=>{
  const {id,...payload}=finding,base={summary:'技术结论',findings:[payload],unverifiedItems:['来源待核对'],evidence:[]};
  const parsed=validateJointOpinion({...base,userSummary:'  简要说明  '});assert.equal(parsed.userSummary,'简要说明');assert.equal(parsed.summary,base.summary);assert.equal(parsed.findings[0].severity,'blocking');assert.deepEqual(parsed.unverifiedItems,base.unverifiedItems);
  assert.equal(validateJointOpinion({...base,userSummary:' '}).userSummary,undefined);assert.equal(validateJointOpinion({...base,userSummary:'文'.repeat(2100)}).userSummary?.length,2000);
  assert.throws(()=>validateJointOpinion({...base,userSummary:{summary:'错误类型'}}),/文字字段/);
  assert.throws(()=>validateJointOpinion({...base,userSummary:'说明',invented:'字段'}),/不支持的字段/);
  assert.throws(()=>validateJointOpinion({...base,userSummary:'说明',findings:[{...payload,evidence:''}]}),/文字字段/);
});
test('author replies cover every finding once and disputes require evidence; a new version cannot be invented',()=>{
  const response={findingId:'f1',stance:'agree',reason:'确实漏了',evidence:''};assert.equal(validateAuthorResponse({responses:[response]},[finding]).length,1);
  assert.throws(()=>validateAuthorResponse({responses:[]},[finding]),/遗漏/);assert.throws(()=>validateAuthorResponse({responses:[response,response]},[finding]),/重复/);
  assert.throws(()=>validateAuthorResponse({responses:[{...response,stance:'dispute'}]},[finding]),/文字字段/);
  assert.throws(()=>validateAuthorResponse({responses:[{...response,stance:'fixed-new-version',evidence:'已有新稿'}]},[finding]),/新提交/);
});
test('summary requires one disposition per finding and owned candidate and verification references',()=>{
  const base={summary:'需要补充',dispositions:[{findingId:'f1',action:'accept',reason:'出处缺失'}],disagreements:[],verificationRequests:[]};assert.equal(validateJointSummary(base,[finding],['s1']).dispositions.length,1);
  assert.throws(()=>validateJointSummary({...base,dispositions:[]},[finding],[]),/每条问题/);
  assert.throws(()=>validateJointSummary({...base,recommendedSlotId:'foreign'},[finding],['s1']),/本次独立/);
  assert.throws(()=>validateJointSummary({...base,verificationRequests:[{findingIds:['foreign'],instruction:'检查'}]},[finding],[]),/本次评审/);
});
test('verification cannot claim confirmation without evidence or silently change its finding scope',()=>{
  assert.throws(()=>validateJointVerification({findingIds:['f1'],outcome:'refuted',evidence:[],summary:'没问题'},['f1']),/验证依据/);
  assert.throws(()=>validateJointVerification({findingIds:['f2'],outcome:'inconclusive',evidence:[],summary:'未知'},['f1']),/派发的问题/);
  assert.equal(validateJointVerification({findingIds:['f1'],outcome:'inconclusive',evidence:[],summary:'来源无法核对'},['f1']).outcome,'inconclusive');
});
