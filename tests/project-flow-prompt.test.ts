import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FLOW_FIELD_RULES, FLOW_EVIDENCE_RULES, FLOW_CRITERIA_RULES, flowPrompt, parseReply, validatePlan, validateReview, validateSubmission } from '../src/shared/project-flow-protocol';
import {plan,harness} from './helpers/project-flow-harness';

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
  assert.ok(prompt.includes(FLOW_EVIDENCE_RULES));
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

test('stage prompts exclude unrelated submission rules while keeping their own decisions and guards',()=>{
  for(const kind of ['plan','task-addition','task-rearrange','next-round']){
    const prompt=flowPrompt(kind,{},{});assert.doesNotMatch(prompt,/findings 每项|exitCode 仅|首次退回 changes_requested/);
    assert.match(prompt,/check 为可核对事实、judge 由成员评价、owner 由用户决定/);
  }
  const submission=flowPrompt('submission',{},{});assert.doesNotMatch(submission,/首次退回|previousFindingChecks|verdict 只能是/);
  assert.match(submission,/completionResults 每项/);assert.match(submission,/disputes 每项/);assert.match(submission,/disputeRulings 必须遵守/);
  const ruling=flowPrompt('adjudication',{},{});assert.match(ruling,/uphold-author\|uphold-review\|inconclusive/);assert.doesNotMatch(ruling,/verdict 只能是 pass/);
  for(const kind of ['review','integration-check','peer-review','requested-check']){
    const prompt=flowPrompt(kind,{},{});assert.match(prompt,/首次退回 changes_requested 必须有已核实/);
    assert.match(prompt,/新发现的只有 blocking 才能再次退回/);assert.match(prompt,/judge 类写 assessments/);assert.match(prompt,/疑似 blocking 未查明为 inconclusive/);
    assert.doesNotMatch(prompt,/tasks 每项|不要写成 "owner:/);
  }
  for(const kind of ['plan','submission','review','joint-independent','joint-summary','verification','round-report','adjudication']){
    const prompt=flowPrompt(kind,{},{});assert.match(prompt,/不扩大权限/);assert.match(prompt,/不能改变 verdict、verified 或 resolved/);assert.match(prompt,/不要伪造验证结果/);
  }
  assert.ok(flowPrompt('plan',{},{}).length<2000,'planning instructions must stay bounded independently of task material');
  assert.ok(flowPrompt('submission',{},{}).length<2000,'submission must not carry the review manual');
});

test('prompt reduction preserves exact task material including commands, supplements and complete long text',()=>{
  const context={task:{goal:'保留空格  和换行\n'+('不删任务要求。'.repeat(4000)),allowedPaths:['docs/最终稿.md'],completionCriteria:[{text:'保留旧内容',kind:'check'}],supplements:[{text:'用户最新要求：不要改第一段。',status:'delivered'}]},
    fixes:[{id:'real-finding',request:'修复旧问题'}],commands:['powershell -Command "Write-Output \'$test\'"'],acceptedMeetingBackground:{messages:[{id:'original',text:'决定：保持兼容性'}]}};
  const saved=structuredClone(context),prompt=flowPrompt('submission',{summary:''},context);
  assert.deepEqual(JSON.parse(prompt.split('\n任务材料：')[1]),saved);assert.deepEqual(context,saved);
  const combined=flowPrompt('integration-check',{nextRoundRecommendation:{mode:'as-planned'}},context);assert.ok(combined.includes(FLOW_CRITERIA_RULES));
});

test('optimized project tasks receive every active long-term memory and still deliver real fixture files',async()=>{
  const h=await harness();try{
    const member=h.engine.store.members().find(item=>item.id==='claude')!;
    const memories=[{id:'first',text:'用户长期约定：'+('保留旧成果，不覆盖原始内容。'.repeat(80)),source:'manual',createdAt:new Date().toISOString()},
      {id:'last',text:'长期待办：'+('先整理素材再开始制作。'.repeat(80)),source:'imported',createdAt:new Date().toISOString()},
      {id:'off',text:'这条已关闭的旧约定不能再发送。',source:'manual',createdAt:new Date().toISOString(),off:true}];
    await h.engine.invoke('team.save',{member:{...member,memories}});await h.confirm();await h.wait(state=>state.rounds[0]?.status==='awaiting_acceptance');
    const task=h.calls.find(call=>call.kind==='submission'&&(call.ctx.session.memberId??call.ctx.session.provider)==='claude')!;assert.ok(task);
    for(const entry of memories.filter(item=>!item.off))assert.ok(task.ctx.persona?.includes(entry.text),'entire active memory must reach the executor');
    assert.ok(!task.ctx.persona?.includes(memories[2].text));assert.deepEqual(h.engine.store.members().find(item=>item.id==='claude')!.memories,memories);
    await h.accept();await h.wait(state=>state.flow?.status==='completed');assert.equal(await h.original(),'new-a');
  }finally{await h.dispose();}
});

test('known tool aliases retain the original inspection while invented evidence kinds are refused', () => {
  const compatible=validateSubmission(parseReply(reply('tool'), 'submission')).evidence[0];
  assert.equal(compatible.kind,'inspection');assert.equal(compatible.source,'reported');
  assert.throws(() => validateSubmission(parseReply(reply('invented-kind'), 'submission')), /只能是 command、quote、inspection 或 source，收到 "invented-kind"/);
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
  assert.throws(() => validateReview(review, ['A']), /不支持的字段：title、detail。允许的字段：location、kind、severity、evidence、request、previousFindingId。/);
});
