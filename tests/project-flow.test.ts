import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Engine } from './helpers/seeded-engine';
import { validatePlan, validateReview, parseReply } from '../src/shared/project-flow-protocol';
import type { Adapter, AdapterContext, Project } from '../src/shared/types';
import type { PlanPayload, ProjectFlowSnapshot, ReviewPayload } from '../src/shared/project-flow';
import { Store } from '../src/backend/store';
import { FlowArtifacts } from '../src/backend/project-flow-artifacts';
import { FlowApply } from '../src/backend/project-flow-apply';
import { workspaceFingerprint } from '../src/backend/workspace';
import { unwrapProjectFlowReply } from '../src/shared/project-flow';
import {withPreviousChecks} from './helpers/project-flow-harness';
import {assessReview} from '../src/shared/project-flow-review';

const envelope=(kind:string,payload:unknown)=>JSON.stringify({protocol:'airoom.project-flow',version:1,kind,payload});
const evidence=[{kind:'inspection',description:'读取文件',result:'文件已检查',eventIds:[],source:'reported'}];
const basePlan=():PlanPayload=>({objective:'修改文件',scope:'测试',deliverables:['文件'],acceptanceCriteria:['文件正确'],rounds:[{key:'r',title:'第一轮',goal:'文件',requiresUserAcceptance:false}],tasks:[{key:'a',roundKey:'r',title:'A',memberId:'claude',goal:'写 A',inputs:[],completionCriteria:['A 正确'],dependencies:[],allowedPaths:['a.txt']},{key:'b',roundKey:'r',title:'B',memberId:'dsh',goal:'写 B',inputs:[],completionCriteria:['B 正确'],dependencies:[],allowedPaths:['b.txt']}]});
const review=(criteria:string[],verdict='pass'):ReviewPayload=>({verdict:verdict as ReviewPayload['verdict'],verificationComplete:true,criteriaResults:criteria.map(criterion=>({criterion,verified:true,evidence:'实际读取'})),findings:verdict==='pass'?[]:[{location:'文件',kind:'verified',severity:'blocking',evidence:'内容不正确',request:'修正文件'}],evidence:evidence as ReviewPayload['evidence']});
test('plan validation forces final acceptance, resolves scope serialization, and rejects cyclic or escaping plans',()=>{
  const plan=basePlan();assert.equal(validatePlan(plan,['claude','dsh']).rounds[0].requiresUserAcceptance,true);
  plan.tasks[1].allowedPaths=['.'];assert.deepEqual(validatePlan(plan,['claude','dsh']).tasks[1].dependencies,['a']);
  plan.tasks[0].dependencies=['b'];plan.tasks[1].dependencies=['a'];assert.throws(()=>validatePlan(plan,['claude','dsh']),/成环/);
  plan.tasks[0].dependencies=[];plan.tasks[1].dependencies=[];plan.tasks[1].allowedPaths=['../outside'];assert.throws(()=>validatePlan(plan,['claude','dsh']),/相对/);
  assert.throws(()=>parseReply('not JSON','plan'),/JSON/);
  const wrong=review(['A']);wrong.criteriaResults[0].verified=false;assert.equal(validateReview(wrong,['A']).verdict,'pass');assert.equal(assessReview(wrong,['A']).outcome,'inconclusive');
  wrong.criteriaResults[0].verified=true;wrong.findings=[{location:'a',kind:'suspected',severity:'blocking',evidence:'',request:'查证'}];assert.equal(assessReview(validateReview(wrong,['A']),['A']).outcome,'inconclusive');
});

test('plan adjustment notes describe only rules that actually changed the proposed plan',()=>{
  const plan=basePlan(),notes:string[]=[];plan.rounds[0].requiresUserAcceptance=true;
  validatePlan(plan,['claude','dsh'],notes);assert.deepEqual(notes,[]);
  plan.rounds[0].requiresUserAcceptance=false;validatePlan(plan,['claude','dsh'],notes);assert.deepEqual(notes,['最后一轮固定需要用户验收。']);
  notes.length=0;plan.rounds[0].requiresUserAcceptance=true;plan.tasks[1].allowedPaths=['.'];validatePlan(plan,['claude','dsh'],notes);assert.deepEqual(notes,['b 和 a 的修改范围重叠，已安排 b 在 a 之后。','b 的修改范围是整个项目，会和本轮其他任务排队执行。']);
  notes.length=0;plan.tasks[1].dependencies=['a'];validatePlan(plan,['claude','dsh'],notes);assert.deepEqual(notes,['b 的修改范围是整个项目，会和本轮其他任务排队执行。']);
});

