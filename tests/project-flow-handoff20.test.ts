import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {Engine} from './helpers/seeded-engine';
import {assessReview,isUserAcceptanceCriterion,memberCriteria} from '../src/shared/project-flow-review';
import {validatePlan,validateReview} from '../src/shared/project-flow-protocol';
import type {ReviewFinding,ProjectFlowSnapshot,Task,Submission,Decision} from '../src/shared/project-flow';
import {harness,plan,passing,failed,proof,inconclusive} from './helpers/project-flow-harness';

const productCriteria=[
  '用户删除前弹出确认框','用户点击保存后，列表显示已保存','用户可以在设置页看到已保存的配置',
  'user can confirm the dialog','owner 字段已填写','登录后用户名已显示在右上角','README 说明用户如何确认安装成功',
  '用户可以点击验收按钮','README 说明用户验收流程','用户确认删除后才删除文件','页面显示用户已确认的状态',
  'The user can accept the confirmation dialog','The owner field is already filled','The username is displayed after login',
  'Documentation explains how the user confirms installation','The user confirmation button is visible','APan 点击确认按钮',
  'The client acceptance button is enabled','User approval status is displayed','用户的验收状态显示在页面上',
  'The user has confirmed deletion before file removal','UI shows user has approved the result',
];
const humanCriteria=[
  '用户已确认本轮结果','APan 验收通过','用户（APan）确认本轮结果','用户已确认','经用户确认后','待用户验收',
  '待用户验收通过','human approval received','APan 确认文件结果','用户确认结果','用户已批准这份文档',
  '用户验收通过后，按钮显示通过','The user has approved the result','Awaiting human sign-off','Approved by the owner',
  'APan accepted the deliverable','Client approval is required','The owner has confirmed the round result',
  '用户对本轮结果表示满意','用户最终已确认本轮成品','用户的批准是交付前提','Customer accepted the deliverable',
  'The user has signed off on the result','User’s approval is required',
];
test('handoff20 criterion classification distinguishes product interactions from real human sign-off',()=>{
  for(const c of productCriteria)assert.equal(isUserAcceptanceCriterion(c,'APan'),false,c);
  for(const c of humanCriteria)assert.equal(isUserAcceptanceCriterion(c,'APan'),true,c);
  assert.equal(isUserAcceptanceCriterion('APanels 确认文件结果','APan'),false);
  const p=plan();p.acceptanceCriteria=[...productCriteria];p.tasks[0].completionCriteria=[...productCriteria];
  assert.doesNotThrow(()=>validatePlan(p,['codex','claude','dsh'],[],'APan'));
  assert.deepEqual(memberCriteria([...productCriteria,...humanCriteria],'APan'),{judged:[],required:productCriteria,deferred:humanCriteria});
});

const old:ReviewFinding={id:'old',location:'a.txt',kind:'verified',severity:'blocking',evidence:'旧缺陷的实际位置',request:'修正旧问题'};
test('handoff20 missing or partial old checks are inconclusive facts, not format errors or another return',()=>{
  for(const previousFindingChecks of [undefined,[],[{findingId:'old',resolved:false,evidence:''}]]){
    const payload=validateReview({...failed(['A']),previousFindingChecks},['A'],[old]);
    const assessment=assessReview(payload,['A'],[],[old]);
    assert.equal(assessment.outcome,'inconclusive');assert.match(assessment.reasons.join(),/旧问题核对缺少依据/);
  }
  const other={...old,id:'other',location:'b.txt',request:'修正另一个旧问题'};
  const partial=validateReview({...passing(['A']),previousFindingChecks:[{findingId:'old',resolved:true,evidence:'已读取当前文件'}]},['A'],[old,other]);
  assert.equal(assessReview(partial,['A'],[],[old,other]).outcome,'inconclusive');
  for(const checks of [[{findingId:'unknown',resolved:false,evidence:''}],Array(2).fill({findingId:'old',resolved:true,evidence:'已核对'})])
    assert.throws(()=>validateReview({...passing(['A']),previousFindingChecks:checks},['A'],[old]),/不存在|重复/);
});

