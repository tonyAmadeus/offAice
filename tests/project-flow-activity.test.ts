import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../src/backend/store';
import {roundActivityMaterial} from '../src/backend/project-flow-activity';
import type {Round} from '../src/shared/project-flow';
import type {TimelineEvent} from '../src/shared/types';
import {harness,passing,plan} from './helpers/project-flow-harness';

const round={id:'round',flowId:'flow',projectId:'project'} as Round;
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'AIROOM-activity-')),store=new Store(root);return {store,dispose:async()=>{store.close();await rm(root,{recursive:true,force:true});}};}
function addTask(store:Store,key='a'){
  const id='task-'+key;store.put('flow_tasks',id,{id,key,flowId:'flow',roundId:'round',projectId:'project',memberId:'dsh',status:'running',dependencies:[],latestSubmissionId:'submission-'+key});
  store.put('flow_operations','operation-'+key,{id:'operation-'+key,flowId:'flow',targetId:id,kind:'task',runId:'run-'+key,correctionRunId:'repair-'+key,state:'blocked'});
  for(const runId of ['run-'+key,'repair-'+key])store.put('runs',runId,{id:runId,projectId:'project',sessionId:'session-'+key,provider:'dsh',status:runId.startsWith('repair')?'unknown':'stopped',delivery:runId.startsWith('repair')?'unknown':'confirmed',createdAt:'2026-10-08T01:00:00.000Z',completedAt:runId.startsWith('repair')?undefined:'2026-10-08T01:00:05.000Z'});
  store.put('flow_submissions','submission-'+key,{id:'submission-'+key,taskId:id,runId:'repair-'+key,summary:'自报：已经等完并成功',evidence:[{source:'reported',exitCode:0,result:'WAIT-END'}]});return id;
}
function event(store:Store,id:string,data:unknown,patch:Partial<TimelineEvent>={}){store.appendEvent({id,runId:'run-a',sessionId:'session-a',provider:'dsh',at:'2026-10-08T01:00:02.000Z',kind:'tool',text:'命令记录',fidelity:'native',data,...patch});}

test('round activity preserves separate stopped and unknown runs, native wait evidence and the absence of an exit code',async()=>{
  const f=await fixture();try{
    addTask(f.store);event(f.store,'start',{toolCallId:'wait',status:'in_progress',rawInput:{command:'Write-Output WAIT-START; Start-Sleep -Seconds 60'}});
    event(f.store,'end',{toolCallId:'wait',status:'completed',content:[{type:'content',content:{type:'text',text:'WAIT-START\nWAIT-END'}}]});
    event(f.store,'derived',{command:'pretend-success',status:'completed',exitCode:0},{fidelity:'derived'});event(f.store,'foreign',{command:'other-project'},{runId:'foreign'});
    const material=roundActivityMaterial(f.store,round),original=material.runs.find(run=>run.id==='run-a')!,repair=material.runs.find(run=>run.id==='repair-a')!;
    assert.equal(original.status,'stopped');assert.equal(repair.status,'unknown');assert.equal(repair.delivery,'unknown');assert.equal(repair.role,'format-correction');assert.equal(repair.completedAt,undefined);
    assert.deepEqual(original.nativeEvents.map(item=>item.eventId),['start','end']);assert.match(original.nativeEvents[0].observation!.command!,/Start-Sleep -Seconds 60/);assert.match(original.nativeEvents[1].detail,/WAIT-END/);assert.equal(original.nativeEvents[1].observation!.exitCode,undefined);
    assert.equal(JSON.stringify(material).includes('自报'),true,'the policy explicitly distinguishes member claims');assert.equal(JSON.stringify(material).includes('自报：已经等完'),false);assert.equal(material.truncated,false);assert.match(material.notice,/排队时间，不能证明命令已开始/);
  }finally{await f.dispose();}
});

test('long activity keeps beginning and final tool records, redacts credentials and declares every omitted record',async()=>{
  const f=await fixture();try{
    addTask(f.store);for(let index=0;index<30;index++)event(f.store,'event-'+index,{command:'command-'+index,status:'completed',output:'WAIT-START\n'+'x'.repeat(6000)+'\nWAIT-END\nBearer privatecredential0123456789'});
    const material=roundActivityMaterial(f.store,round),run=material.runs.find(run=>run.id==='run-a')!;
    assert.equal(f.store.nativeToolEventWindow('run-a').events.length,12);assert.equal(run.nativeEventTotal,30);assert.equal(run.omittedNativeEvents,30-run.nativeEvents.length);assert.ok(run.nativeEvents.length>=2&&run.nativeEvents.length<=12);assert.equal(run.nativeEvents[0].eventId,'event-0');assert.equal(run.nativeEvents.at(-1)!.eventId,'event-29');assert.equal(material.truncated,true);
    assert.match(run.nativeEvents[0].detail,/WAIT-START/);assert.match(run.nativeEvents[0].detail,/WAIT-END/);assert.equal(run.nativeEvents[0].contentTruncated,true);assert.equal(JSON.stringify(material).includes('privatecredential'),false);assert.ok(JSON.stringify(material).length<=32000);
    for(let index=1;index<45;index++){addTask(f.store,String(index));for(let j=0;j<16;j++)event(f.store,`large-${index}-${j}`,{command:'x'.repeat(5000),output:'x'.repeat(5000)},{runId:'run-'+index});}
    const capped=roundActivityMaterial(f.store,round);assert.ok(capped.omittedTasks>0);assert.ok(capped.omittedRuns>0);assert.ok(capped.truncated);assert.ok(JSON.stringify(capped).length<=32000);
  }finally{await f.dispose();}
});

