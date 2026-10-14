import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import type {TimelineEvent} from '../src/shared/types';
import {normalizeFlowPayload,retainCommandProvenance} from '../src/shared/flow-format';
import {parseReply,validateReview,validateSubmission} from '../src/shared/project-flow-protocol';
import {assertJointMeaning,retainJointText,validateJointOpinion} from '../src/shared/joint-review-protocol';
import {assessReview,commandEvidenceProblem,inferredCommandNotes} from '../src/shared/project-flow-review';
import {bindFlowEvidence} from '../src/backend/project-flow-evidence';
import {formatCorrectionSummary,type FormatCorrection} from '../src/backend/format-corrections';
import {jointHarness,opinion} from './helpers/joint-review-harness';
import {harness,plan} from './helpers/project-flow-harness';

const claim={verdict:'pass',verificationComplete:true,criteriaResults:[{criterion:'内容正确',verified:true,evidence:'成员报告测试通过'}],findings:[],evidence:[{command:'npm test',result:'全部通过',exitCode:0}]};
const completed=(command='npm test',exitCode=0):TimelineEvent=>({id:'native',runId:'run',sessionId:'session',kind:'tool',fidelity:'native',data:{id:'tool',command,status:'completed',exitCode},text:'实际工具记录',at:'2026-10-14T00:00:00Z'} as TimelineEvent);

test('an inferred command survives repeated parsing without becoming verified or blocking the original reply',()=>{
  const raw=structuredClone(claim),envelope=JSON.stringify({protocol:'airoom.project-flow',version:1,kind:'review',payload:raw});
  const parsed=parseReply(envelope,'review'),again=normalizeFlowPayload(parsed,'review'),review=validateReview(again,['内容正确']);
  review.evidence=bindFlowEvidence(review.evidence,[],['run']);
  assert.equal(review.verdict,'pass');assert.equal(review.evidence[0].result,'全部通过');assert.equal(review.evidence[0].kind,'inspection');
  assert.equal(review.evidence[0].commandKindInferred,true);assert.equal(commandEvidenceProblem(review.evidence[0]),'missing-completion');
  assert.equal(assessReview(review,['内容正确']).outcome,'inconclusive');assert.match(inferredCommandNotes(review.evidence).join(''),/npm test.*尚无相符/);
  assert.deepEqual(raw,claim);assert.ok(!envelope.includes('commandKindInferred'));
  assert.throws(()=>validateSubmission({summary:'原文',evidence:[{...claim.evidence[0],commandKindInferred:true}]}),/不支持的字段/);
});

test('inferred commands require the same matching successful native execution as explicit commands',()=>{
  const evidence=validateReview(claim,['内容正确']).evidence;
  const valid=bindFlowEvidence(evidence,[completed()],['run']);
  assert.equal(commandEvidenceProblem(valid[0]),undefined);assert.deepEqual(inferredCommandNotes(valid),[]);
  assert.equal(assessReview({...validateReview(claim,['内容正确']),evidence:valid},['内容正确']).outcome,'pass');
  for(const events of [[completed('npm test-extra')],[completed('npm test',1)],[{...completed(),runId:'another'}],[{...completed(),fidelity:'derived' as const}]]){
    const bound=bindFlowEvidence(evidence,events,['run']);assert.ok(commandEvidenceProblem(bound[0]));assert.ok(inferredCommandNotes(bound).length);
  }
  const explicit=validateSubmission({summary:'阅读检查',evidence:[{kind:'inspection',command:'Get-Content a.txt',description:'已看到原文'}]}).evidence;
  assert.equal(commandEvidenceProblem(bindFlowEvidence(explicit,[],['run'])[0]),undefined,'explicit reading observations retain their existing meaning');
});