async function until(engine:Engine,projectId:string,predicate:(s:ProjectFlowSnapshot)=>boolean){const deadline=Date.now()+15000;let s:ProjectFlowSnapshot;do{s=await engine.invoke('projectFlow.get',{projectId}) as ProjectFlowSnapshot;if(predicate(s))return s;await new Promise(r=>setTimeout(r,25));}while(Date.now()<deadline);throw new Error('timeout '+JSON.stringify(s));}
async function setup(plan:PlanPayload,handler?:(ctx:AdapterContext,kind:string,prompt:string)=>Promise<unknown>){
  const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM flow-')),source=path.join(directory,'project');await mkdir(source);await writeFile(path.join(source,'a.txt'),'old-a');await writeFile(path.join(source,'b.txt'),'old-b');
  let active=0,peak=0;const calls:{kind:string;ctx:AdapterContext}[]=[];
  const factory=(id:AdapterContext['run']['provider']):Adapter=>({probe:async()=>({id,name:id,available:true,auth:'subscription',detail:'fake',capabilities:{steer:false,cancel:'native',streaming:true,write:true,history:true}}),stop:async()=>{},start:async(ctx,prompt)=>{
    ctx.markDelivery('confirmed');active++;peak=Math.max(peak,active);const kind=prompt.match(/"kind":"([^"]+)"/)?.[1]??'';calls.push({kind,ctx});
    try{let payload:unknown;if(handler)payload=await handler(ctx,kind,prompt);if(payload===undefined){if(kind==='plan')payload=plan;else if(kind==='submission'){await new Promise(r=>setTimeout(r,100));const file=ctx.session.provider==='claude'?'a.txt':'b.txt';await writeFile(path.join(ctx.cwd,file),'new-'+file);payload={summary:'完成',evidence,completionResults:JSON.parse(prompt.split('任务材料：')[1]).task.completionCriteria.map((criterion:string)=>({criterion,verified:true,evidence:'读取'}))};}else if(kind==='review'){const task=JSON.parse(prompt.split('任务材料：')[1]).task;payload=review(task.completionCriteria);await writeFile(path.join(ctx.cwd,'test-output.txt'),'temporary');}else if(kind==='integration-check')payload=review(JSON.parse(prompt.split('任务材料：')[1]).criteria);else if(kind==='round-report')payload={summary:'完成本轮',completedTaskKeys:JSON.parse(prompt.split('任务材料：')[1]).taskKeys,deliverables:['文件'],validationSummary:'已读取整合文件',remainingIssues:[],nextRoundSummary:'下一轮',userDecisionNeeded:'请验收'};}if(['review','integration-check','peer-review'].includes(kind)&&!prompt.includes('仅补正上轮 JSON 格式'))payload=withPreviousChecks(payload,JSON.parse(prompt.split('任务材料：')[1]));if(kind==='next-round'&&payload===undefined)payload={mode:'as-planned',summary:'按原计划',taskAdjustments:[]};ctx.emit('delta',envelope(kind,payload));return {};}finally{active--;}
  }});
  const engine=new Engine(path.join(directory,'data'),()=>{},()=>{},factory);await engine.probe();const project=await engine.invoke('project.create',{directory:source}) as Project;
  const start=await engine.invoke('projectFlow.start',{requestId:'start',projectId:project.id,leadMemberId:'codex',memberIds:['codex','claude','dsh'],topic:'修改文件',reviewLevel:'high'}) as {entityId:string};
  const s=await until(engine,project.id,s=>s.plan?.status==='awaiting_confirmation');
  await engine.invoke('projectFlow.plan.confirm',{requestId:'confirm',planId:s.plan!.id,expectedRevision:s.plan!.revision,requiresUserAcceptanceByRound:{r:false}});
  return {engine,project,directory,source,calls,start,peak:()=>peak,cleanup:async()=>{await engine.close();await rm(directory,{recursive:true,force:true});}};
}
test('real engine runs disjoint tasks in parallel, captures immutable submissions, reviews disposable writable copies and keeps project untouched',async()=>{
  const ctx=await setup(basePlan());try{
    const s=await until(ctx.engine,ctx.project.id,s=>s.tasks.length===2&&s.tasks.every(t=>t.status==='review_passed'));
    assert.deepEqual(s.plan!.notes,['最后一轮固定需要用户验收。']);
    assert.ok(ctx.peak()>=2);assert.equal(s.rounds[0].requiresUserAcceptance,true);assert.equal(await readFile(path.join(ctx.source,'a.txt'),'utf8'),'old-a');
    assert.equal(s.submissions.length,2);assert.equal(s.reviews.length,2);assert.ok(s.tasks.every(t=>t.lastActivity));
    const reviewCalls=ctx.calls.filter(c=>c.kind==='review');
    await until(ctx.engine,ctx.project.id,()=>reviewCalls.every(call=>ctx.engine.store.list<{sessionId?:string;status:string}>('flow_artifacts').some(artifact=>artifact.sessionId===call.ctx.session.id&&artifact.status==='removed')));
    for(const call of reviewCalls){assert.equal(call.ctx.session.writeMode,true);await assert.rejects(access(call.ctx.cwd));}
    for(const sub of s.submissions){const artifact=ctx.engine.store.get<{root:string}>('flow_artifacts',sub.version.artifactId)!;await assert.rejects(access(path.join(artifact.root,'test-output.txt')));}
    await assert.rejects(ctx.engine.send(s.tasks[0].sessionId!,'额外改文件'),/项目会议室/);
    await assert.rejects(ctx.engine.invoke('run.validate',{runId:s.submissions[0].runId,validation:'passed'}),/会议室/);
    const first=await ctx.engine.invoke('projectFlow.start',{requestId:'start',projectId:ctx.project.id,leadMemberId:'codex',memberIds:['codex','claude','dsh'],topic:'修改文件',reviewLevel:'high'});assert.deepEqual(first,ctx.start);
  }finally{await ctx.cleanup();}
});
test('a chain of tasks on one file builds each copy from the whole chain, not only the direct dependency',async()=>{
  // The real run of 2026-10-06: three members each add a paragraph to one new file; the third copy lacked the first member's file.
  const plan=basePlan();plan.tasks=[
    {key:'a',roundKey:'r',title:'A',memberId:'claude',goal:'创建 shared.txt',inputs:[],completionCriteria:['A 正确'],dependencies:[],allowedPaths:['shared.txt']},
    {key:'b',roundKey:'r',title:'B',memberId:'dsh',goal:'追加第二段',inputs:[],completionCriteria:['B 正确'],dependencies:['a'],allowedPaths:['shared.txt']},
    {key:'c',roundKey:'r',title:'C',memberId:'codex',goal:'追加第三段',inputs:[],completionCriteria:['C 正确'],dependencies:['b'],allowedPaths:['shared.txt']}];
  const seenByC:string[]=[];
  const ctx=await setup(plan,async(adapter,kind,prompt)=>{if(kind!=='submission')return undefined;const task=JSON.parse(prompt.split('任务材料：')[1]).task,file=path.join(adapter.cwd,'shared.txt');
    const before=await readFile(file,'utf8').catch(()=>'');if(task.key==='c')seenByC.push(before);await writeFile(file,before+task.key+'\n');
    return {summary:'完成',evidence,completionResults:task.completionCriteria.map((criterion:string)=>({criterion,verified:true,evidence:'读取'}))};});
  try{const s=await until(ctx.engine,ctx.project.id,s=>s.tasks.length===3&&s.tasks.every(t=>['review_passed','integrated','accepted'].includes(t.status)));
    assert.deepEqual(seenByC,['a\nb\n'],'C starts from A and B');assert.ok(s.tasks.every(t=>!t.blockedReason));
  }finally{await ctx.cleanup();}
});

