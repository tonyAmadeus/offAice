import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReply,validateReview,validateSubmission} from '../src/shared/project-flow-protocol';
import {normalizeJointReply,validateJointOpinion,validateJointSummary,validateJointVerification,assertJointMeaning} from '../src/shared/joint-review-protocol';
import {assessReview,assertReviewMeaning,commandEvidenceProblem} from '../src/shared/project-flow-review';
import {bindFlowEvidence} from '../src/backend/project-flow-evidence';
import {jointHarness} from './helpers/joint-review-harness';
import {harness,plan} from './helpers/project-flow-harness';

const envelope=(payload:unknown,extra:Record<string,unknown>={})=>JSON.stringify({protocol:'airoom.project-flow',version:1,kind:'joint-independent',payload,...extra});
const issue={id:'f1',location:'结尾',kind:'verified' as const,severity:'blocking' as const,evidence:'原文在结尾遗漏了出处',request:'补上出处'};

test('missing routing labels and bare payload use only the dispatched kind, preserving the native reply',()=>{
  const payload={summary:'保持原话\n下一段',findings:[]},full={protocol:'airoom.project-flow',version:1,kind:'joint-independent',payload};
  for(const absent of ['protocol','version','kind']){
    const reply={...full};delete reply[absent as keyof typeof reply];
    assert.equal(validateJointOpinion(parseReply(JSON.stringify(reply),'joint-independent')).summary,payload.summary);
  }
  for(const reply of [{payload},payload])assert.equal(validateJointOpinion(parseReply(JSON.stringify(reply),'joint-independent')).summary,payload.summary);
  assert.deepEqual(payload,{summary:'保持原话\n下一段',findings:[]});
  for(const change of [{protocol:'other'},{version:2},{kind:'joint-peer'}])assert.throws(()=>parseReply(envelope(payload,change),'joint-independent'),/不匹配/);
  for(const reply of [null,[],{protocol:'airoom.project-flow'},'只有正文'])assert.throws(()=>parseReply(JSON.stringify(reply),'joint-independent'));
});

test('a malformed latest bare payload or array never falls back to an earlier valid reply',()=>{
  const first=envelope({summary:'旧回复'});
  for(const last of ['{"summary":bad}',JSON.stringify([{summary:'更新意见'}]),'{"payload":{"summary":bad}}','{"summary":"未结束'])assert.throws(()=>parseReply(first+'\n最新回复：'+last,'joint-independent'),/JSON/);
});

test('a missing summary reuses the full existing prose without shortening it or modifying the input',()=>{
  const proposal='## 原稿\n'+('每段文字与标点保持。\n'.repeat(900))+'结尾',raw={proposal},before=structuredClone(raw);
  const parsed=validateJointOpinion(raw,{candidate:true});assert.equal(parsed.summary,proposal);assert.equal(parsed.proposal,proposal);assert.deepEqual(raw,before);
  assert.equal(validateJointSummary({synthesis:proposal},[],[]).summary,proposal);
  assert.deepEqual(normalizeJointReply(normalizeJointReply(raw)),normalizeJointReply(raw));
  assert.throws(()=>validateJointOpinion({findings:[]},{candidate:true}),/summary/);
});

test('a candidate with only a summary retains that actual body and explicitly notes the missing separate draft',()=>{
  const body='这是成员实际写出的完整回复，不能补写另一版。',parsed=validateJointOpinion({summary:body},{candidate:true});
  assert.equal(parsed.proposal,body);assert.equal(parsed.summary,body);assert.match(parsed.unverifiedItems.join(),/未单列候选正文/);
  assert.equal(validateJointOpinion({summary:body}).proposal,undefined);
});