test('repair provenance keeps separate observations of the same command without mutating either reply',()=>{
  const before=normalizeFlowPayload({summary:'原报告',evidence:[{command:'npm test',result:'第一次未完成'},{command:'npm test',result:'第二次声称通过'}]},'submission');
  const after={summary:'原报告',evidence:[{kind:'inspection',command:'npm test',result:'第一次未完成'},{kind:'inspection',command:'npm test',result:'第二次声称通过'}]},native=structuredClone(after);
  const kept=validateSubmission(retainCommandProvenance(before,after));
  assert.deepEqual(kept.evidence.map(e=>e.result),['第一次未完成','第二次声称通过']);assert.ok(kept.evidence.every(e=>e.commandKindInferred));assert.deepEqual(after,native);
});

test('project review keeps an untyped command claim without a format retry and asks for verification',async()=>{
  const p=plan();p.tasks=p.tasks.slice(0,1);
  const h=await harness({plan:p,handler:async c=>c.kind==='review'?{...claim,criteriaResults:c.material.task.completionCriteria.map((criterion:string)=>({criterion,verified:true,evidence:'成员报告通过'}))}:undefined});
  try{
    await h.confirm();const s=await h.wait(s=>s.decisions.some(d=>d.kind==='unresolved-review'&&d.status==='open'));
    assert.equal(h.calls.filter(c=>c.correction).length,0);assert.equal(s.reviews[0].verdict,'pass');assert.equal(s.reviews[0].status,'inconclusive');
    assert.equal(s.reviews[0].evidence[0].result,'全部通过');assert.equal(await h.original(),'old-a');
  }finally{await h.dispose();}
});

test('joint verification preserves reported certainty separately when command completion is absent',async()=>{
  const h=await jointHarness({handler:async c=>{
    if(c.kind==='joint-independent')return {...opinion('中性'),findings:[{location:'细节',kind:'suspected',severity:'optional',evidence:'待查',request:'核对'}]};
    if(c.kind==='joint-summary')return {summary:'需要核查',verificationRequests:[{findingIds:[c.material.findings[0].id],instruction:'实际核对命令'}]};
    if(c.kind==='verification')return {findingIds:c.material.findingIds,outcome:'confirmed',summary:'原核查结论',evidence:claim.evidence};
  }});
  try{
    const {jointReviewId:id}=await h.start({peerReview:false}),s=await h.wait(id,s=>s.review.status==='awaiting_decision');
    const verification=s.slots.find(s=>s.stage==='verification')!.verification!;
    assert.equal(verification.outcome,'inconclusive');assert.equal(verification.reportedOutcome,'confirmed');assert.equal(verification.summary,'原核查结论');
    assert.match(verification.replyNotes!.join(''),/命令尚未核实/);assert.equal(h.calls.filter(c=>c.correction).length,0);
    assert.ok(s.slots.filter(s=>s.stage==='independent').every(s=>s.opinion!.proposal==='中性 的候选正文'));
  }finally{await h.dispose();}
});

test('an unrelated joint correction cannot erase the provenance of an inferred command',async()=>{
  const h=await jointHarness({handler:async c=>{
    if(c.kind==='joint-independent')return {...opinion('原稿'),evidence:c.correction?[{kind:'inspection',description:'全部通过',result:'全部通过'}]:claim.evidence,...(!c.correction?{extraKey:'需要补正的其他字段'}:{})};
  }});
  try{
    const {jointReviewId:id}=await h.start({reviewerMemberIds:['dsh'],peerReview:false}),s=await h.wait(id,s=>s.review.status==='completed'),draft=s.slots.find(s=>s.stage==='independent')!.opinion!;
    assert.equal(h.calls.filter(c=>c.correction).length,1);assert.equal(draft.evidence[0].commandKindInferred,true);assert.equal(draft.evidence[0].command,'npm test');
    assert.match(draft.unverifiedItems.join(''),/命令尚未核实/);assert.equal(draft.proposal,'原稿 的候选正文');
  }finally{await h.dispose();}
});