test('an inconclusive review waits for a decision, and explicit recheck keeps the submitted task',async()=>{
  const plan=basePlan();plan.tasks=plan.tasks.slice(0,1);let reviews=0,diffSeen='';
  const ctx=await setup(plan,async(_adapter,kind,prompt)=>{if(kind!=='review')return undefined;reviews++;const material=JSON.parse(prompt.split('任务材料：')[1]);diffSeen=material.diff;
    const criteria=material.task.completionCriteria as string[];
    return reviews===1?{verdict:'inconclusive',verificationComplete:false,criteriaResults:criteria.map(criterion=>({criterion,verified:false,evidence:'拿不到开工前的版本'})),findings:[],evidence}:review(criteria);});
  try{let s=await until(ctx.engine,ctx.project.id,s=>s.tasks[0]?.status==='blocked');
    assert.match(s.flow!.blockedReasons.join(),/复核无法下结论：A，未能核实：A 正确/);
    assert.match(diffSeen,/-old-a/,'the reviewer sees the version the author started from');assert.match(diffSeen,/\+new-a\.txt/);
    const submissions=ctx.calls.filter(c=>c.kind==='submission').length;
    assert.equal(s.allowedActions.find(a=>a.name==='projectFlow.resume')?.enabled,false);
    await assert.rejects(ctx.engine.invoke('projectFlow.resume',{requestId:'retry',flowId:s.flow!.id,expectedRevision:s.flow!.revision}),/先处理复核/);
    s=await until(ctx.engine,ctx.project.id,s=>Boolean(s.decisions.find(d=>d.kind==='unresolved-review')?.allowedActions?.[0].enabled));const decision=s.decisions.find(d=>d.kind==='unresolved-review')!;
    await ctx.engine.invoke('projectFlow.decision.answer',{requestId:'recheck',decisionId:decision.id,expectedRevision:decision.revision,choice:'重新复核'});
    s=await until(ctx.engine,ctx.project.id,s=>s.tasks[0]?.status==='review_passed'||s.tasks[0]?.status==='integrated'||s.tasks[0]?.status==='accepted');
    assert.equal(reviews,2);assert.equal(ctx.calls.filter(c=>c.kind==='submission').length,submissions,'the task is not redone');assert.deepEqual(s.flow!.blockedReasons,[]);
  }finally{await ctx.cleanup();}
});

