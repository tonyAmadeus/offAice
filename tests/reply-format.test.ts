import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePlan,validateReport,validateNextRound,parseReply} from '../src/shared/project-flow-protocol';
import {validateJointOpinion,validateJointSummary,validateJointVerification,validateAuthorResponse,assertJointMeaning} from '../src/shared/joint-review-protocol';
const finding={id:'actual-id',location:'稿件',kind:'verified' as const,severity:'should-fix' as const,evidence:'原文',request:'修正'};
test('optional empty fields default without inventing evidence or relaxing versions',()=>{
  assert.deepEqual(validateJointOpinion({summary:'未发现问题'}).findings,[]);
  assert.deepEqual(validateJointSummary({summary:'无问题，保留未核实事项'},[],[]).dispositions,[]);
  assert.throws(()=>validateJointSummary({summary:'漏掉实际问题'},[finding],[]),/每条问题/);
  assert.equal(validateJointVerification({outcome:'inconclusive',summary:'无法核实'},['actual-id']).findingIds[0],'actual-id');
  assert.throws(()=>validateJointVerification({outcome:'confirmed',summary:'声称已核实'},['actual-id']),/验证依据/);
  assert.throws(()=>parseReply(JSON.stringify({protocol:'airoom.project-flow',version:2,kind:'plan',payload:{}}),'plan'),/不匹配/);
  assert.deepEqual(validateReport({summary:'完成',completedTaskKeys:[],deliverables:['稿件'],validationSummary:'人工阅读'}).remainingIssues,[]);
  assert.equal(validateNextRound({mode:'as-planned'},[]).summary,'按原计划');
});
test('short references bind only actual issues and cannot drop or invent one',()=>{
  assert.equal(validateAuthorResponse({responses:[{stance:'agree',reason:'接受'}]},[finding])[0].findingId,finding.id);
  assert.equal(validateJointSummary({summary:'保留问题',dispositions:[{findingIndex:1,action:'accept',reason:'有原文'}]},[finding],[]).dispositions[0].findingId,finding.id);
  assert.throws(()=>validateJointSummary({summary:'错误序号',dispositions:[{findingIndex:2,action:'accept',reason:'有原文'}]},[finding],[]),/序号/);
  assert.throws(()=>validateAuthorResponse({responses:[{findingId:'foreign',stance:'agree',reason:'接受'}]},[finding]),/遗漏/);
  assert.throws(()=>validateAuthorResponse({responses:[{stance:'dispute',reason:'不同意'}]},[finding]),/文字字段/);
});
test('plan IDs and single-round links are generated while write boundaries stay mandatory',()=>{
  const raw={objective:'写一篇介绍',scope:'intro.md',deliverables:['介绍'],acceptanceCriteria:['准确'],rounds:[{title:'写稿',goal:'介绍完整'}],tasks:[{title:'介绍',memberId:'a',goal:'写稿',completionCriteria:['准确'],allowedPaths:['intro.md']}]};
  const plan=validatePlan(raw,['a']);assert.equal(plan.tasks[0].roundKey,plan.rounds[0].key);assert.deepEqual(plan.tasks[0].inputs,[]);
  assert.throws(()=>validatePlan({...raw,tasks:[{...raw.tasks[0],allowedPaths:[]}]},['a']),/allowedPaths/);
  assert.throws(()=>validatePlan({...raw,tasks:[{...raw.tasks[0],allowedPaths:['../outside']}]},['a']),/相对/);
  assert.throws(()=>validatePlan({...raw,tasks:[{...raw.tasks[0],memberId:'foreign'}]},['a']),/团队/);
});
