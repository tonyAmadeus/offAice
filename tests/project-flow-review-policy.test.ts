import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {assessReview,assertReviewMeaning,memberCriteria} from '../src/shared/project-flow-review';
import {validatePlan,validateReview} from '../src/shared/project-flow-protocol';
import type {FlowOperation,Plan,Task} from '../src/shared/project-flow';
import {harness,plan,passing,inconclusive,failed} from './helpers/project-flow-harness';

test('new plans reject human sign-off criteria while product acceptance UI remains testable',()=>{
  for(const criterion of ['用户（APan）确认本轮结果','待用户验收通过','human approval received','APan 确认文件结果']){
    const p=plan();p.acceptanceCriteria=[criterion];assert.throws(()=>validatePlan(p,['codex','claude','dsh'],[],'APan'),/不能依赖用户/);
    p.acceptanceCriteria=['文件正确'];p.tasks[0].completionCriteria=[criterion];assert.throws(()=>validatePlan(p,['codex','claude','dsh'],[],'APan'),/不能依赖用户/);
  }
  const p=plan();p.acceptanceCriteria=['用户可以点击验收按钮','README 说明用户验收流程'];assert.doesNotThrow(()=>validatePlan(p,['codex','claude','dsh']));
  assert.deepEqual(memberCriteria(['文件正确','用户确认结果']),{required:['文件正确'],deferred:['用户确认结果'],judged:[]});
});
test('shape correction preserves the verdict and verified facts, including suspected findings',()=>{
  const original=passing(['A']);assert.throws(()=>assertReviewMeaning(original,{...original,verdict:'inconclusive'}),/改变了原复核结论/);
  assert.throws(()=>assertReviewMeaning(inconclusive(['A']),passing(['A'])),/改变了原/);
  const missing={...original,criteriaResults:undefined};assert.throws(()=>assertReviewMeaning(missing,original),/新增了验证声明/);
  const suspected={...original,findings:[{location:'a.txt',kind:'suspected',severity:'blocking',evidence:'',request:'缺少材料，需要核实'}]};assert.equal(assessReview(validateReview(suspected,['A']),['A']).outcome,'inconclusive');
  assert.throws(()=>assertReviewMeaning(suspected,{...suspected,findings:[{...suspected.findings[0],kind:'verified',evidence:'已证实'}]}),/是否已经证实/);
});
test('optional-only findings pass with suggestions; return requires a verified blocking or should-fix issue',()=>{
  const optional={...passing(['A']),verdict:'changes_requested' as const,findings:[{location:'a.txt',kind:'suggestion' as const,severity:'optional' as const,evidence:'建议更清晰',request:'可以补一句注释'}]};assert.equal(assessReview(optional,['A']).outcome,'pass');assert.equal(optional.verdict,'changes_requested');
  assert.equal(assessReview({...optional,findings:[]},['A']).outcome,'pass');assert.equal(assessReview({...optional,criteriaResults:inconclusive(['A']).criteriaResults},['A']).outcome,'inconclusive');
  for(const severity of ['blocking','should-fix'] as const)assert.equal(assessReview({...optional,findings:[{...optional.findings[0],kind:'verified',severity,evidence:'已检查并定位具体缺陷'}]},['A']).outcome,'changes_requested');
});
test('personal, integration and peer optional suggestions are retained without generating a correction task',async()=>{
  const h=await harness({peer:true,handler:async c=>['review','integration-check','peer-review'].includes(c.kind)?{...passing(c.material.criteria??c.material.task.completionCriteria),verdict:'changes_requested',findings:[{location:'a.txt',kind:'suggestion',severity:'optional',evidence:'现有内容已经达到标准',request:'可选：增加注释'}]}:undefined});try{await h.confirm();const s=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');assert.equal(s.tasks.length,2);assert.ok(s.tasks.every(t=>t.returnCount===0));assert.ok(s.reviews.every(r=>r.verdict==='changes_requested'&&r.outcome==='pass'&&r.findings[0].severity==='optional'));assert.equal(s.integrations.at(-1)!.outcome,'pass');assert.equal(s.integrations.at(-1)!.peerReview!.outcome,'pass');assert.equal(s.rounds[0].integrationFixCount,0);assert.equal(s.decisions.length,0);
  }finally{await h.dispose();}
});
test('a reported pass with an unverified criterion keeps its original meaning and asks for recheck without a format retry',async()=>{
  const h=await harness({handler:async c=>c.kind==='review'&&c.material.task.key==='a'?{...passing(c.material.task.completionCriteria),criteriaResults:inconclusive(c.material.task.completionCriteria).criteriaResults}:undefined});
  try{await h.confirm();const s=await h.wait(s=>s.decisions.some(d=>d.kind==='unresolved-review'));const task=s.tasks.find(t=>t.key==='a')!,review=s.reviews.find(r=>r.taskId===task.id)!;
    assert.equal(review.verdict,'pass');assert.equal(review.outcome,'inconclusive');assert.equal(task.returnCount,0);assert.equal(s.rounds[0].integrationFixCount,0);assert.equal(h.calls.some(c=>c.correction),false);assert.equal(await h.original(),'old-a');assert.ok(s.decisions.find(d=>d.taskId===task.id)!.options.every(option=>option!=='我来判断'));
  }finally{await h.dispose();}
});
test('legacy human acceptance criteria are deferred during review and are not forged as verified',async()=>{
  const h=await harness();try{
    const old=h.engine.store.get<Plan>('flow_plans',(await h.state()).plan!.id)!;h.engine.store.put('flow_plans',old.id,{...old,acceptanceCriteria:['文件内容正确','用户（APan）确认本轮结果'],tasks:old.tasks.map(t=>({...t,completionCriteria:[...t.completionCriteria,'用户确认结果']}))});await h.confirm();
    const s=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');assert.equal(s.decisions.filter(d=>d.kind==='unresolved-review').length,0);assert.equal(s.rounds[0].integrationFixCount,0);assert.ok(s.reviews.every(r=>r.deferredUserCriteria?.includes('用户确认结果')));assert.ok(s.reviews.every(r=>r.criteriaResults!.every(c=>!c.criterion.includes('用户'))));
    assert.deepEqual(s.integrations.at(-1)!.deferredUserCriteria,['用户确认结果','用户（APan）确认本轮结果']);assert.match(s.rounds[0].report!.systemNotes!.map(n=>n.text).join(),/需要你确认/);assert.equal(await h.original(),'old-a');
  }finally{await h.dispose();}
});
test('an inconclusive whole-round check rechecks the same version without creating fixes or redoing submissions',async()=>{
  let checks=0;const h=await harness({handler:async c=>c.kind==='integration-check'&&++checks===1?inconclusive(c.material.criteria):undefined});
  try{await h.confirm();let s=await h.wait(s=>s.decisions.some(d=>d.stage==='integration-check'));const d=s.decisions.find(d=>d.stage==='integration-check')!,version=s.integrations.at(-1)!.version!.fingerprint;
    assert.equal(s.rounds[0].integrationFixCount,0);assert.equal(s.tasks.length,2);assert.equal(s.overview.remaining,0);assert.equal(s.overview.stage?.kind,'decision');await h.answer(d,'重新检查');
    s=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');assert.equal(s.integrations.at(-1)!.version!.fingerprint,version);assert.equal(s.rounds[0].integrationFixCount,0);assert.equal(h.calls.filter(c=>c.kind==='submission').length,2);assert.equal(checks,2);
  }finally{await h.dispose();}
});
test('manual judgment hands an inconclusive round to user acceptance and never fakes a passing check',async()=>{
  const h=await harness({handler:async c=>c.kind==='integration-check'?inconclusive(c.material.criteria):undefined});try{await h.confirm();const blocked=await h.wait(s=>s.decisions.some(d=>d.kind==='unresolved-review'));await h.answer(blocked.decisions.find(d=>d.kind==='unresolved-review')!,'我来判断');
    const ready=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');assert.equal(ready.integrations.at(-1)!.verdict,'inconclusive');assert.equal(ready.integrations.at(-1)!.outcome,'inconclusive');assert.equal(ready.rounds[0].integrationFixCount,0);assert.match(ready.rounds[0].report!.systemNotes!.map(n=>n.text).join(),/尚未通过/);assert.equal(await h.original(),'old-a');await h.accept();await h.wait(s=>s.flow?.status==='completed');assert.equal(await h.original(),'new-a');
  }finally{await h.dispose();}
});
test('changing the checker replaces only the current round leader; subsequent rounds keep the project leader',async()=>{
  const p=plan();p.rounds.push({key:'r2',title:'第二轮',goal:'第二轮正确',requiresUserAcceptance:true});p.tasks.push({...p.tasks[0],key:'c',roundKey:'r2',completionCriteria:['C 正确'],dependencies:['a']});let checks=0;
  const h=await harness({plan:p,handler:async c=>c.kind==='integration-check'&&++checks===1?inconclusive(c.material.criteria):undefined});try{await h.confirm();const blocked=await h.wait(s=>s.decisions.some(d=>d.kind==='unresolved-review'));await h.answer(blocked.decisions.find(d=>d.kind==='unresolved-review')!,'换负责人检查',{memberId:'dsh',opinion:'检查现有成果'});
    const ready=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');assert.equal(ready.flow!.leadMemberId,'codex');assert.equal(ready.rounds[0].leadMemberId,'dsh');assert.equal(ready.rounds[1].leadMemberId,undefined);assert.equal(h.calls.filter(c=>c.kind==='integration-check')[1].ctx.session.provider,'dsh');assert.equal(h.calls.find(c=>c.kind==='round-report')!.ctx.session.provider,'dsh');await h.accept();const next=await h.wait(s=>s.decisions.some(d=>d.kind==='next-round'&&d.status==='open'));await h.answer(next.decisions.find(d=>d.kind==='next-round'&&d.status==='open')!,'按原计划开始');await h.wait(s=>s.rounds[1]?.status==='awaiting_acceptance');assert.equal(h.calls.filter(c=>c.kind==='integration-check').at(-1)!.ctx.session.provider,'codex');
  }finally{await h.dispose();}
});
test('manual task reassignment grants one attempt, preserves counters and other passed work, and does not rewrite the plan',async()=>{
  const h=await harness({handler:async c=>c.kind==='review'&&c.material.task.key==='a'?failed(c.material.task.completionCriteria):undefined});try{await h.confirm();let blocked=await h.wait(s=>s.decisions.some(d=>d.kind==='replan'&&d.status==='open'));const before=blocked.tasks.find(t=>t.key==='a')!,other=blocked.tasks.find(t=>t.key==='b')!,planId=blocked.plan!.id,nativeBefore=h.calls.filter(c=>c.kind==='submission').length;
    assert.equal(before.returnCount,2);assert.equal(before.rearrangeCount,1);await h.answer(blocked.decisions.find(d=>d.kind==='replan'&&d.status==='open')!,'重新安排',{memberId:'codex',opinion:'保留 B，只重做 A'});
    blocked=await h.wait(s=>s.decisions.some(d=>d.kind==='replan'&&d.status==='open'&&d.title.includes('换人')));const after=blocked.tasks.find(t=>t.key==='a')!;
    assert.equal(h.calls.filter(c=>c.kind==='submission').length,nativeBefore+1);assert.equal(after.returnCount,2);assert.equal(after.rearrangeCount,1);assert.equal(after.manualRedos!.at(-1)!.status,'failed');assert.equal(blocked.tasks.find(t=>t.key==='b')!.latestSubmissionId,other.latestSubmissionId);assert.equal(blocked.plan!.id,planId);assert.equal(blocked.plans.length,1);assert.equal(after.sessionId===before.sessionId,false);
    const count=h.calls.filter(c=>c.kind==='submission').length;await h.answer(blocked.decisions.find(d=>d.kind==='replan'&&d.status==='open')!,'重新安排',{memberId:'claude'});await h.wait(s=>s.decisions.some(d=>d.status==='open'&&d.title.includes('换人')));assert.equal(h.calls.filter(c=>c.kind==='submission').length,count+1);
  }finally{await h.dispose();}
});
test('manual integration repair grants one additional fix without resetting automatic limits or future leaders',async()=>{
  const h=await harness({handler:async c=>c.kind==='integration-check'?failed(c.material.criteria):undefined});try{await h.confirm();const blocked=await h.wait(s=>s.decisions.some(d=>d.stage==='integration-fix'));const originalIds=blocked.tasks.filter(t=>t.kind==='implementation').map(t=>[t.id,t.latestSubmissionId]);assert.equal(blocked.rounds[0].integrationFixCount,2);
    await h.answer(blocked.decisions.find(d=>d.stage==='integration-fix')!,'重新安排',{memberId:'dsh'});const failedAgain=await h.wait(s=>s.decisions.some(d=>d.status==='open'&&d.stage==='integration-fix'&&d.reason.includes('人工指定')));
    assert.equal(failedAgain.plan!.id,blocked.plan!.id);assert.equal(failedAgain.flow!.leadMemberId,'codex');assert.equal(failedAgain.rounds[0].leadMemberId,'dsh');assert.equal(failedAgain.rounds[0].integrationFixCount,2);assert.equal(failedAgain.tasks.filter(t=>t.kind==='integration-fix').length,3);assert.match(failedAgain.tasks.at(-1)!.title,/第3次/);assert.equal(failedAgain.rounds[0].manualRedos!.at(-1)!.status,'failed');assert.deepEqual(failedAgain.tasks.filter(t=>t.kind==='implementation').map(t=>[t.id,t.latestSubmissionId]),originalIds);assert.equal(await h.original(),'old-a');
  }finally{await h.dispose();}
});
for(const level of ['high','medium'] as const)test(`${level} review level schedules only its configured checks and waits for user acceptance`,async()=>{
  const h=await harness({level});try{await h.confirm();const s=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');assert.equal(h.calls.filter(c=>c.kind==='review').length,level==='high'?2:0);assert.equal(h.calls.filter(c=>c.kind==='integration-check').length,1);assert.equal(s.reviews.length,level==='high'?2:0);assert.equal(s.tasks.filter(t=>t.reviewSkipped==='configured').length,level==='medium'?2:0);assert.equal(s.overview.remaining,0);assert.equal(s.overview.stage?.kind,'acceptance');assert.equal(await h.original(),'old-a');
  }finally{await h.dispose();}
});
for(const choice of ['交给负责人复核','直接由我验收'])test(`lowest review level: ${choice} is an explicit round decision, never an implicit write`,async()=>{
  const h=await harness({level:'low'});try{await h.confirm();const s=await h.wait(s=>s.decisions.some(d=>d.kind==='review-choice'));assert.equal(h.calls.some(c=>c.kind==='review'||c.kind==='integration-check'),false);assert.equal(s.reviews.length,0);assert.equal(s.rounds[0].allowedActions!.find(a=>a.name==='projectFlow.round.accept')!.enabled,false);assert.equal(await h.original(),'old-a');
    await assert.rejects(h.engine.invoke('projectFlow.round.accept',{requestId:'too-soon',roundId:s.rounds[0].id,expectedRevision:s.rounds[0].revision,integrationId:s.integrations[0].id,fingerprint:s.integrations[0].version!.fingerprint}),/先处理会议要求或复核决策/);
    await h.answer(s.decisions.find(d=>d.kind==='review-choice')!,choice);await h.wait(s=>s.rounds[0].allowedActions!.find(a=>a.name==='projectFlow.round.accept')!.enabled);assert.equal(h.calls.filter(c=>c.kind==='requested-check').length,choice==='交给负责人复核'?1:0);assert.equal(await h.original(),'old-a');await h.accept();await h.wait(s=>s.flow?.status==='completed');assert.equal(await h.original(),'new-a');
  }finally{await h.dispose();}
});
test('changing review level preserves a review already in flight and changes future review dispatch',async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);const p=plan();p.tasks[1].dependencies=['a'];const h=await harness({plan:p,handler:async c=>{if(c.kind==='review'&&c.material.task.key==='a')await gate;return undefined;}});
  try{await h.confirm();const running=await h.wait(s=>s.reviews.some(r=>r.status==='running'));await h.engine.invoke('projectFlow.review.configure',{requestId:'medium',flowId:running.flow!.id,expectedRevision:running.flow!.revision,reviewLevel:'medium'});release();const ready=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');assert.equal(ready.reviews.length,1);assert.equal(ready.reviews[0].status,'passed');assert.equal(ready.tasks.find(t=>t.key==='b')!.reviewSkipped,'configured');assert.equal(ready.flow!.reviewLevel,'medium');
  }finally{release();await h.dispose();}
});
test('optional peer review uses another member and a disposable copy, only after the leader has checked',async()=>{
  const h=await harness({peer:true,handler:async c=>{if(c.kind==='peer-review')await writeFile(path.join(c.ctx.cwd,'peer-test-output.txt'),'transient');return undefined;}});try{await h.confirm();const s=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');const i=s.integrations.at(-1)!;assert.equal(i.peerReview!.outcome,'pass');assert.notEqual(i.peerReview!.memberId,'codex');assert.ok(h.calls.findIndex(c=>c.kind==='peer-review')>h.calls.findIndex(c=>c.kind==='integration-check'));const candidate=h.engine.store.get<{root:string}>('flow_artifacts',i.workspaceArtifactId)!;await assert.rejects(readFile(path.join(candidate.root,'peer-test-output.txt')));assert.equal(await h.original(),'old-a');
  }finally{await h.dispose();}
});
test('an inconclusive peer check can change reviewer on the immutable result without using a fix',async()=>{
  let peers=0;const h=await harness({peer:true,handler:async c=>c.kind==='peer-review'&&++peers===1?inconclusive(c.material.criteria):undefined});try{await h.confirm();const s=await h.wait(s=>s.decisions.some(d=>d.stage==='peer-review'));const d=s.decisions.find(d=>d.stage==='peer-review')!;await h.answer(d,'换人复核',{memberId:'dsh'});const ready=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');assert.equal(ready.rounds[0].integrationFixCount,0);assert.equal(ready.integrations.at(-1)!.peerReview!.memberId,'dsh');assert.equal(peers,2);assert.equal(h.calls.filter(c=>c.kind==='submission').length,2);
  }finally{await h.dispose();}
});
test('a stale decision cannot authorize new work on changed integration contents',async()=>{
  const h=await harness({handler:async c=>c.kind==='integration-check'?inconclusive(c.material.criteria):undefined});try{await h.confirm();const s=await h.wait(s=>s.decisions.some(d=>d.kind==='unresolved-review'));const i=s.integrations.at(-1)!,artifact=h.engine.store.get<{root:string}>('flow_artifacts',i.workspaceArtifactId)!;await writeFile(path.join(artifact.root,'a.txt'),'changed after check');await assert.rejects(h.answer(s.decisions.find(d=>d.kind==='unresolved-review')!,'换负责人检查',{memberId:'dsh'}),/版本已改变/);assert.equal(h.calls.filter(c=>c.kind==='integration-check').length,1);assert.equal((await h.state()).flow!.leadMemberId,'codex');
  }finally{await h.dispose();}
});
test('an abandoned manual task run cannot silently get another author attempt through resume',async()=>{
  let manualAuthor=false;const h=await harness({handler:async c=>{if(c.kind==='review'&&c.material.task.key==='a')return failed(c.material.task.completionCriteria);if(c.kind==='submission'&&c.material.task.manualRedos?.length){manualAuthor=true;await writeFile(path.join(c.ctx.cwd,'a.txt'),'one manual attempt');return {invalid:'member did not provide the submission'};}if(c.correction&&manualAuthor&&c.kind==='submission')return {invalid:'still no submission'};return undefined;}});try{
    await h.confirm();const s=await h.wait(s=>s.decisions.some(d=>d.kind==='replan'&&d.status==='open'));await h.answer(s.decisions.find(d=>d.kind==='replan'&&d.status==='open')!,'重新安排',{memberId:'codex'});await h.wait(s=>s.tasks.some(t=>t.key==='a'&&t.status==='blocked'));
    const op=h.engine.store.list<FlowOperation>('flow_operations').findLast(o=>o.kind==='task'&&o.state==='blocked')!;const before=h.calls.filter(c=>c.kind==='submission'&&!c.correction).length;await h.engine.invoke('projectFlow.unknown.resolve',{requestId:'abandon-manual',operationId:op.id,expectedRevision:op.revision,choice:'abandon',evidence:'核对工作记录后放弃这次格式失败的单次重做'});
    const waiting=await h.state();assert.equal(waiting.tasks.find(t=>t.key==='a')!.status,'escalated');assert.ok(waiting.decisions.some(d=>d.status==='open'&&d.title.includes('人工重做')));await assert.rejects(h.engine.invoke('projectFlow.resume',{requestId:'resume-no-replay',flowId:waiting.flow!.id,expectedRevision:waiting.flow!.revision}),/先处理复核或重做/);assert.equal(h.calls.filter(c=>c.kind==='submission'&&!c.correction).length,before);
  }finally{await h.dispose();}
});