test('two returns reuse the author session then escalate without a third retry',async()=>{
  const plan=basePlan();plan.tasks=plan.tasks.slice(0,1);
  const ctx=await setup(plan,async(_ctx,kind,prompt)=>kind==='review'?review(JSON.parse(prompt.split('任务材料：')[1]).task.completionCriteria,'changes_requested'):undefined);
  try{const roomId=`project:${ctx.project.id}` as const,s=await until(ctx.engine,ctx.project.id,s=>s.tasks[0]?.status==='escalated'&&s.decisions.length>0&&ctx.engine.store.roomView(roomId).messages.some(message=>message.flowDecision));assert.equal(s.tasks[0].returnCount,2);assert.equal(ctx.calls.filter(c=>c.kind==='submission').length,3);assert.equal(new Set(ctx.calls.filter(c=>c.kind==='submission').map(c=>c.ctx.session.id)).size,1);assert.equal(s.decisions[0].kind,'replan');
    const params={requestId:'pause-decision',decisionId:s.decisions[0].id,expectedRevision:s.decisions[0].revision,choice:'暂停'};
    await ctx.engine.invoke('projectFlow.decision.answer',params);await ctx.engine.invoke('projectFlow.decision.answer',params);
    const messages=ctx.engine.store.roomView(roomId).messages.filter(message=>message.flowDecision);assert.deepEqual(messages.map(message=>message.flowDecision!.status),['open','answered']);assert.equal(messages[1].author,'user');assert.match(messages[1].text,/你的选择：暂停/);assert.equal(ctx.engine.snapshot().room.messages.length,0);
  }finally{await ctx.cleanup();}
});
test('overlapping task starts from the reviewed predecessor and a leader task is reviewed by another member',async()=>{
  const plan=basePlan();plan.tasks[1].allowedPaths=['a.txt'];plan.tasks[1].memberId='codex';
  const ctx=await setup(plan,async(ctx,kind,prompt)=>{if(kind==='submission'&&ctx.run.provider==='codex'){assert.equal(await readFile(path.join(ctx.cwd,'a.txt'),'utf8'),'new-a.txt');await writeFile(path.join(ctx.cwd,'a.txt'),'second');return {summary:'完成',evidence,completionResults:[{criterion:'B 正确',verified:true,evidence:'读取'}]};}return undefined;});
  try{const s=await until(ctx.engine,ctx.project.id,s=>s.tasks.every(t=>t.status==='review_passed'));assert.equal(s.tasks[1].reviewerMemberId,'claude');assert.equal(ctx.peak(),1);}finally{await ctx.cleanup();}
});
test('out of scope changes become a decision and cannot silently pass review',async()=>{
  const plan=basePlan();plan.tasks=plan.tasks.slice(0,1);
  const ctx=await setup(plan,async(ctx,kind)=>{if(kind==='submission')await writeFile(path.join(ctx.cwd,'outside.txt'),'not allowed');return undefined;});
  try{const s=await until(ctx.engine,ctx.project.id,s=>s.decisions.length>0);assert.equal(s.tasks[0].status,'blocked');assert.equal(s.decisions[0].kind,'scope-change');assert.equal(s.reviews.length,0);await assert.rejects(access(path.join(ctx.source,'outside.txt')));}finally{await ctx.cleanup();}
});
test('source changes during disposable review invalidate the result and stop advancement',async()=>{
  const plan=basePlan();plan.tasks=plan.tasks.slice(0,1);let author:string|undefined;
  const ctx=await setup(plan,async(ctx,kind,prompt)=>{if(kind==='submission')author=ctx.cwd;if(kind==='review'){await writeFile(path.join(author!,'a.txt'),'changed during review');return review(JSON.parse(prompt.split('任务材料：')[1]).task.completionCriteria);}return undefined;});
  try{const s=await until(ctx.engine,ctx.project.id,s=>s.tasks[0]?.status==='blocked');assert.notEqual(s.reviews[0].status,'passed');assert.match(s.tasks[0].blockedReason!,/版本/);}finally{await ctx.cleanup();}
});
test('round acceptance applies the integrated version, not individual submissions, and artifact readers are bounded',async()=>{
  const ctx=await setup(basePlan());try{
    const s=await until(ctx.engine,ctx.project.id,s=>s.rounds[0]?.status==='awaiting_acceptance'),round=s.rounds[0],integration=s.integrations.find(i=>i.id===round.integrationId)!;
    const attention=await ctx.engine.invoke('attention.list') as {items:{kind:string}[]};assert.equal(attention.items.filter(i=>i.kind==='round-acceptance').length,1);assert.equal(attention.items.filter(i=>i.kind==='acceptance').length,0);
    const artifactId=integration.version!.artifactId,files=await ctx.engine.invoke('projectFlow.artifact.files',{artifactId}) as {relativePath:string;path?:string}[];assert.ok(files.some(f=>f.relativePath==='a.txt'));assert.ok(files.every(f=>!f.path));
    await assert.rejects(ctx.engine.invoke('projectFlow.artifact.read',{artifactId,path:'../escape'}));
    assert.equal((await ctx.engine.invoke('projectFlow.artifact.read',{artifactId,path:'a.txt'}) as {content:string}).content,'new-a.txt');
    const diff=await ctx.engine.invoke('projectFlow.artifact.diff',{artifactId}) as {text:string};assert.match(diff.text,/-old-a/);assert.match(diff.text,/\+new-a.txt/);
    await ctx.engine.invoke('projectFlow.round.accept',{requestId:'accept',roundId:round.id,integrationId:integration.id,fingerprint:integration.version!.fingerprint,expectedRevision:round.revision,opinion:'检查通过'});
    const done=await until(ctx.engine,ctx.project.id,s=>s.flow?.status==='completed');assert.equal(done.acceptances[0].status,'accepted');assert.equal(await readFile(path.join(ctx.source,'a.txt'),'utf8'),'new-a.txt');assert.equal(await readFile(path.join(ctx.source,'b.txt'),'utf8'),'new-b.txt');
  }finally{await ctx.cleanup();}
});
test('internal round keeps the original untouched, automatically advances and final acceptance applies cumulative changes',async()=>{
  const plan=basePlan();plan.rounds.push({key:'next',title:'第二轮',goal:'补充 B',requiresUserAcceptance:false});plan.tasks[1].roundKey='next';plan.tasks[1].dependencies=['a'];
  const ctx=await setup(plan);try{const s=await until(ctx.engine,ctx.project.id,s=>s.rounds[1]?.status==='awaiting_acceptance');assert.equal(s.rounds[0].status,'accepted');assert.equal(s.rounds[1].requiresUserAcceptance,true);assert.equal(s.acceptances[0].actor,'lead');assert.equal(await readFile(path.join(ctx.source,'a.txt'),'utf8'),'old-a');
    const round=s.rounds[1],integration=s.integrations.find(i=>i.id===round.integrationId)!;await ctx.engine.invoke('projectFlow.round.accept',{requestId:'final',roundId:round.id,integrationId:integration.id,fingerprint:integration.version!.fingerprint,expectedRevision:round.revision});await until(ctx.engine,ctx.project.id,s=>s.flow?.status==='completed');assert.equal(await readFile(path.join(ctx.source,'a.txt'),'utf8'),'new-a.txt');assert.equal(await readFile(path.join(ctx.source,'b.txt'),'utf8'),'new-b.txt');
  }finally{await ctx.cleanup();}
});
test('preflight conflicts prevent every file write and do not mark acceptance successful',async()=>{
  const ctx=await setup(basePlan());try{const s=await until(ctx.engine,ctx.project.id,s=>s.rounds[0]?.status==='awaiting_acceptance'),round=s.rounds[0],integration=s.integrations[0];await writeFile(path.join(ctx.source,'a.txt'),'external');await ctx.engine.invoke('projectFlow.round.accept',{requestId:'conflict',roundId:round.id,integrationId:integration.id,fingerprint:integration.version!.fingerprint,expectedRevision:round.revision});const blocked=await until(ctx.engine,ctx.project.id,s=>s.acceptances[0]?.status==='conflict');assert.equal(blocked.rounds[0].status,'awaiting_acceptance');assert.equal(await readFile(path.join(ctx.source,'a.txt'),'utf8'),'external');assert.equal(await readFile(path.join(ctx.source,'b.txt'),'utf8'),'old-b');}finally{await ctx.cleanup();}
});
test('early-start requires a scoped user decision; silence starts no next-round run',async()=>{
  const plan=basePlan();plan.rounds.push({key:'next',title:'第二轮',goal:'继续 A',requiresUserAcceptance:true});plan.tasks.push({...plan.tasks[0],key:'c',roundKey:'next',dependencies:['a']});
  // Override setup's per-round choices so the first round remains a user checkpoint.
  plan.rounds[0].requiresUserAcceptance=true;plan.rounds[0].key='first';plan.tasks[0].roundKey='first';plan.tasks[1].roundKey='first';
  const ctx=await setup(plan,async(ctx,kind)=>{if(kind==='submission'&&ctx.run.provider==='dsh')await new Promise(r=>setTimeout(r,600));return undefined;});
  try{const s=await until(ctx.engine,ctx.project.id,s=>s.decisions.some(d=>d.kind==='early-start')),decision=s.decisions.find(d=>d.kind==='early-start')!;await new Promise(r=>setTimeout(r,150));assert.equal(ctx.calls.filter(c=>c.kind==='submission'&&c.ctx.run.provider==='claude').length,1);
    await ctx.engine.invoke('projectFlow.decision.answer',{requestId:'early',decisionId:decision.id,expectedRevision:decision.revision,choice:'允许提前开工',selectedTaskIds:decision.eligibleTaskIds});const started=await until(ctx.engine,ctx.project.id,s=>s.tasks.some(t=>t.key==='c'&&['queued','running','awaiting_review','review_passed'].includes(t.status)));assert.equal(started.tasks.find(t=>t.key==='c')!.earlyDecisionId,decision.id);
  }finally{await ctx.cleanup();}
});
test('partial filesystem apply persists recovery state, preserves later external edits, and explicitly resumes remaining files',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM flow-apply-')),projectDir=path.join(directory,'project');await mkdir(projectDir);await writeFile(path.join(projectDir,'a.txt'),'old-a');await writeFile(path.join(projectDir,'b.txt'),'old-b');
  const store=new Store(path.join(directory,'data')),artifacts=new FlowArtifacts(store);store.put('projects','p',{id:'p',directory:projectDir});
  try{const base=await artifacts.capture({id:'flow',projectId:'p'},projectDir,'base'),changed=await artifacts.capture({id:'flow',projectId:'p'},base.root,'integration',base.id);await writeFile(path.join(changed.root,'a.txt'),'new-a');await writeFile(path.join(changed.root,'b.txt'),'new-b');changed.fingerprint=await import('../src/backend/workspace').then(m=>m.workspaceFingerprint(changed.root));store.put('flow_artifacts',changed.id,changed);
    const temp=path.join(projectDir,'b.txt.airoom-flow-test-operation');await mkdir(temp);const applications=new FlowApply(store,artifacts),interrupted=await applications.apply('test-operation',changed,projectDir);assert.equal(interrupted.state,'recovery_required');assert.equal(await readFile(path.join(projectDir,'a.txt'),'utf8'),'new-a');assert.equal(await readFile(path.join(projectDir,'b.txt'),'utf8'),'old-b');
    await writeFile(path.join(projectDir,'a.txt'),'external-after-interruption');const restarted=new FlowApply(store,artifacts),conflict=await restarted.recover('test-operation','continue');assert.equal(conflict.state,'recovery_required');assert.equal(await readFile(path.join(projectDir,'a.txt'),'utf8'),'external-after-interruption');
    await writeFile(path.join(projectDir,'a.txt'),'new-a');await rm(temp,{recursive:true});const recovered=await restarted.recover('test-operation','continue');assert.equal(recovered.state,'applied');assert.equal(await readFile(path.join(projectDir,'b.txt'),'utf8'),'new-b');assert.equal((await restarted.recover('test-operation','reconcile')).state,'applied');
  }finally{store.close();await rm(directory,{recursive:true,force:true});}
});
test('flow error transport retains a stable code and readable message',()=>{assert.throws(()=>unwrapProjectFlowReply({__airoomFlowError:{code:'STALE_VERSION',message:'成果已变化'}}),(e:unknown)=>{assert.equal((e as {code:string}).code,'STALE_VERSION');assert.equal((e as Error).message,'成果已变化');return true;});});
test('integration repairs stop after two attempts and ask who should redo only the stuck integration',async()=>{
  const plan=basePlan();plan.tasks=plan.tasks.slice(0,1);
  const ctx=await setup(plan,async(ctx,kind,prompt)=>{if(kind==='integration-check')return review(JSON.parse(prompt.split('任务材料：')[1]).criteria,'changes_requested');if(kind==='submission'){const task=JSON.parse(prompt.split('任务材料：')[1]).task;if(task.kind==='integration-fix'){await writeFile(path.join(ctx.cwd,'a.txt'),'fixed');return {summary:'修正',evidence,completionResults:task.completionCriteria.map((criterion:string)=>({criterion,verified:true,evidence:'读取'}))};}}return undefined;});
  try{const s=await until(ctx.engine,ctx.project.id,s=>s.rounds[0]?.status==='blocked'&&s.decisions.some(d=>d.kind==='replan'));assert.equal(s.rounds[0].integrationFixCount,2);assert.equal(s.tasks.filter(t=>t.kind==='integration-fix').length,2);assert.equal(await readFile(path.join(ctx.source,'a.txt'),'utf8'),'old-a');}finally{await ctx.cleanup();}
});
test('unknown execution is blocked across restart and resume never replays the old request',async()=>{
  const plan=basePlan();plan.tasks=plan.tasks.slice(0,1);const ctx=await setup(plan,async(_ctx,kind)=>{if(kind==='submission')throw new Error('connection lost after delivery');return undefined;});let restarted:Engine|undefined;
  try{const blocked=await until(ctx.engine,ctx.project.id,s=>s.tasks[0]?.status==='blocked');assert.ok(blocked.flow!.blockedReasons.length);assert.equal(ctx.calls.filter(c=>c.kind==='submission').length,1);await ctx.engine.close();let replayed=0;
    restarted=new Engine(path.join(ctx.directory,'data'),()=>{},()=>{},id=>({probe:async()=>({id,name:id,available:true,auth:'subscription',detail:'mock',capabilities:{steer:false,cancel:'native',streaming:true,write:true,history:true}}),start:async()=>{replayed++;return {};},stop:async()=>{}}));
    const state=await restarted.invoke('projectFlow.get',{projectId:ctx.project.id}) as ProjectFlowSnapshot;assert.equal(state.flow!.dispatchMode,'paused');await assert.rejects(restarted.invoke('projectFlow.resume',{requestId:'resume',flowId:state.flow!.id,expectedRevision:state.flow!.revision}),/阻塞/);await new Promise(r=>setTimeout(r,100));assert.equal(replayed,0);
  }finally{await restarted?.close();await ctx.cleanup();}
});

