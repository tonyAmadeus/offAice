import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {harness,plan} from './helpers/project-flow-harness';
import type {Project} from '../src/shared/types';
import type {ProjectFlowSnapshot,FlowOperation} from '../src/shared/project-flow';

test('another project working does not prevent revising an idle plan; own active, unknown and unfinished writes still prevent revision',async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),p=plan();p.tasks=p.tasks.slice(0,1);
  const h=await harness({plan:p,handler:async c=>{if(c.kind==='submission')await gate;}});
  try{
    await h.confirm();const working=await h.wait(s=>s.tasks.some(t=>t.status==='running'));
    assert.equal(working.plan!.allowedActions!.find(a=>a.name==='projectFlow.plan.revise')!.enabled,false);
    await assert.rejects(h.engine.invoke('projectFlow.plan.revise',{requestId:'own-active',planId:working.plan!.id,expectedRevision:working.plan!.revision,instruction:'修改方案'}),/在途任务/);
    const directory=path.join(h.root,'second');await mkdir(directory);await writeFile(path.join(directory,'a.txt'),'second-original');
    const second=await h.engine.invoke('project.create',{directory}) as Project;
    await h.engine.invoke('projectFlow.start',{requestId:'second-start',projectId:second.id,leadMemberId:'codex',memberIds:['codex','claude','dsh'],topic:'修改文件'});
    const state=()=>h.engine.invoke('projectFlow.get',{projectId:second.id}) as Promise<ProjectFlowSnapshot>;
    const deadline=Date.now()+20000;let idle=await state();while(!idle.plan){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,25));idle=await state();}
    const enabled=(s:ProjectFlowSnapshot)=>s.plan!.allowedActions!.find(a=>a.name==='projectFlow.plan.revise')!.enabled;
    assert.equal(enabled(idle),true,'idle project stays editable while the other project is executing');
    const activeOp=h.engine.store.list<FlowOperation>('flow_operations').find(o=>o.flowId===working.flow!.id&&o.kind==='task'&&o.state==='running')!;
    const unknownOp={...activeOp,id:crypto.randomUUID(),flowId:idle.flow!.id,projectId:second.id,targetId:idle.plan!.id,state:'blocked' as const};
    h.engine.store.put('flow_operations',unknownOp.id,unknownOp);
    const originalRun=h.engine.store.get<any>('runs',activeOp.runId!)!,unknownRun={...originalRun,id:crypto.randomUUID(),projectId:second.id,flowOperationId:unknownOp.id,status:'unknown'};
    h.engine.store.put('runs',unknownRun.id,unknownRun);
    assert.equal(enabled(await state()),false,'unknown delivery in this project must still block revision');
    await assert.rejects(h.engine.invoke('projectFlow.plan.revise',{requestId:'own-unknown',planId:idle.plan!.id,expectedRevision:idle.plan!.revision,instruction:'修改方案'}),/未知运行/);
    h.engine.store.put('flow_operations',unknownOp.id,{...unknownOp,state:'done'});
    const write={id:crypto.randomUUID(),flowId:idle.flow!.id,projectId:second.id,status:'recovery_required'};h.engine.store.put('flow_acceptances',write.id,write);
    assert.equal(enabled(await state()),false,'unfinished write in this project must still block revision');
    await assert.rejects(h.engine.invoke('projectFlow.plan.revise',{requestId:'own-write',planId:idle.plan!.id,expectedRevision:idle.plan!.revision,instruction:'修改方案'}),/未完成的成品写入/);
    h.engine.store.put('flow_acceptances',write.id,{...write,status:'accepted'});
    assert.equal(enabled(await state()),true);
    await h.engine.invoke('projectFlow.plan.revise',{requestId:'second-revise',planId:idle.plan!.id,expectedRevision:idle.plan!.revision,instruction:'修改方案'});
    const until=Date.now()+20000;let revised=await state();while(revised.plan?.version!==2){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,25));revised=await state();}
    assert.equal(revised.plan!.status,'awaiting_confirmation');assert.equal(revised.tasks.length,0);assert.equal((await h.state()).tasks[0].status,'running');
  }finally{release();await h.dispose();}
});