test('missing opinion metadata keeps the original issue and flags uncertainty rather than fabricating proof',()=>{
  const raw={summary:'保留原意见',findings:[{evidence:'原文中的实际观察',request:'可以补一句说明'},{kind:'verified',severity:'blocking'}]},before=structuredClone(raw),parsed=validateJointOpinion(raw);
  assert.equal(parsed.findings.length,2);assert.equal(parsed.findings[0].location,'未注明位置');assert.equal(parsed.findings[0].kind,'suspected');assert.equal(parsed.findings[0].severity,'optional');assert.equal(parsed.findings[0].evidence,raw.findings[0].evidence);
  assert.equal(parsed.findings[1].kind,'verified');assert.equal(parsed.findings[1].severity,'blocking');assert.equal(parsed.findings[1].evidence,'');assert.equal(parsed.findings[1].request,'');
  assert.match(parsed.unverifiedItems.join(),/是否已经证实/);assert.match(parsed.unverifiedItems.join(),/未注明严重程度/);assert.match(parsed.unverifiedItems.join(),/未提供依据/);assert.ok(parsed.replyNotes?.length);assert.deepEqual(raw,before);
  assert.throws(()=>validateJointOpinion({...raw,findings:[{kind:'verified',severity:'urgent'}]}),/严重程度/);
  assert.throws(()=>validateJointOpinion({...raw,findings:[{...raw.findings[0],previousFindingId:'another-review:f1'}]}),/未派发的上次问题/);
});

test('a missing change request never clears an existing blocking issue or invents a repair instruction',()=>{
  const {id,request,...finding}=issue,payload=validateReview({verdict:'changes_requested',verificationComplete:true,findings:[finding]},[]),assessment=assessReview(payload,[]);
  assert.equal(payload.findings[0].request,'');assert.equal(assessment.outcome,'changes_requested');assert.equal(assessment.findings[0].severity,'blocking');assert.match(assessment.reasons.join(),/遗漏了出处/);
  const previous={...issue,location:'未注明位置',request:''},unknown=validateReview({findings:[{kind:'suspected',severity:'optional'}]},[],[previous]);
  assert.equal(unknown.findings[0].previousFindingId,undefined,'unknown labels cannot identify an unrelated old issue');
});

test('missing review lists and verification status are accepted as unreported instead of verified',()=>{
  const payload=validateReview({verdict:'pass'},['实际检查']),assessment=assessReview(payload,['实际检查']);
  assert.equal(payload.verdict,'pass');assert.equal(payload.verificationComplete,false);assert.deepEqual(payload.criteriaResults,[]);assert.equal(assessment.outcome,'inconclusive');assert.match(assessment.reasons.join(),/未能核实/);
  // Missing fields are unreported checks, but an empty object has nothing to keep and stays a format failure.
  assert.throws(()=>validateReview({},[]),/空对象/);
  const incomplete=validateReview({verdict:'pass',verificationComplete:true,criteriaResults:[{criterion:'实际检查'}]},['实际检查']);
  assert.deepEqual(incomplete.criteriaResults,[{criterion:'实际检查',verified:false,evidence:''}]);assert.equal(assessReview(incomplete,['实际检查']).outcome,'inconclusive');
  const claimed=validateReview({verdict:'pass',verificationComplete:true,criteriaResults:[{criterion:'实际检查',verified:true}]},['实际检查']);
  assert.equal(claimed.criteriaResults[0].verified,true);assert.equal(claimed.criteriaResults[0].evidence,'');assert.equal(assessReview(claimed,['实际检查']).outcome,'inconclusive');
});

test('omitted completion results and unambiguous evidence kinds retain observations without inventing completed commands',()=>{
  for(const e of [{description:'完整现有观察'},{result:'完整现有观察'}]){
    const parsed=validateSubmission({summary:'保存现有结果',evidence:[e]});assert.deepEqual(parsed.completionResults,[]);assert.equal(parsed.evidence[0].kind,'inspection');assert.equal(parsed.evidence[0].source,'reported');
  }
  // Keep the observation, but require native completion before treating its command as verified.
  const command=validateSubmission({summary:'成员声明',evidence:[{command:'npm test',result:'成员声称通过'}]}).evidence;
  assert.equal(command[0].kind,'inspection');assert.equal(command[0].command,'npm test');assert.equal(command[0].result,'成员声称通过');assert.equal(command[0].source,'reported');assert.equal(command[0].commandKindInferred,true);assert.equal(commandEvidenceProblem(bindFlowEvidence(command,[],['run'])[0]),'missing-completion');
  const source=validateSubmission({summary:'引用',evidence:[{location:'brief.md',excerpt:'原文'}]}).evidence[0];assert.equal(source.kind,'source');assert.equal(source.sourceVerification,'unverified');
  assert.throws(()=>validateSubmission({summary:'混用依据',evidence:[{command:'npm test',location:'brief.md',excerpt:'原文',result:'声称通过'}]}),/kind/);
});