test('a replacement plan waits for confirmation, keeps history and never advances the old plan',async()=>{
  const next=basePlan();next.tasks=next.tasks.slice(0,1);next.tasks[0].goal='重新修改 A';let replacing=false;
  const ctx=await setup(basePlan(),async(adapter,kind,prompt)=>{if(kind==='plan'&&replacing)return next;if(kind==='submission'&&replacing){await writeFile(path.join(adapter.cwd,'a.txt'),'revised-a');return {summary:'新版完成',evidence,completionResults:[{criterion:'A 正确',verified:true,evidence:'读取'}]};}return undefined;});
  try{const old=await until(ctx.engine,ctx.project.id,s=>s.rounds[0]?.status==='awaiting_acceptance'&&s.plan?.allowedActions?.some(a=>a.name==='projectFlow.plan.revise'&&a.enabled)===true);replacing=true;
    await ctx.engine.invoke('projectFlow.plan.revise',{requestId:'revise',planId:old.plan!.id,expectedRevision:old.plan!.revision,instruction:'重新修改 A，保留已有成果'});const pending=await until(ctx.engine,ctx.project.id,s=>s.plan?.parentPlanId===old.plan!.id&&s.plan.status==='awaiting_confirmation');
    const before=ctx.calls.filter(c=>c.kind==='submission').length;await new Promise(r=>setTimeout(r,100));assert.equal(ctx.calls.filter(c=>c.kind==='submission').length,before);assert.equal(pending.overview.needsUser,1);
    await assert.rejects(ctx.engine.invoke('projectFlow.round.accept',{requestId:'old-round',roundId:old.rounds[0].id,integrationId:old.integrations[0].id,fingerprint:old.integrations[0].version!.fingerprint,expectedRevision:old.rounds[0].revision}),/当前/);
    await ctx.engine.invoke('projectFlow.plan.confirm',{requestId:'new-confirm',planId:pending.plan!.id,expectedRevision:pending.plan!.revision,requiresUserAcceptanceByRound:{r:true}});
    const ready=await until(ctx.engine,ctx.project.id,s=>s.rounds.some(r=>r.planId===pending.plan!.id&&r.status==='awaiting_acceptance')),round=ready.rounds.find(r=>r.planId===pending.plan!.id)!,integration=ready.integrations.find(i=>i.id===round.integrationId)!;
    assert.equal((await ctx.engine.invoke('projectFlow.detail',{projectId:ctx.project.id,kind:'plan',id:old.plan!.id}) as {status:string}).status,'superseded');assert.equal(ready.tasks.filter(t=>t.planId===pending.plan!.id).length,1);
    await ctx.engine.invoke('projectFlow.round.accept',{requestId:'new-accept',roundId:round.id,integrationId:integration.id,fingerprint:integration.version!.fingerprint,expectedRevision:round.revision});await until(ctx.engine,ctx.project.id,s=>s.flow?.status==='completed');assert.equal(await readFile(path.join(ctx.source,'a.txt'),'utf8'),'revised-a');
  }finally{await ctx.cleanup();}
});