test('an unrelated project correction retains a command claim even when the repair omits its evidence list',async()=>{
  const p=plan();p.tasks=p.tasks.slice(0,1);
  const h=await harness({plan:p,handler:async c=>c.kind==='review'?{...claim,criteriaResults:p.tasks[0].completionCriteria.map(criterion=>({criterion,verified:true,evidence:'成员报告通过'})),evidence:c.correction?[]:claim.evidence,...(!c.correction?{extraKey:'需要补正的其他字段'}:{})}:undefined});
  try{
    await h.confirm();const s=await h.wait(s=>s.decisions.some(d=>d.kind==='unresolved-review'&&d.status==='open')||s.rounds[0]?.status==='awaiting_acceptance');
    assert.equal(s.reviews[0].status,'inconclusive');assert.equal(s.reviews[0].evidence[0].commandKindInferred,true);assert.equal(s.reviews[0].evidence[0].result,'全部通过');
    assert.equal(h.calls.filter(c=>c.correction).length,1);assert.equal(await h.original(),'old-a');
  }finally{await h.dispose();}
});

test('format correction cannot change the author a peer finding refers to',()=>{
  const before={summary:'方案 A 缺少结论',findings:[{candidate:'A',location:'结尾',kind:'suspected',severity:'should-fix',evidence:'未写结论',request:'补上结论'}]};
  const changed={...before,findings:[{...before.findings[0],candidate:'B'}]};
  assert.throws(()=>assertJointMeaning(before,changed),/候选归属/);
  const retained=retainJointText(before,changed);assert.equal((retained as any).findings[0].candidate,'A');assert.doesNotThrow(()=>assertJointMeaning(before,retained));
  const absent={...before,findings:[{...before.findings[0],candidate:undefined}]};
  assert.equal((retainJointText(absent,changed) as any).findings[0].candidate,undefined,'a repair cannot add a new attribution');
});

test('a necessary peer correction retains candidate A while accepting repaired evidence formatting',async()=>{
  const h=await jointHarness({handler:async c=>{
    if(c.kind==='joint-independent')return opinion('中性');
    if(c.kind==='joint-peer')return {summary:'方案 A 缺少结论',findings:[{candidate:c.correction?'B':'A',location:'结尾',kind:'suspected',severity:'should-fix',evidence:'未写结论',request:'补上结论'}],evidence:[{kind:c.correction?'inspection':'tool-check',description:'原观察',result:'原观察'}]};
  }});
  try{
    const {jointReviewId:id}=await h.start(),s=await h.wait(id,s=>s.review.status==='completed');
    assert.equal(h.calls.filter(c=>c.correction).length,3);
    for(const peer of s.slots.filter(s=>s.stage==='peer')){
      const finding=peer.opinion!.findings[0];assert.equal(finding.candidate,'A');assert.equal(finding.targetSlotId,peer.peerMap!.find(p=>p.letter==='A')!.slotId);
    }
  }finally{await h.dispose();}
});

test('summary material has no structural author mapping or named peer exclusion while stored opinions retain names',async()=>{
  const h=await jointHarness({handler:async c=>{
    if(c.kind==='joint-independent'||c.kind==='joint-peer')return {...opinion('中性',c.kind==='joint-independent'),findings:[{location:'方案 A 结尾',kind:'suggestion',severity:'optional',evidence:'缺少结论',request:'补一句',...(c.kind==='joint-peer'?{candidate:'A'}:{})}]};
  }});
  try{
    const {jointReviewId:id}=await h.start(),s=await h.wait(id,s=>s.review.status==='completed'),material=h.calls.find(c=>c.kind==='joint-summary')!.material;
    assert.equal(material.candidates.length,3);assert.equal(material.peerOpinions.length,3);assert.equal(material.findings.length,6);
    const findIdentityKeys=(v:any):boolean=>!!v&&typeof v==='object'&&Object.entries(v).some(([key,value])=>['memberId','memberName'].includes(key)||findIdentityKeys(value));
    assert.equal(findIdentityKeys(material),false);assert.ok(!/codex|claude|dsh/.test(JSON.stringify(material)));
    assert.ok(material.peerOpinions.every((peer:any)=>peer.targets.length===2&&peer.targets.every((t:any)=>material.candidates.some((candidate:any)=>candidate.slotId===t.slotId))));
    assert.ok(s.review.findings.every(f=>f.memberId&&f.slotId));assert.ok(s.slots.filter(s=>s.stage==='peer').every(s=>s.memberId&&s.peerMap?.length===2));
    assert.deepEqual(material.candidates.map((c:any)=>c.slotId),material.candidates.map((c:any)=>c.slotId).sort(),'opaque IDs break roster-order attribution');
  }finally{await h.dispose();}
});