test('missing summary dispositions remain deferred and explicit decisions stay intact',()=>{
  const other={...issue,id:'f2',request:'补上另一出处'},raw={synthesis:'完整综合正文',dispositions:[{findingId:'f1',action:'accept'}]},before=structuredClone(raw),parsed=validateJointSummary(raw,[issue,other],[]);
  assert.equal(parsed.summary,raw.synthesis);assert.equal(parsed.dispositions[0].action,'accept');assert.equal(parsed.dispositions[1].findingId,'f2');assert.equal(parsed.dispositions[1].action,'defer');assert.ok(parsed.replyNotes?.length);assert.deepEqual(raw,before);
  assert.throws(()=>validateJointSummary({...raw,dispositions:[{findingId:'foreign',action:'defer',reason:'不能串号'}]},[issue],[]),/每条问题/);
  assert.throws(()=>validateJointSummary({...raw,dispositions:[{findingId:'f1'},{findingId:'f1'}]},[issue],[]),/每条问题/);
});

test('an omitted verification outcome stays inconclusive, with exact dispatched issue scope',()=>{
  const parsed=validateJointVerification({summary:'材料不足，保留原文'},['f1']);assert.equal(parsed.outcome,'inconclusive');assert.deepEqual(parsed.findingIds,['f1']);
  assert.throws(()=>validateJointVerification({summary:'无法核实',findingIds:['foreign']},['f1']),/派发的问题/);
  assert.throws(()=>validateJointVerification({summary:'声称确认',outcome:'confirmed'},['f1']),/验证依据/);
});

test('format corrections cannot promote absent verification fields to verified facts or change original issues',()=>{
  const before={criteriaResults:[{criterion:'实际检查',evidence:''}],findings:[{evidence:'现有观察',severity:'blocking'}]};
  assert.throws(()=>assertReviewMeaning(before,{...before,criteriaResults:[{criterion:'实际检查',verified:true,evidence:''}]}),/未提供的核实状态/);
  assert.throws(()=>assertJointMeaning(before,{...before,findings:[{...before.findings[0],kind:'verified'}]}),/未分类/);
  const unsupported={findings:[{kind:'verified',severity:'blocking'}]};
  assert.throws(()=>assertJointMeaning(unsupported,{findings:[{...unsupported.findings[0],evidence:'补正时新造的证明'}]}),/补造依据/);
  const original=parseReply(envelope({summary:'原观点',findings:[{kind:'verified',severity:'blocking',evidence:'原依据'}]}),'joint-independent');
  assert.throws(()=>assertJointMeaning(original,{...original as any,findings:[{...(original as any).findings[0],severity:'optional'}]}),/严重程度/);
});