test('an early task becomes stale when an accepted repair changes its dependency',async()=>{
  const plan=basePlan();plan.rounds[0].requiresUserAcceptance=true;plan.rounds[0].key='first';plan.tasks.forEach(t=>t.roundKey='first');plan.rounds.push({key:'next',title:'第二轮',goal:'继续 A',requiresUserAcceptance:true});plan.tasks.push({...plan.tasks[0],key:'c',roundKey:'next',dependencies:['a']});
  const ctx=await setup(plan,async(adapter,kind,prompt)=>{if(kind==='submission'){const task=JSON.parse(prompt.split('任务材料：')[1]).task;if(task.key==='b')await new Promise(r=>setTimeout(r,2000));if(task.key==='c'){await writeFile(path.join(adapter.cwd,'a.txt'),'early-c');return {summary:'提前完成',evidence,completionResults:[{criterion:'A 正确',verified:true,evidence:'读取'}]};}if(task.kind==='integration-fix'){await writeFile(path.join(adapter.cwd,'a.txt'),'parent-fixed');return {summary:'修正前轮',evidence,completionResults:[{criterion:'整合问题已解决',verified:true,evidence:'读取'}]};}}return undefined;});
  try{const card=await until(ctx.engine,ctx.project.id,s=>s.decisions.some(d=>d.kind==='early-start')),decision=card.decisions.find(d=>d.kind==='early-start')!;await ctx.engine.invoke('projectFlow.decision.answer',{requestId:'early',decisionId:decision.id,expectedRevision:decision.revision,choice:'允许提前开工',selectedTaskIds:decision.eligibleTaskIds});await until(ctx.engine,ctx.project.id,s=>s.tasks.some(t=>t.key==='c'&&t.status==='review_passed'));
    const first=await until(ctx.engine,ctx.project.id,s=>s.rounds[0]?.status==='awaiting_acceptance');await ctx.engine.invoke('projectFlow.round.requestChanges',{requestId:'fix-parent',roundId:first.rounds[0].id,integrationId:first.rounds[0].integrationId,expectedRevision:first.rounds[0].revision,opinion:'前轮 A 需要再修正'});
    const fixed=await until(ctx.engine,ctx.project.id,s=>s.rounds[0]?.status==='awaiting_acceptance'&&s.rounds[0].userChangeRequests?.length===1),round=fixed.rounds[0],integration=fixed.integrations.find(i=>i.id===round.integrationId)!;
    assert.equal(fixed.reviews.filter(r=>fixed.tasks.find(t=>t.id===r.taskId)?.kind==='integration-fix').length,0,'the lead fix goes back to the integration check, not to another member');
    await ctx.engine.invoke('projectFlow.round.accept',{requestId:'accept-fixed',roundId:round.id,integrationId:integration.id,fingerprint:integration.version!.fingerprint,expectedRevision:round.revision});
    const stale=await until(ctx.engine,ctx.project.id,s=>s.rounds[0]?.status==='accepted'&&s.tasks.find(t=>t.key==='c')?.status==='blocked'),task=stale.tasks.find(t=>t.key==='c')!;assert.equal(stale.submissions.find(s=>s.id===task.latestSubmissionId)?.status,'stale');assert.equal(task.sessionId,undefined);assert.ok(stale.decisions.some(d=>d.taskId===task.id&&d.kind==='replan'&&d.status==='open'));assert.equal(await readFile(path.join(ctx.source,'a.txt'),'utf8'),'parent-fixed');
  }finally{await ctx.cleanup();}
});