test('handoff20 empty review evidence cannot advance or request changes',()=>{
  for(const reply of [passing(['A']),failed(['A'])]){
    const assessed=assessReview(validateReview({...reply,evidence:[]},['A']),['A']);
    assert.equal(assessed.outcome,'inconclusive');assert.match(assessed.reasons.join(),/验证依据/);
  }
});

test('handoff20 suspected should-fix remains advice while suspected blocking or missing criteria still needs checking',()=>{
  const payload={...passing(['A']),findings:[{location:'a.txt',kind:'suspected' as const,severity:'should-fix' as const,evidence:'',request:'建议核对说明是否可以更清楚'}]};
  assert.equal(assessReview(payload,['A']).outcome,'pass');assert.equal(assessReview(payload,['A']).findings[0].disposition,'advice');
  assert.equal(assessReview({...payload,findings:[{...payload.findings[0],severity:'blocking'}]},['A']).outcome,'inconclusive');
  assert.equal(assessReview({...payload,criteriaResults:inconclusive(['A']).criteriaResults},['A']).outcome,'inconclusive');
});

test('handoff20 genuine product criteria reach task and whole-round checks without being deferred',async()=>{
  const p=plan();p.tasks=p.tasks.slice(0,1);p.tasks[0].completionCriteria=[...productCriteria.slice(0,7)];p.acceptanceCriteria=[productCriteria[7]];
  const h=await harness({plan:p});try{
    await h.confirm();const s=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');
    assert.deepEqual(s.reviews[0].criteriaResults!.map(c=>c.criterion),p.tasks[0].completionCriteria);
    assert.deepEqual(s.reviews[0].deferredUserCriteria,[]);assert.deepEqual(s.integrations[0].deferredUserCriteria,[]);
    assert.ok(h.calls.find(c=>c.kind==='integration-check')!.material.criteria.includes(p.acceptanceCriteria[0]));
    assert.equal(h.calls.some(c=>c.correction),false);assert.equal(await h.original(),'old-a');
  }finally{await h.dispose();}
});

const singlePlan=()=>{const p=plan();p.tasks=p.tasks.slice(0,1);return p;};
const oldChecks=(c:any)=>c.material.previousFindings.map((f:ReviewFinding)=>({findingId:f.id,resolved:true,evidence:'在当前副本核对旧问题已修复'}));
test('handoff20 incomplete repeat task check waits for a real recheck without formatting, fixes or additional returns',async()=>{
  let reviews=0;const h=await harness({plan:singlePlan(),autoPreviousChecks:false,handler:async c=>{
    if(c.kind==='review'){reviews++;return reviews<3?failed(c.material.task.completionCriteria):{...passing(c.material.task.completionCriteria),previousFindingChecks:oldChecks(c)};}
  }});
  try{
    await h.confirm();const s=await h.wait(s=>s.decisions.some(d=>d.kind==='unresolved-review')),d=s.decisions.find(d=>d.kind==='unresolved-review')!;
    assert.match(d.reason,/旧问题核对缺少依据/);assert.equal(s.tasks[0].returnCount,1);assert.equal(s.submissions.length,2);
    assert.equal(s.reviews.at(-1)!.verdict,'changes_requested');assert.equal(s.reviews.at(-1)!.outcome,'inconclusive');
    assert.equal(h.calls.some(c=>c.correction),false);assert.equal(s.rounds[0].integrationFixCount,0);
    await h.answer(d,'重新复核');const ready=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');
    assert.equal(ready.submissions.length,2);assert.equal(ready.tasks[0].returnCount,1);assert.equal(reviews,3);
  }finally{await h.dispose();}
});