test('different members missing different fields complete their opinions without correction calls or false acceptance',async()=>{
  const h=await jointHarness({handler:async c=>{
    assert.equal(c.correction,false,'missing fields must not cause a second model call');
    if(c.kind==='joint-independent'){
      const member=c.ctx.session.memberId??c.ctx.session.provider;
      if(member==='dsh')return {raw:JSON.stringify({payload:{proposal:'DeepSeek 原稿',findings:[{kind:'verified',severity:'blocking',evidence:'实际原问题，没有单列修改建议'}]}})};
      if(member==='claude')return {raw:JSON.stringify({summary:'Claude 原答复',findings:[{evidence:'待核实的观察',request:'保留建议'}]})};
      return {proposal:'Codex 原稿'};
    }
    if(c.kind==='joint-summary')return {synthesis:'综合正文保留实际问题，未单列处置。'};
  }});
  try{
    const {jointReviewId:id}=await h.start({peerReview:false}),state=await h.wait(id,s=>s.review.status==='completed');
    assert.equal(h.calls.length,4);assert.equal(h.calls.filter(c=>c.correction).length,0);assert.ok(state.slots.every(s=>s.status==='completed'));assert.equal(state.review.outcome,'changes_requested');
    const deepseek=state.slots.find(s=>s.memberId==='dsh')!.opinion!;assert.equal(deepseek.proposal,'DeepSeek 原稿');assert.equal(deepseek.findings[0].severity,'blocking');assert.equal(deepseek.findings[0].request,'');assert.ok(deepseek.replyNotes?.length);
    assert.equal(state.slots.find(s=>s.memberId==='claude')!.opinion!.proposal,'Claude 原答复');assert.ok(state.review.conclusion!.replyNotes?.length);assert.ok(state.review.dispositions.every(d=>d.action==='defer'));
    assert.ok(h.engine.store.listEvents().some(e=>e.kind==='delta'&&e.text.includes('"payload":{"proposal":"DeepSeek 原稿"')),'native output retains omitted fields');
  }finally{await h.dispose();}
});

test('a missing summary disposition with an optional issue cannot become a ready review',async()=>{
  const h=await jointHarness({handler:async c=>{
    assert.equal(c.correction,false);
    if(c.kind==='joint-independent')return {proposal:'完整原稿',findings:[{kind:'suggestion',severity:'optional',request:'可选优化'}]};
    if(c.kind==='joint-summary')return {summary:'保留建议，但未逐项说明处置'};
  }});
  try{const {jointReviewId:id}=await h.start({peerReview:false}),state=await h.wait(id,s=>s.review.status==='completed');assert.equal(state.review.outcome,'inconclusive');assert.equal(h.calls.length,4);assert.equal(h.calls.filter(c=>c.correction).length,0);assert.ok(state.review.dispositions.every(d=>d.action==='defer'));}
  finally{await h.dispose();}
});

test('an ordinary review missing checks reaches the existing verification decision without formatting retries or file application',async()=>{
  const p=plan();p.tasks=p.tasks.slice(0,1);
  const h=await harness({plan:p,handler:async c=>{
    if(c.kind==='review')return {verdict:'pass'};
  }});
  try{
    await h.confirm();const state=await h.wait(s=>s.decisions.some(d=>d.kind==='unresolved-review'));
    assert.equal(h.calls.filter(c=>c.correction).length,0);assert.equal(state.reviews[0].status,'inconclusive');assert.equal(state.reviews[0].verdict,'pass');assert.equal(state.tasks[0].returnCount,0);assert.equal(await h.original(),'old-a');
    assert.ok(h.engine.store.list<import('../src/shared/project-flow').FlowOperation>('flow_operations').filter(op=>op.kind==='task-review').every(op=>op.state!=='blocked'));
  }finally{await h.dispose();}
});

test('a whole-round check missing lists uses the same tolerant parser and keeps its verification decision',async()=>{
  const p=plan();p.tasks=p.tasks.slice(0,1);
  const h=await harness({plan:p,handler:async c=>c.kind==='integration-check'?{verdict:'pass'}:undefined});
  try{
    await h.confirm();const state=await h.wait(s=>s.decisions.some(d=>d.kind==='unresolved-review'&&!d.taskId));
    assert.equal(h.calls.filter(c=>c.correction).length,0);assert.equal(state.integrations[0].verdict,'pass');assert.equal(state.integrations[0].outcome,'inconclusive');assert.match(state.integrations[0].outcomeReasons!.join(),/未能核实/);assert.equal(await h.original(),'old-a');
    assert.ok(h.engine.store.list<import('../src/shared/project-flow').FlowOperation>('flow_operations').filter(op=>op.kind==='integration-check').every(op=>op.state==='done'));
  }finally{await h.dispose();}
});