test('native command completion is required before a command claim can pass review',async()=>{
  // The format correction repeats the claim, as a member would that cannot back it; the unobserved claim still blocks.
  for(const observed of [false,true]){let last:unknown;const plan=basePlan();plan.tasks=plan.tasks.slice(0,1);const ctx=await setup(plan,async(adapter,kind,prompt)=>{if(prompt.includes('仅补正上轮 JSON 格式'))return last;if(kind==='review'){if(observed)adapter.emit('tool','结束：npm test',{id:'native-command',type:'commandExecution',command:'npm test',exitCode:0,status:'completed'},'native');return last={...review(JSON.parse(prompt.split('任务材料：')[1]).task.completionCriteria),evidence:[{kind:'command',description:'实际测试',command:'npm test',exitCode:0,result:'通过',eventIds:[]}]};}return undefined;});
    try{const state=await until(ctx.engine,ctx.project.id,s=>s.tasks[0]?.status===(observed?'review_passed':'blocked'));if(observed)assert.equal(state.reviews[0].evidence[0].source,'observed');else assert.match(state.tasks[0].blockedReason!,/实际完成事件/);}finally{await ctx.cleanup();}
  }
});

test('artifact copies retain tracked ignored files and ignore newly generated build output',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM flow-git-')),source=path.join(directory,'project');await mkdir(source);await writeFile(path.join(source,'a.txt'),'source');await writeFile(path.join(source,'.gitignore'),'dist/\nignored.txt\n');await writeFile(path.join(source,'ignored.txt'),'tracked');const exec=promisify(execFile);await exec('git',['init','--quiet','--template=',source],{windowsHide:true});await exec('git',['-C',source,'add','-f','--','.'],{windowsHide:true});
  const store=new Store(path.join(directory,'data'));store.put('projects','p',{id:'p',directory:source});try{const artifacts=new FlowArtifacts(store),base=await artifacts.capture({id:'flow',projectId:'p'},source,'base');assert.equal(await readFile(path.join(base.root,'ignored.txt'),'utf8'),'tracked');await mkdir(path.join(base.root,'dist'));await writeFile(path.join(base.root,'dist','bundle.js'),'generated');assert.equal(await workspaceFingerprint(base.root),base.fingerprint);assert.ok(!(await artifacts.manifest(base.root))['dist/bundle.js']);
  }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test('pausing dispatch saves a completed task but waits before starting its review',async()=>{
  const plan=basePlan();plan.tasks=plan.tasks.slice(0,1);let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);const ctx=await setup(plan,async(_adapter,kind)=>{if(kind==='submission')await gate;return undefined;});
  try{const running=await until(ctx.engine,ctx.project.id,s=>s.tasks[0]?.status==='running');await ctx.engine.invoke('projectFlow.pause',{requestId:'pause',flowId:running.flow!.id,expectedRevision:running.flow!.revision,mode:'dispatch'});release();const waiting=await until(ctx.engine,ctx.project.id,s=>s.tasks[0]?.status==='awaiting_review');assert.equal(ctx.calls.filter(c=>c.kind==='review').length,0);assert.equal(waiting.flow!.blockedReasons.length,0);
    await ctx.engine.invoke('projectFlow.resume',{requestId:'resume',flowId:waiting.flow!.id,expectedRevision:waiting.flow!.revision});await until(ctx.engine,ctx.project.id,s=>s.rounds[0]?.status==='awaiting_acceptance');assert.equal(ctx.calls.filter(c=>c.kind==='submission').length,1);
  }finally{release();await ctx.cleanup();}
});

