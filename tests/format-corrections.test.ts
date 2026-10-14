import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {FlowError} from '../src/shared/project-flow';
import {AMBIGUOUS_FIELDS} from '../src/shared/flow-format';
import {formatCategory,formatCorrectionSummary,type FormatCorrection} from '../src/backend/format-corrections';
import {jointHarness} from './helpers/joint-review-harness';

test('format problems fall into coarse groups that point at the tolerance that would help',()=>{
  const cases:[unknown,string][]=[
    [new FlowError('INVALID_PROTOCOL','最后的正式 JSON 回复有语法错误。'),'syntax'],
    [new FlowError('INVALID_PROTOCOL','协议名称、版本或用途不匹配。'),'envelope'],
    [new FlowError('INVALID_PROTOCOL','字段不符合结构。缺少的字段：summary。'),'missing-field'],
    [new FlowError('INVALID_PROTOCOL','字段不符合结构。不支持的字段：title。'),'extra-field'],
    [new FlowError('INVALID_PROTOCOL','复核结论无效。'),'value'],
    [new FlowError('INVALID_PROTOCOL','文字字段不能为空或超过长度限制。'),'empty-text'],
    [new FlowError('UNVERIFIED_EVIDENCE','命令声明没有相符的实际完成记录'),'evidence'],
    [new FlowError(AMBIGUOUS_FIELDS,'同义字段 verdict 重复且内容不一致'),'ambiguous'],
    [new Error('别的问题'),'other'],
  ];
  for(const [error,category] of cases)assert.equal(formatCategory(error),category,(error as Error).message);
});

test('a correction is recorded with its stage, executor, reason and outcome, but not the reply text',async()=>{
  const secret='成员原文不应出现在统计里';
  const h=await jointHarness({handler:async call=>{
    const member=call.ctx.session.memberId??call.ctx.session.provider;
    if(call.kind==='joint-independent'&&member==='claude'&&!call.correction)return {raw:secret+' {"summary": "未闭合'};
    return undefined;
  }});
  try{
    const {jointReviewId:id}=await h.start();await h.wait(id,s=>s.review.status==='completed');
    const records=h.engine.store.list<FormatCorrection>('format_corrections');
    assert.equal(records.length,1);
    assert.deepEqual({area:records[0].area,stage:records[0].stage,memberId:records[0].memberId,executor:records[0].executor,category:records[0].category,outcome:records[0].outcome},
      {area:'joint-review',stage:'joint-independent',memberId:'claude',executor:'claude',category:'syntax',outcome:'corrected'});
    assert.ok(!JSON.stringify(records).includes(secret));
    const summary=formatCorrectionSummary(h.engine.store) as {corrections:number;flowReplies:number;byOutcome:Record<string,number>;byExecutor:Record<string,number>};
    assert.equal(summary.corrections,1);assert.deepEqual(summary.byOutcome,{corrected:1});assert.deepEqual(summary.byExecutor,{claude:1});assert.ok(summary.flowReplies>=1);
  }finally{await h.dispose();}
});
