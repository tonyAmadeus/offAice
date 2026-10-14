import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,stat,rm} from 'node:fs/promises';
import path from 'node:path';
import {harness,plan,passing} from './helpers/project-flow-harness';
import {ProjectWorkbench} from '../src/backend/project-workbench';
import type {TaskAddition,ProjectRecord,MemberReportPage} from '../src/shared/project-workbench';
import type {ProjectFlowSnapshot} from '../src/shared/project-flow';
const sleep=()=>new Promise(r=>setTimeout(r,30));
async function proposed(h:Awaited<ReturnType<typeof harness>>,extra:Record<string,unknown>={}){
  let s=await h.state();await sleep();s=await h.state();
  const result=await h.engine.invoke('projectFlow.task.prepare',{requestId:crypto.randomUUID(),flowId:s.flow!.id,expectedRevision:s.flow!.revision,memberId:'claude',title:'补充成果',goal:'追加同一份成果',roundId:s.rounds[0].id,...extra}) as {proposalId:string};
  let p:TaskAddition|undefined;for(let i=0;i<200;i++){p=await h.engine.invoke('projectFlow.task.proposal',{projectId:h.project.id,proposalId:result.proposalId}) as TaskAddition;if(p.status!=='preparing')return p;await sleep();}throw Error('proposal did not settle');
}
const prepareReply=(inScope=true,allowedPaths=['a.txt'])=>({completionCriteria:['新增内容正确'],allowedPaths,inScope,scopeReason:inScope?'属于已确认目标':'超出当前目标或路径'});
test('H3 previous saved work is explicit planning background and the next start can opt out',async()=>{
  const h=await harness();try{
    let s=await h.state();await h.engine.invoke('projectFlow.cancel',{requestId:'cancel-first',flowId:s.flow!.id,expectedRevision:s.flow!.revision});const first=s.flow!.id,before=h.calls.length;
    await h.engine.invoke('projectFlow.start',{requestId:'with-background',projectId:h.project.id,leadMemberId:'codex',memberIds:['codex','claude','dsh'],topic:'下一段工作'});s=await h.wait(s=>s.flow!.id!==first&&s.plan?.status==='awaiting_confirmation');
    const call=h.calls.slice(before).find(c=>c.kind==='plan')!;assert.equal(call.material.previousRecord.flowId,first);assert.match(call.material.previousRecord.summary,/已取消/);
    await h.engine.invoke('projectFlow.cancel',{requestId:'cancel-second',flowId:s.flow!.id,expectedRevision:s.flow!.revision});const second=s.flow!.id,next=h.calls.length;
    await h.engine.invoke('projectFlow.start',{requestId:'without-background',projectId:h.project.id,leadMemberId:'codex',memberIds:['codex','claude','dsh'],topic:'独立开始',includePreviousRecord:false});await h.wait(s=>s.flow!.id!==second&&s.plan?.status==='awaiting_confirmation');assert.equal(h.calls.slice(next).find(c=>c.kind==='plan')!.material.previousRecord,undefined);
  }finally{await h.dispose();}
});
test('H1 unknown preparation is never retried implicitly or bypassed by another request',async()=>{
  const h=await harness({handler:async c=>{if(c.kind==='task-addition')throw Error('unknown transport result');return undefined;}});
  try{await h.confirm();await h.wait(s=>s.rounds[0].status==='awaiting_acceptance');const p=await proposed(h);assert.equal(p.status,'blocked');const count=h.calls.filter(c=>c.kind==='task-addition').length;const s=await h.state();await assert.rejects(h.engine.invoke('projectFlow.task.prepare',{requestId:'try-again',flowId:s.flow!.id,expectedRevision:s.flow!.revision,memberId:'claude',title:'重试',goal:'同一个目标'}),/先核对/);await sleep();assert.equal(h.calls.filter(c=>c.kind==='task-addition').length,count);}
  finally{await h.dispose();}
});
test('H1 prepares without file work, confirms an appended task, queues overlapping work and preserves confirmed plan',async()=>{
  const h=await harness({handler:async c=>c.kind==='task-addition'?prepareReply():undefined});
  try{
    await h.confirm();let s=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');await sleep();
    const before=JSON.stringify(h.engine.store.get('flow_plans',s.plan!.id)),authored=h.calls.filter(c=>c.kind==='submission').length,p=await proposed(h,{sourceText:'@Claudia 安排新任务：追加同一份成果'});
    assert.equal(p.status,'ready');assert.ok(p.sourceMessageId);assert.equal(h.calls.filter(c=>c.kind==='submission').length,authored);
    const reply=await h.engine.invoke('projectFlow.task.add',{requestId:'add-once',proposalId:p.id,expectedRevision:p.revision}) as {entityId:string};
    s=await h.state();const task=s.tasks.find(t=>t.id===reply.entityId)!;assert.ok(task);assert.equal(task.returnCount,0);assert.ok(task.confirmedAt);assert.equal(task.sourceMessageId,p.sourceMessageId);assert.ok(task.dependencies.includes(s.tasks.find(t=>t.key==='a')!.id));assert.equal(JSON.stringify(h.engine.store.get('flow_plans',s.plan!.id)),before);
    await h.engine.invoke('projectFlow.task.add',{requestId:'add-once',proposalId:p.id,expectedRevision:p.revision});assert.equal((await h.state()).tasks.filter(t=>t.additionId===p.id).length,1);
    s=await h.wait(s=>s.rounds[0].status==='awaiting_acceptance');assert.equal(s.integrations.find(i=>i.id===s.rounds[0].integrationId)?.includedSubmissionIds.length,3);
  }finally{await h.dispose();}
});
test('H1 scope expansion waits for a separate user decision, and cross-project source is rejected',async()=>{
  const h=await harness({handler:async c=>c.kind==='task-addition'?prepareReply(false,['c.txt']):undefined});
  try{
    await h.confirm();await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');const p=await proposed(h);
    const result=await h.engine.invoke('projectFlow.task.add',{requestId:'scope-add',proposalId:p.id,expectedRevision:p.revision}) as {decisionId:string};
    let s=await h.state();assert.equal(s.tasks.length,2);const d=s.decisions.find(d=>d.id===result.decisionId)!;assert.equal(d.kind,'scope-change');assert.equal(d.additionId,p.id);
    await h.answer(d,'确认追加范围');s=await h.state();assert.equal(s.tasks.length,3);assert.equal(s.plan!.tasks.length,2);assert.deepEqual(s.tasks.find(t=>t.additionId===p.id)?.allowedPaths,['c.txt']);
    const global=h.engine.store.currentRoomThread('global');h.engine.store.put('room_messages','foreign',{id:'foreign',author:'user',threadId:global.id,text:'别的房间',at:new Date().toISOString()});
    s=await h.wait(s=>s.rounds[0].status==='awaiting_acceptance');await sleep();s=await h.state();
    await assert.rejects(h.engine.invoke('projectFlow.task.prepare',{requestId:'foreign-source',flowId:s.flow!.id,expectedRevision:s.flow!.revision,roundId:s.rounds[0].id,memberId:'claude',title:'任务',goal:'目标',sourceMessageId:'foreign'}),/本项目/);
  }finally{await h.dispose();}
});
test('H1 completed flow and changed plan cannot confirm stale additions',async()=>{
  const h=await harness({handler:async c=>c.kind==='task-addition'?prepareReply():undefined});
  try{await h.confirm();await h.wait(s=>s.rounds[0].status==='awaiting_acceptance');const p=await proposed(h);let s=await h.state();const old=s.plan!;h.engine.store.put('flow_plans',old.id,{...old,revision:old.revision+1});await assert.rejects(h.engine.invoke('projectFlow.task.add',{requestId:'stale',proposalId:p.id,expectedRevision:p.revision}),/方案已改变/);h.engine.store.put('flow_plans',old.id,old);s=await h.state();await h.engine.invoke('projectFlow.cancel',{requestId:'cancel',flowId:s.flow!.id,expectedRevision:s.flow!.revision});await assert.rejects(h.engine.invoke('projectFlow.task.add',{requestId:'ended',proposalId:p.id,expectedRevision:p.revision}),/尚未结束/);}
  finally{await h.dispose();}
});
test('H3 generates complete saved-fact records with no model call and leaves project folders untouched by default',async()=>{
  const h=await harness();try{await h.confirm();let s=await h.wait(s=>s.rounds[0].status==='awaiting_acceptance');await h.engine.invoke('projectFlow.round.requestChanges',{requestId:'reject-record',roundId:s.rounds[0].id,integrationId:s.rounds[0].integrationId,expectedRevision:s.rounds[0].revision,opinion:'补足依据后再验收'});s=await h.wait(s=>s.rounds[0].status==='awaiting_acceptance');await h.accept();s=await h.wait(s=>s.flow!.status==='completed');const before=h.calls.length;const record=await h.engine.invoke('projectFlow.record',{projectId:h.project.id,flowId:s.flow!.id}) as ProjectRecord;assert.doesNotMatch(record.markdown,/## 检查|## 决策|方案和版本/);assert.match(record.markdown,/## 方案/);assert.match(record.markdown,/a.txt/);assert.ok(h.engine.store.get('flow_project_records',s.flow!.id));assert.equal(h.calls.length,before);await assert.rejects(stat(path.join(h.project.directory,'docs','airoom')),/ENOENT/);
    const exported=await h.engine.invoke('projectFlow.round.report.export',{projectId:h.project.id,roundId:s.rounds[0].id}) as {markdown:string};assert.match(exported.markdown,/本轮汇总/);assert.equal(h.calls.length,before);
  }finally{await h.dispose();}
});
test('H3 exports exclusively, changes colliding names, restarts idempotently, and export failure cannot undo completion',async()=>{
  const h=await harness();try{await h.confirm();let s=await h.wait(s=>s.rounds[0].status==='awaiting_acceptance');await h.engine.invoke('project.update',{projectId:h.project.id,projectRecordToFolder:true});await writeFile(path.join(h.project.directory,'docs'),'blocked folder');await h.accept();s=await h.wait(s=>s.flow!.status==='completed');const wb=new ProjectWorkbench(h.engine.store);await wb.finish(s.flow!.id);let record=wb.record({flowId:s.flow!.id});for(let i=0;record.receipt?.state==='prepared'&&i<200;i++){await sleep();record=wb.record({flowId:s.flow!.id});}assert.equal(record.receipt?.state,'failed');await rm(path.join(h.project.directory,'docs'));await mkdir(path.join(h.project.directory,'docs','airoom'),{recursive:true});
    const collision=path.join(h.project.directory,record.receipt!.path);await writeFile(collision,'已有的记录');const before=h.calls.length;await wb.write(s.flow!.id);const written=wb.record({flowId:s.flow!.id});assert.equal(written.receipt?.state,'written');assert.notEqual(written.receipt?.path,record.receipt?.path);assert.equal(await readFile(collision,'utf8'),'已有的记录');await new ProjectWorkbench(h.engine.store).finish(s.flow!.id);assert.equal(wb.record({flowId:s.flow!.id}).receipt?.path,written.receipt?.path);assert.equal(h.calls.length,before);assert.equal((await h.state()).flow!.status,'completed');
  }finally{await h.dispose();}
});
test('member reports preserve real author/reviewer roles, subjective assessments, historical names and project-scoped paging',async()=>{
  const p=plan();p.tasks=p.tasks.slice(0,1);
  const h=await harness({plan:p,handler:async c=>c.kind==='review'?{...passing(c.material.task.completionCriteria),assessments:[{criterion:'表达清楚',rating:'partly',reason:'结尾稍长'}],strengths:['结构清晰']}:undefined});
  try{await h.confirm();const s=await h.wait(s=>s.rounds[0].status==='awaiting_acceptance'),before=h.calls.length,wb=new ProjectWorkbench(h.engine.store);let page=wb.memberReports({projectId:h.project.id,limit:1});assert.ok(page.total>=3);assert.ok(page.hasMore);const cursor=page.cursor!;const all=wb.memberReports({projectId:h.project.id,limit:100});assert.equal(all.items.find(r=>r.memberId==='claude')?.role,'author');const reviewer=all.items.find(r=>r.role==='reviewer')!;assert.ok(reviewer);assert.deepEqual(reviewer.tasks,[]);assert.ok(reviewer.checks.some(c=>c.assessments[0]?.reason==='结尾稍长'));assert.ok(reviewer.checks.some(c=>c.strengths.includes('结构清晰')));
    const first=page.items[0].id;page=wb.memberReports({projectId:h.project.id,limit:100,cursor});assert.ok(page.items.every(r=>r.id!==first));assert.equal(page.items.length+1,all.total);assert.throws(()=>wb.memberReports({projectId:h.project.id,memberId:'claude',cursor}),/分页/);assert.equal(h.calls.length,before);
    h.engine.store.put('projects','other',{...h.project,id:'other',name:'其它'});assert.equal(wb.memberReports({projectId:'other'}).items.length,0);assert.throws(()=>wb.record({projectId:'other',flowId:s.flow!.id}),/不属于/);
    const flow=s.flow!;h.engine.store.put('project_flows',flow.id,{...flow,memberNames:{claude:'历史作者',...flow.memberNames}});h.engine.store.delete('members','claude');assert.equal(wb.memberReports({projectId:h.project.id,memberId:'claude'}).items[0].memberName,flow.memberNames?.claude??'历史作者');
  }finally{await h.dispose();}
});