test('pausing during integration check saves that check and resumes only the report',async()=>{
  const plan=basePlan();plan.tasks=plan.tasks.slice(0,1);let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);const ctx=await setup(plan,async(_adapter,kind)=>{if(kind==='integration-check')await gate;return undefined;});
  try{const checking=await until(ctx.engine,ctx.project.id,s=>s.rounds[0]?.status==='checking'&&ctx.calls.some(c=>c.kind==='integration-check'));await ctx.engine.invoke('projectFlow.pause',{requestId:'pause',flowId:checking.flow!.id,expectedRevision:checking.flow!.revision,mode:'dispatch'});release();const waiting=await until(ctx.engine,ctx.project.id,s=>Boolean(s.integrations[0]?.checkRunId));await new Promise(r=>setTimeout(r,100));assert.equal(ctx.calls.filter(c=>c.kind==='round-report').length,0);assert.equal(waiting.flow!.blockedReasons.length,0);
    const paused=await ctx.engine.invoke('projectFlow.get',{projectId:ctx.project.id}) as ProjectFlowSnapshot;await ctx.engine.invoke('projectFlow.resume',{requestId:'resume',flowId:paused.flow!.id,expectedRevision:paused.flow!.revision});await until(ctx.engine,ctx.project.id,s=>s.rounds[0]?.status==='awaiting_acceptance');assert.equal(ctx.calls.filter(c=>c.kind==='integration-check').length,1);assert.equal(ctx.calls.filter(c=>c.kind==='round-report').length,1);
  }finally{release();await ctx.cleanup();}
});
