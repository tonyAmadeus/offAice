import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FLOW_FIELD_RULES, FLOW_CRITERIA_RULES, flowPrompt, parseReply, validatePlan, validateReview, validateSubmission } from '../src/shared/project-flow-protocol';
import {plan} from './helpers/project-flow-harness';

const reply = (kind: string) => JSON.stringify({ protocol: 'airoom.project-flow', version: 1, kind: 'submission', payload: { summary: '完成', evidence: [{ kind, description: '写文件', result: '已写入', eventIds: [] }], completionResults: [{ criterion: 'A', verified: true, evidence: '读取' }] } });

test('native owner-prefix plans receive a concrete JSON correction and keep user acceptance separate',()=>{
  const p=plan();p.acceptanceCriteria=['owner：用户验收本轮成果后，由程序写回原目录。'];
  assert.throws(()=>validatePlan(p,['codex','claude','dsh']),(error:Error)=>{
    assert.match(error.message,/"text":"owner：用户验收本轮成果后，由程序写回原目录。","kind":"owner"/);
    assert.match(error.message,/不要只在字符串前添加 owner:/);return true;
  });
  p.acceptanceCriteria=[{text:'用户验收本轮成果后，由程序写回原目录。',kind:'owner'}];
  assert.deepEqual(validatePlan(p,['codex','claude','dsh']).acceptanceCriteria[0],p.acceptanceCriteria[0]);
  for(const kind of ['plan','task-addition','task-rearrange','next-round']){
    const prompt=flowPrompt(kind,{},{});assert.ok(prompt.includes(FLOW_CRITERIA_RULES));
    assert.match(prompt,/"text":"用户确认最终成果","kind":"owner"/);assert.match(prompt,/criterion 只填对应 text 原文/);
  }
});

test('every flow prompt spells out the fixed values members must use', () => {
  const prompt = flowPrompt('submission', { summary: '' }, {});
  assert.ok(prompt.includes(FLOW_FIELD_RULES));
  assert.match(prompt,/最终回复只含上述 JSON 对象/);
  assert.match(prompt,/不加角色台词、动作描写/);
  assert.match(prompt,/所有成员都遵守同一提交格式/);
  assert.match(prompt,/工具没有提供则省略，不要猜测/);
  assert.match(prompt,/completed 只表示命令已完成/);
  for (const value of ['command', 'quote', 'inspection', 'pass', 'changes_requested', 'inconclusive', 'verified', 'suspected', 'suggestion', 'blocking', 'should-fix', 'optional']) assert.ok(FLOW_FIELD_RULES.includes(value), value);
});
test('userSummary is advertised only by submission and the supported roundtable payloads',()=>{
  for(const kind of ['submission','joint-independent','joint-peer','joint-summary'])assert.match(flowPrompt(kind,{},{}),/本轮 payload 可额外带 userSummary/);
  for(const kind of ['review','verification','author-response','plan','round-report','next-round'])assert.doesNotMatch(flowPrompt(kind,{},{}),/userSummary/);
});

test('an invented evidence kind is refused with the allowed values, so one correction can fix it', () => {
  assert.throws(() => validateSubmission(parseReply(reply('tool'), 'submission')), /只能是 command、quote、inspection 或 source，收到 "tool"/);
  assert.doesNotThrow(() => validateSubmission(parseReply(reply('inspection'), 'submission')));
});

test('an empty task scope identifies its task and field while valid empty inputs and dependencies remain allowed',()=>{
  const p=plan();p.tasks[0].allowedPaths=[];
  assert.throws(()=>validatePlan(p,['claude','dsh','codex']),/任务 a 的 allowedPaths 必须至少包含/);
  p.tasks[0].allowedPaths=['a.txt'];assert.doesNotThrow(()=>validatePlan(p,['claude','dsh','codex']));
  const prompt=flowPrompt('plan',p,{});assert.match(prompt,/每个任务的 allowedPaths 必须非空/);
  assert.match(prompt,/不要另建空范围任务/);assert.doesNotMatch(prompt,/allowedPaths、paths、eventIds 均为字符串数组，空数组/);
});

test('a finding with invented fields is refused naming them, and the prompt lists the five finding fields', () => {
  for (const field of ['location', 'severity', 'evidence', 'request']) assert.ok(FLOW_FIELD_RULES.includes(field), field);
  const review = { verdict: 'changes_requested', verificationComplete: true, criteriaResults: [{ criterion: 'A', verified: true, evidence: '读取' }], evidence: [{ kind: 'inspection', description: '查看', result: '看过', eventIds: [] }],
    findings: [{ kind: 'verified', severity: 'should-fix', title: '署名格式', detail: '署名行多了破折号', evidence: '第 2 行' }] };
  assert.throws(() => validateReview(review, ['A']), /不支持的字段：title、detail。缺少的字段：location、request。允许的字段：location、kind、severity、evidence、request、previousFindingId。/);
});