test('handoff20 incomplete repeat integration check preserves its version and its one existing round correction',async()=>{
  let checks=0;const h=await harness({plan:singlePlan(),autoPreviousChecks:false,handler:async c=>{
    if(c.kind==='integration-check'){checks++;return checks===1?failed(c.material.criteria):{...passing(c.material.criteria),...(checks===3?{previousFindingChecks:oldChecks(c)}:{})};}
  }});
  try{
    await h.confirm();const s=await h.wait(s=>s.decisions.some(d=>d.stage==='integration-check')),d=s.decisions.find(d=>d.stage==='integration-check')!;
    const version=s.integrations.at(-1)!.version!.fingerprint,submissions=s.submissions.length;
    assert.match(d.reason,/旧问题核对缺少依据/);assert.equal(s.rounds[0].integrationFixCount,1);assert.equal(h.calls.some(c=>c.correction),false);
    await h.answer(d,'重新检查');const ready=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');
    assert.equal(ready.integrations.at(-1)!.version!.fingerprint,version);assert.equal(ready.submissions.length,submissions);
    assert.equal(ready.rounds[0].integrationFixCount,1);assert.equal(checks,3);assert.equal(await h.original(),'old-a');
  }finally{await h.dispose();}
});

for(const kind of ['review','integration-check'] as const)test('handoff20 empty '+kind+' evidence is an explicit inconclusive decision with no format correction',async()=>{
  let checks=0;const h=await harness({plan:singlePlan(),handler:async c=>c.kind===kind&&++checks===1?{...failed(c.material.criteria??c.material.task.completionCriteria),evidence:[]}:undefined});
  try{
    await h.confirm();const s=await h.wait(s=>s.decisions.some(d=>d.kind==='unresolved-review')),d=s.decisions.find(d=>d.kind==='unresolved-review')!;
    assert.match(d.reason,/验证依据/);assert.equal(s.tasks[0].returnCount,0);assert.equal(s.rounds[0].integrationFixCount,0);
    assert.equal(h.calls.some(c=>c.correction),false);assert.equal(s.submissions.length,1);
    await h.answer(d,kind==='review'?'重新复核':'重新检查');await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');
    assert.equal(h.calls.filter(c=>c.kind==='submission').length,1);
  }finally{await h.dispose();}
});

test('handoff20 suspected nonblocking advice reaches integration and human report without stopping any automatic check',async()=>{
  const h=await harness({plan:singlePlan(),peer:true,handler:async c=>['review','integration-check','peer-review'].includes(c.kind)?{
    ...passing(c.material.criteria??c.material.task.completionCriteria),verdict:'changes_requested',
    findings:[{location:'a.txt',kind:'suspected',severity:'should-fix',evidence:'',request:'建议核对说明 '+c.kind}],
  }:undefined});
  try{
    await h.confirm();const s=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');
    assert.equal(s.reviews[0].outcome,'pass');assert.equal(s.integrations[0].outcome,'pass');assert.equal(s.integrations[0].peerReview!.outcome,'pass');
    assert.equal(s.tasks[0].returnCount,0);assert.equal(s.rounds[0].integrationFixCount,0);assert.equal(s.decisions.length,0);
    assert.equal(s.integrations[0].advisoryFindings![0].kind,'suspected');assert.match(s.rounds[0].report!.remainingIssues.join(),/建议核对说明/);
  }finally{await h.dispose();}
});

test('handoff20 rearrangement rejects human sign-off and its single format repair can supply a testable product criterion',async()=>{
  let originalTask:any;const h=await harness({plan:singlePlan(),handler:async c=>{
    if(c.kind==='review'&&!c.material.task.rearrangeCount)return failed(c.material.task.completionCriteria);
    if(c.kind==='task-rearrange'){
      if(!c.correction)originalTask=c.material.task;
      return {memberId:'dsh',goal:originalTask.goal,completionCriteria:[c.correction?productCriteria[0]:humanCriteria[0]],reason:'仍在原范围内换人完成'};
    }
  }});
  try{
    await h.confirm();const s=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');
    assert.deepEqual(s.tasks[0].completionCriteria,[productCriteria[0]]);assert.equal(s.tasks[0].memberId,'dsh');
    assert.equal(s.tasks[0].returnCount,2);assert.equal(s.tasks[0].rearrangeCount,1);
    assert.equal(h.calls.filter(c=>c.kind==='task-rearrange'&&c.correction).length,1);
    assert.ok(h.calls.findLast(c=>c.kind==='review')!.material.task.completionCriteria.includes(productCriteria[0]));
    assert.equal(await h.original(),'old-a');
  }finally{await h.dispose();}
});