test('whole-round reports and requested checks receive the actual task calls and original command result',async()=>{
  const h=await harness({level:'low',handler:async call=>{
    if(call.kind==='submission'){
      const command='Write-Output WAIT-START; Write-Output WAIT-END';call.ctx.emit('tool','等待开始',{toolCallId:'wait',rawInput:{command},status:'in_progress'},'native');call.ctx.emit('tool','等待完成',{toolCallId:'wait',status:'completed',content:[{type:'content',content:{type:'text',text:'WAIT-START\nWAIT-END'}}]},'native');
    }
  }});try{
    await h.confirm();const choice=await h.wait(data=>data.decisions.some(decision=>decision.kind==='review-choice'&&decision.status==='open'));await h.answer(choice.decisions.find(decision=>decision.kind==='review-choice'&&decision.status==='open')!,'直接由我验收');const ready=await h.wait(data=>Boolean(data.rounds[0]?.allowedActions?.find(action=>action.name==='projectFlow.round.requestCheck')?.enabled));
    const report=h.calls.find(call=>call.kind==='round-report')!,activity=report.material.executionActivity;assert.equal(activity.source,'airoom-recorded');
    const authors=h.calls.filter(call=>call.kind==='submission');assert.equal(authors.length,2);for(const author of authors){const recorded=activity.runs.find((run:any)=>run.id===author.ctx.run.id);assert.ok(recorded);assert.equal(recorded.status,'ended');assert.match(recorded.nativeEvents[1].detail,/WAIT-END/);assert.equal(recorded.nativeEvents[1].observation.exitCode,undefined);}
    const current=ready.rounds[0],integration=ready.integrations.find(item=>item.id===current.integrationId)!;await h.engine.invoke('projectFlow.round.requestCheck',{requestId:crypto.randomUUID(),roundId:current.id,expectedRevision:current.revision,integrationId:integration.id,fingerprint:integration.version!.fingerprint,memberId:'codex'});await h.wait(data=>data.requestedChecks?.some(check=>check.status==='completed')===true);
    const check=h.calls.find(call=>call.kind==='requested-check')!;assert.ok(check.material.executionActivity.runs.some((run:any)=>run.id===authors[0].ctx.run.id));assert.equal(check.material.executionActivity.tasks.length,2);
    assert.deepEqual(check.material.changes.map((change:any)=>change.path).sort(),['a.txt','b.txt']);assert.match(check.material.diff,/-old-a/);assert.match(check.material.diff,/\+new-a/);assert.match(check.material.instruction,/作者.*一次性.*目录不同/);assert.equal(await h.original(),'old-a');
  }finally{await h.dispose();}
});

test('individual task reviewers receive the author native wait result without treating a missing exit code as success',async()=>{
  const p=plan();p.tasks=p.tasks.slice(0,1);
  const h=await harness({plan:p,handler:async call=>{
    if(call.kind==='submission'){
      call.ctx.emit('tool','等待开始',{toolCallId:'real-wait',status:'in_progress',rawInput:{command:'Start-Sleep -Seconds 90'}},'native');
      call.ctx.emit('tool','等待结束',{toolCallId:'real-wait',status:'completed',content:[{type:'content',content:{type:'text',text:'WAIT-END elapsed=90.01s'}}]},'native');
    }
  }});try{
    await h.confirm();await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');
    const author=h.calls.find(c=>c.kind==='submission')!,review=h.calls.find(c=>c.kind==='review')!,activity=review.material.executionActivity;
    assert.equal(activity.source,'airoom-recorded');const recorded=activity.runs.find((r:any)=>r.id===author.ctx.run.id);
    assert.ok(recorded);assert.equal(recorded.status,'ended');assert.match(recorded.nativeEvents[1].detail,/elapsed=90.01s/);
    assert.equal(recorded.nativeEvents[1].observation.exitCode,undefined);
  }finally{await h.dispose();}
});

test('a combined integration report and independent peer check retain the original author run facts',async()=>{
  const h=await harness({peer:true,handler:async call=>{
    if(call.kind==='integration-check')return {...passing(call.material.criteria),report:{summary:'整合并汇报',completedTaskKeys:plan().tasks.map(task=>task.key),deliverables:['文件'],validationSummary:'实际检查',remainingIssues:[],nextRoundSummary:'本轮结束',userDecisionNeeded:'请验收',meetingResponses:[]}};
  }});try{
    await h.confirm();await h.wait(data=>Boolean(data.rounds[0]?.allowedActions?.find(action=>action.name==='projectFlow.round.accept')?.enabled));
    const authorIds=h.calls.filter(call=>call.kind==='submission').map(call=>call.ctx.run.id);assert.equal(authorIds.length,2);
    for(const kind of ['integration-check','peer-review']){const activity=h.calls.find(call=>call.kind===kind)!.material.executionActivity;assert.equal(activity.source,'airoom-recorded');for(const id of authorIds)assert.ok(activity.runs.some((run:any)=>run.id===id&&run.status==='ended'));}
    assert.equal(h.calls.some(call=>call.kind==='round-report'),false,'a combined report keeps its evidence without an extra model call');
  }finally{await h.dispose();}
});