test('same-version rechecks receive the actual user opinion without redoing authors or changing criteria',async()=>{
  for(const kind of ['review','integration-check','peer-review']){
    let first=true,seen=false;
    const h=await harness({peer:true,handler:async c=>{
      if(c.kind!==kind||kind==='review'&&c.material.task.key!=='a')return;
      const criteria=c.material.criteria??c.material.task.completionCriteria;
      if(first){first=false;assert.equal(c.material.userReviewRequest,undefined);return inconclusive(criteria);}
      assert.equal(c.material.userReviewRequest.opinion,'核对外部来源，无法访问就保留未核实；不改文件');
      assert.equal(c.material.userReviewRequest.choice,kind==='review'?'重新复核':'重新检查');seen=true;return passing(criteria);
    }});
    try{await h.confirm();const blocked=await h.wait(s=>s.decisions.some(d=>d.kind==='unresolved-review'&&d.status==='open'));const decision=blocked.decisions.find(d=>d.kind==='unresolved-review'&&d.status==='open')!;
      const count=h.calls.filter(c=>c.kind==='submission').length;
      await h.answer(decision,kind==='review'?'重新复核':'重新检查',{opinion:'核对外部来源，无法访问就保留未核实；不改文件'});
      const ready=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');assert.equal(seen,true);assert.equal(h.calls.filter(c=>c.kind==='submission').length,count);assert.deepEqual(ready.plan!.acceptanceCriteria,['文件内容正确']);assert.equal(await h.original(),'old-a');
    }finally{await h.dispose();}
  }
});