async function waitSnapshot(engine:Engine,id:string,predicate:(s:ProjectFlowSnapshot)=>boolean){
  const until=Date.now()+20000;for(;;){const s=await engine.invoke('projectFlow.get',{projectId:id}) as ProjectFlowSnapshot;
    if(predicate(s))return s;if(Date.now()>until)throw Error('handoff20 recovery timeout: '+JSON.stringify({tasks:s.tasks.map(t=>({key:t.key,status:t.status,returns:t.returnCount})),decisions:s.decisions.map(d=>({kind:d.kind,status:d.status}))}));
    await new Promise(r=>setTimeout(r,25));
  }
}
for(const actor of ['user','lead'] as const)test('handoff20 '+actor+' disputes refund at most twice and still reach adjudication after the cap',async()=>{
  const p=singlePlan();p.tasks[0].reviewerMemberId=actor==='user'?'codex':'dsh';let submissions=0;
  const h=await harness({plan:p,handler:async c=>{
    if(c.kind==='review')return failed(c.material.task.completionCriteria);
    if(c.kind==='submission'&&++submissions%2===0&&!c.material.task.rearrangeCount){
      await writeFile(path.join(c.ctx.cwd,'a.txt'),'new-a');
      return {summary:'提出有依据的复核异议',completionResults:passing(c.material.task.completionCriteria).criteriaResults,evidence:proof,
        disputes:[{findingId:c.material.fixes[0].id,reason:'请求按原任务标准裁定'}]};
    }
    if(c.kind==='adjudication')return {rulings:c.material.disputes.map((d:any)=>({findingId:d.findingId,verdict:'uphold-review',reason:'实际核对后维持复核意见'}))};
  }});
  let engine=h.engine,restarted:Engine|undefined;
  const wait=(predicate:(s:ProjectFlowSnapshot)=>boolean)=>waitSnapshot(engine,h.project.id,predicate);
  const answer=async(d:Decision,choice:string,extra:Record<string,unknown>={})=>{
    const ready=await wait(s=>Boolean(s.decisions.find(item=>item.id===d.id)?.allowedActions?.[0]?.enabled)),latest=ready.decisions.find(item=>item.id===d.id)!;
    return engine.invoke('projectFlow.decision.answer',{requestId:crypto.randomUUID(),decisionId:d.id,expectedRevision:latest.revision,choice,...extra});
  };
  try{
    await h.confirm();
    if(actor==='user')for(let i=1;i<=4;i++){
      let s=await wait(s=>s.decisions.some(d=>d.kind==='review-dispute'&&d.status==='open'&&s.submissions.find(sub=>sub.id===d.submissionId)?.sequence===i*2));
      const d=s.decisions.find(d=>d.kind==='review-dispute'&&d.status==='open')!;
      assert.equal(d.disputeReturnAccounting!.refunded,i<=2);assert.equal(s.tasks[0].disputeReturnWaiverCount,Math.min(i,2));
      assert.equal(s.tasks[0].returnCount,Math.max(0,i-2));assert.match(d.reason,i<=2?/本次异议返还 1 次/:/本次退回正常计数/);
      if(i===3){
        await wait(s=>Boolean(s.decisions.find(item=>item.id===d.id)?.allowedActions?.[0]?.enabled));
        // Simulate legacy data: review receipts remain authoritative even without the new task counter.
        const t=engine.store.get<Task>('flow_tasks',s.tasks[0].id)!;engine.store.put('flow_tasks',t.id,{...t,disputeReturnWaiverCount:undefined});
        for(const review of s.reviews.filter(r=>r.returnWaivedBySubmissionId))engine.store.put('flow_reviews',review.id,{...review,status:'stale'});
        const sub=engine.store.get<Submission>('flow_submissions',d.submissionId!)!;engine.store.put('flow_submissions',sub.id,{...sub,disputeReturnAccounting:undefined});
        await engine.close();restarted=new Engine(path.join(h.root,'data'),()=>{},()=>{},h.adapterFactory);engine=restarted;await engine.probe();
        s=await engine.invoke('projectFlow.get',{projectId:h.project.id}) as ProjectFlowSnapshot;assert.equal(s.tasks[0].returnCount,1);
      }
      await answer(d,'维持全部复核意见');
      if(i===3){const current=await engine.invoke('projectFlow.get',{projectId:h.project.id}) as ProjectFlowSnapshot;
        await engine.invoke('projectFlow.resume',{requestId:'resume-after-legacy-dispute',flowId:current.flow!.id,expectedRevision:current.flow!.revision});}
    }
    let done=await wait(s=>s.decisions.some(d=>d.kind==='replan'&&d.status==='open')),task=done.tasks[0];
    assert.equal(task.returnCount,2);assert.equal(task.disputeReturnWaiverCount,2);assert.equal(task.rearrangeCount,1);
    const waivers=done.reviews.filter(r=>r.returnWaivedBySubmissionId);assert.equal(waivers.length,2);
    assert.equal(done.submissions.filter(sub=>sub.disputeReturnAccounting?.refunded).length,2);
    assert.equal(done.submissions.filter(sub=>sub.disputes?.length).length,4);
    if(actor==='lead')assert.equal(h.calls.filter(c=>c.kind==='adjudication').length,4);
    // A human-assigned single redo retains both ordinary returns and the refund cap.
    await answer(done.decisions.find(d=>d.kind==='replan'&&d.status==='open')!,'重新安排',{memberId:'claude'});
    done=await wait(s=>s.tasks[0].manualRedos?.at(-1)?.status==='failed');task=done.tasks[0];
    assert.equal(task.returnCount,2);assert.equal(task.disputeReturnWaiverCount,2);assert.equal(waivers.length,2);
    assert.equal(await h.original(),'old-a');
  }finally{await restarted?.close();await h.dispose();}
});

