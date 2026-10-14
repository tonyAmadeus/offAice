import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReply,validateReview,validateSubmission} from '../src/shared/project-flow-protocol';
import {AMBIGUOUS_FIELDS,COMMAND_RESULT_MISSING,normalizeFlowPayload} from '../src/shared/flow-format';

const review={verdict:'pass',verificationComplete:true,criteriaResults:[],findings:[],evidence:[]};
const envelope=JSON.stringify({protocol:'airoom.project-flow',version:1,kind:'review',payload:review});

test('prose brackets after a reply do not discard it',()=>{
  for(const tail of ['详见 [说明](docs/a.md)。','参考 [1]','模板里的 {name} 保留。','如需补充请回复 {}'])
    assert.deepEqual(parseReply('复核完成。\n'+envelope+'\n'+tail,'review'),review,tail);
  // A later object that really is JSON still wins, and a broken later reply is still reported.
  assert.throws(()=>parseReply(envelope+'\n更正：{"verdict": "pass",, }}','review'),/括号|语法/);
  assert.throws(()=>parseReply(envelope+'\n[{"verdict":"pass"}]','review'),/数组/);
});

test('an empty review has nothing to keep and is not accepted as an inconclusive check',()=>{
  assert.throws(()=>validateReview(parseReply('{}','review'),['标准']),/空对象/);
  assert.throws(()=>validateReview(parseReply('我没法完成 {}','review'),['标准']),/空对象/);
});

test('empty placeholders for a list mean no items',()=>{
  for(const findings of [null,{},'',[]])assert.deepEqual(validateReview({...review,findings},[]).findings,[],JSON.stringify(findings));
});

test('a command description is never copied into its result',()=>{
  const [e]=validateSubmission({summary:'s',evidence:[{kind:'command',command:'npm test',description:'运行测试，全部通过'}]}).evidence;
  assert.equal(e.kind,'command');assert.equal(e.description,'运行测试，全部通过');assert.equal(e.result,COMMAND_RESULT_MISSING);
  const [inspection]=validateSubmission({summary:'s',evidence:[{kind:'inspection',description:'查看了目录结构'}]}).evidence;
  assert.equal(inspection.result,'查看了目录结构');
});

test('aliases that only differ in spelling agree; differing content skips the correction',()=>{
  assert.equal((normalizeFlowPayload({...review,verification_complete:'true'},'review') as {verificationComplete:boolean}).verificationComplete,true);
  assert.throws(()=>normalizeFlowPayload({...review,verification_complete:'false'},'review'),(error:{code?:string})=>error.code===AMBIGUOUS_FIELDS);
  // parseReply defers the conflict so the original stays readable; validation then raises it.
  const deferred=parseReply(JSON.stringify({...review,verification_complete:false}),'review');
  assert.throws(()=>validateReview(deferred,[]),(error:{code?:string})=>error.code===AMBIGUOUS_FIELDS);
});