test('equivalent aliases follow each field type and never coerce valid prose into numbers',()=>{
  for(const raw of [{summary:'123',Summary:123},{Summary:123,summary:'123'},{summary:'false',SUMMARY:false}]){
    assert.equal(typeof validateJointOpinion(raw).summary,'string');assert.equal(validateJointOpinion(raw).summary,String(raw.summary??raw.SUMMARY));
  }
  const review=validateReview({...claim,verdict:'PASS',VERDICT:'pass',verification_complete:'true',evidence:[{kind:'inspection',KIND:'INSPECTION',description:'原观察',exitCode:'0',exit_code:0}],findings:[{location:'结尾',kind:'suggestion',severity:'should-fix',SEVERITY:'SHOULD_FIX',evidence:'原依据',request:'原建议'}]},['内容正确']);
  assert.equal(review.findings[0].severity,'should-fix');assert.equal(review.verificationComplete,true);assert.equal(review.evidence[0].exitCode,0);
  for(const raw of [{summary:'123',Summary:124},{summary:'true',Summary:'TRUE'},{summary:'原文',Summary:'改写'},{...claim,verification_complete:false}])assert.throws(()=>normalizeFlowPayload(raw,'verdict' in raw?'review':'joint-independent'),/重复且内容不一致/);
});

test('last-stage correction statistics count actual original replies and separate legacy and repair replies',async()=>{
  const h=await jointHarness({handler:async c=>c.kind==='joint-summary'&&!c.correction?{raw:'{"summary":"未结束'}:undefined});
  try{
    const {jointReviewId:id}=await h.start({reviewerMemberIds:['codex'],peerReview:false});await h.wait(id,s=>s.review.status==='completed');
    const records=h.engine.store.list<FormatCorrection>('format_corrections');assert.equal(records.length,1);assert.ok(records[0].operationId&&records[0].runId&&records[0].replyAt);
    const summary=formatCorrectionSummary(h.engine.store) as any;
    assert.equal(summary.corrections,1);assert.equal(summary.flowReplies,1);assert.equal(summary.correctionReplies,1);assert.equal(summary.legacyCorrections,0);
    const op=h.engine.store.get<any>('flow_operations',records[0].operationId!)!;h.engine.store.put('flow_operations','duplicate',{...op,id:'duplicate',createdAt:'2000-01-01T00:00:00Z'});
    assert.equal((formatCorrectionSummary(h.engine.store) as any).flowReplies,1,'recoveries and old operations count each completed run once');
    h.engine.store.put('format_corrections','old',{...records[0],id:'old',runId:undefined,replyAt:undefined});
    assert.equal((formatCorrectionSummary(h.engine.store) as any).legacyCorrections,1);assert.equal((formatCorrectionSummary(h.engine.store) as any).corrections,1);
    h.engine.store.delete('format_corrections',records[0].id);
    const legacy=formatCorrectionSummary(h.engine.store) as any;assert.equal(legacy.flowReplies,null);assert.equal(legacy.corrections,0);assert.equal(legacy.recordedCorrections,1);
  }finally{await h.dispose();}
});