test('handoff20 a revised plan reusing the same validated task preserves its two genuine dispute refunds',async()=>{
  const p=singlePlan();p.tasks[0].reviewerMemberId='codex';let reviews=0,submissions=0;
  const h=await harness({plan:p,handler:async c=>{
    if(c.kind==='plan'&&c.material.parentPlan){const revised=structuredClone(p);revised.tasks[0].reuse='a';return revised;}
    if(c.kind==='review'&&++reviews<=2){const reply=failed(c.material.task.completionCriteria);reply.findings[0].request+=' 第'+reviews+'项';return reply;}
    if(c.kind==='submission'&&++submissions>1){await writeFile(path.join(c.ctx.cwd,'a.txt'),'new-a');return {
      summary:'提交并对本次问题提出异议',completionResults:passing(c.material.task.completionCriteria).criteriaResults,evidence:proof,
      disputes:[{findingId:c.material.fixes[0].id,reason:'成果符合既定标准，请裁定'}],
    };}
  }});
  try{
    await h.confirm();
    for(let i=1;i<=2;i++){const s=await h.wait(s=>s.decisions.some(d=>d.kind==='review-dispute'&&d.status==='open'&&s.submissions.find(sub=>sub.id===d.submissionId)?.sequence===i+1));
      await h.answer(s.decisions.find(d=>d.kind==='review-dispute'&&d.status==='open')!,'支持全部异议');}
    let s=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance'),oldTask=s.tasks[0];assert.equal(oldTask.disputeReturnWaiverCount,2);
    await h.engine.invoke('projectFlow.plan.revise',{requestId:'reuse-dispute-history',planId:s.plan!.id,expectedRevision:s.plan!.revision,instruction:'保留已经核实的同一任务'});
    s=await h.wait(s=>s.plan?.version===2&&s.plan.status==='awaiting_confirmation');
    await h.engine.invoke('projectFlow.plan.confirm',{requestId:'confirm-history-reuse',planId:s.plan!.id,expectedRevision:s.plan!.revision});
    s=await h.wait(s=>s.rounds.some(r=>r.planId===s.plan!.id&&r.status==='awaiting_acceptance'));const reused=s.tasks.find(t=>t.planId===s.plan!.id)!;
    assert.equal(reused.reusedFromTaskId,oldTask.id);assert.equal(reused.disputeReturnWaiverCount,2);assert.equal(reused.returnCount,oldTask.returnCount);
    assert.equal(submissions,3);assert.equal(await h.original(),'old-a');
  }finally{await h.dispose();}
});
