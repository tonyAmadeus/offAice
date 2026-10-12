import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {Engine} from './helpers/seeded-engine';
import type {FlowArtifacts} from '../src/backend/project-flow-artifacts';
import {FlowError,type PlanPayload,type ProjectFlowSnapshot} from '../src/shared/project-flow';
import {harness,plan,passing,failed,proof} from './helpers/project-flow-harness';

type Harness=Awaited<ReturnType<typeof harness>>;
const draft='第一轮原始 README';
const repaired='第一轮验收后的 README';
const read=async(root:string,file:string)=>readFile(path.join(root,file),'utf8').catch(error=>{
  if(error.code==='ENOENT')return undefined;throw error;
});
const submitted=(task:any)=>({summary:'完成 '+task.key,completionResults:passing(task.completionCriteria).criteriaResults,evidence:proof});

function twoRounds():PlanPayload{
  const p=plan();p.scope='README.md、data.txt、style.txt、display.txt';p.deliverables=['README 与页面文件'];
  p.tasks[0]={...p.tasks[0],title:'编写打开说明',goal:'创建 README',allowedPaths:['README.md']};
  p.tasks[1]={...p.tasks[1],allowedPaths:['data.txt'],dependencies:['a']};
  p.rounds.push({key:'r2',title:'第二轮',goal:'页面样式和展示',requiresUserAcceptance:true,completionCriteria:['页面文件正确']});
  p.tasks.push(
    {...p.tasks[0],key:'c',roundKey:'r2',title:'编写页面样式',goal:'写样式',dependencies:['a','b'],allowedPaths:['style.txt']},
    {...p.tasks[1],key:'d',roundKey:'r2',title:'编写成员展示',goal:'接入样式',dependencies:['c'],allowedPaths:['display.txt']},
  );
  return p;
}
function threeRounds(){
  const p=twoRounds();p.rounds[1].goal='成员数据';p.rounds[1].completionCriteria=['成员数据正确'];
  p.rounds.push({key:'r3',title:'第三轮',goal:'使用成员数据',requiresUserAcceptance:true,completionCriteria:['展示内容正确']});
  p.tasks=[p.tasks[0],{...p.tasks[1],roundKey:'r2'},{...p.tasks[2],roundKey:'r3',memberId:'dsh',dependencies:['b']}];
  return p;
}
async function run(p:PlanPayload,options:{deleteReadme?:boolean;automaticRepair?:boolean}={}){
  const inputs=new Map<string,{readme:string|undefined;data:string|undefined;style:string|undefined}[]>();
  let checks=0;
  const h=await harness({plan:p,handler:async c=>{
    if(c.kind==='integration-check'&&options.automaticRepair&&++checks===1)
      return {...failed(c.material.criteria),findings:[{location:'README.md',kind:'verified',severity:'blocking',evidence:'已查看原始 README',request:'修正 README 说明'}]};
    if(c.kind!=='submission')return;
    assert.equal(c.correction,false);
    const task=c.material.task;
    if(task.kind==='integration-fix'){
      if(options.deleteReadme)await unlink(path.join(c.ctx.cwd,'README.md'));
      else await writeFile(path.join(c.ctx.cwd,'README.md'),repaired);
    }else if(task.key==='a')await writeFile(path.join(c.ctx.cwd,'README.md'),draft);
    else{
      const seen={readme:await read(c.ctx.cwd,'README.md'),data:await read(c.ctx.cwd,'data.txt'),style:await read(c.ctx.cwd,'style.txt')};
      inputs.set(task.key,[...inputs.get(task.key)??[],seen]);
      const file=task.key==='b'?'data.txt':task.key==='c'?'style.txt':'display.txt';
      await writeFile(path.join(c.ctx.cwd,file),'fresh-'+task.key);
    }
    return submitted(task);
  }});
  return {h,inputs};
}
async function repairFirst(h:Harness){
  const first=await h.wait(s=>Boolean(s.rounds[0]?.allowedActions?.some(a=>a.name==='projectFlow.round.requestChanges'&&a.enabled)));
  const round=first.rounds[0];
  await h.engine.invoke('projectFlow.round.requestChanges',{
    requestId:crypto.randomUUID(),roundId:round.id,expectedRevision:round.revision,integrationId:round.integrationId,opinion:'修正 README',
  });
  return h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance'&&s.rounds[0].integrationId!==round.integrationId);
}
async function startNext(h:Harness,index:number){
  const ready=await h.wait(s=>s.decisions.some(d=>d.kind==='next-round'&&d.roundId===s.rounds[index]?.id&&d.status==='open'));
  const decision=ready.decisions.find(d=>d.kind==='next-round'&&d.roundId===ready.rounds[index].id&&d.status==='open')!;
  await h.answer(decision,'按原计划开始');
}
async function readyRound(h:Harness,index:number){
  const s=await h.wait(s=>s.rounds[index]?.status==='awaiting_acceptance'||s.tasks.some(t=>t.roundId===s.rounds[index]?.id&&t.status==='blocked'));
  assert.equal(s.rounds[index].status,'awaiting_acceptance',s.tasks.find(t=>t.status==='blocked')?.blockedReason??'round should reach acceptance');
  return s;
}
async function waitEngine(engine:Engine,projectId:string,predicate:(s:ProjectFlowSnapshot)=>boolean){
  const until=Date.now()+20000;
  for(;;){const s=await engine.invoke('projectFlow.get',{projectId}) as ProjectFlowSnapshot;if(predicate(s))return s;
    assert.ok(Date.now()<until,'restarted flow should reach the expected state');await new Promise(resolve=>setTimeout(resolve,25));
  }
}

test('T15 human repair survives the next round and its same-round dependency chain without rerunning accepted authors',async()=>{
  const {h,inputs}=await run(twoRounds());
  try{
    await h.confirm();const fixed=await repairFirst(h);
    assert.equal(await read(h.source,'README.md'),undefined,'member copies wait for human acceptance');
    const a=fixed.tasks.find(t=>t.key==='a')!,original=fixed.submissions.find(s=>s.id===a.latestSubmissionId)!;
    const artifact=h.engine.store.get<{root:string}>('flow_artifacts',original.version.artifactId)!;
    assert.equal(await read(artifact.root,'README.md'),draft,'the old submission remains immutable');
    await h.accept();await h.wait(s=>s.rounds[0]?.status==='accepted');assert.equal(await read(h.source,'README.md'),repaired);
    await startNext(h,1);const ready=await readyRound(h,1);
    assert.deepEqual(inputs.get('c'),[{readme:repaired,data:'fresh-b',style:undefined}]);
    assert.deepEqual(inputs.get('d'),[{readme:repaired,data:'fresh-b',style:'fresh-c'}]);
    assert.equal(ready.rounds[0].userChangeRequests!.length,1);
    for(const key of ['a','b','c','d'])assert.equal(h.calls.filter(c=>c.kind==='submission'&&c.material.task.key===key).length,1);
    assert.equal(h.calls.filter(c=>c.kind==='submission'&&c.material.task.kind==='integration-fix').length,1);
    await h.accept();await h.wait(s=>s.flow?.status==='completed');
    assert.equal(await read(h.source,'README.md'),repaired);assert.equal(await read(h.source,'display.txt'),'fresh-d');
    assert.equal(await read(artifact.root,'README.md'),draft);
  }finally{await h.dispose();}
});

test('T15 an accepted deletion is not silently restored from the original preceding-round submission',async()=>{
  const {h,inputs}=await run(twoRounds(),{deleteReadme:true});
  try{
    await h.confirm();await repairFirst(h);await h.accept();await startNext(h,1);await readyRound(h,1);
    assert.equal(inputs.get('c')?.length,1);assert.equal(inputs.get('c')![0].readme,undefined);
    assert.equal(inputs.get('d')![0].readme,undefined);
    await h.accept();await h.wait(s=>s.flow?.status==='completed');assert.equal(await read(h.source,'README.md'),undefined);
  }finally{await h.dispose();}
});

test('T15 automatic integration repair and leader acceptance also become the next round baseline',async()=>{
  const p=twoRounds();p.rounds[0].requiresUserAcceptance=false;
  const {h,inputs}=await run(p,{automaticRepair:true});
  try{
    await h.confirm({requiresUserAcceptanceByRound:{r1:false}});const s=await readyRound(h,1);
    assert.equal(s.rounds[0].status,'accepted');assert.equal(s.rounds[0].integrationFixCount,1);
    assert.equal(s.acceptances.find(a=>a.roundId===s.rounds[0].id)?.actor,'lead');
    assert.equal(s.decisions.some(d=>d.kind==='next-round'),false);
    assert.deepEqual(inputs.get('c'),[{readme:repaired,data:'fresh-b',style:undefined}]);
    assert.equal(await read(h.source,'README.md'),undefined,'leader acceptance does not write the original project');
    await h.accept();await h.wait(s=>s.flow?.status==='completed');assert.equal(await read(h.source,'README.md'),repaired);
  }finally{await h.dispose();}
});

for(const early of [false,true])test('T15 third-round transitive inputs keep earlier accepted repairs'+(early?' during early work':''),async()=>{
  const {h,inputs}=await run(threeRounds());
  try{
    await h.confirm();await repairFirst(h);await h.accept();await startNext(h,1);await readyRound(h,1);
    if(early){
      const s=await h.wait(s=>s.decisions.some(d=>d.kind==='early-start'&&d.roundId===s.rounds[1]?.id&&d.status==='open'));
      const decision=s.decisions.find(d=>d.kind==='early-start'&&d.roundId===s.rounds[1].id&&d.status==='open')!;
      await h.answer(decision,'允许提前开工',{selectedTaskIds:decision.eligibleTaskIds});
      const preview=await h.wait(s=>['review_passed','blocked'].includes(s.tasks.find(t=>t.key==='c')?.status??''));
      const task=preview.tasks.find(t=>t.key==='c')!;
      assert.equal(task.status,'review_passed',task.blockedReason??'early task should pass review');assert.equal(task.earlyDecisionId,decision.id);
      assert.equal(preview.rounds[1].status,'awaiting_acceptance','the source round is still unaccepted');
    }
    await h.accept();await startNext(h,2);await readyRound(h,2);
    assert.deepEqual(inputs.get('b'),[{readme:repaired,data:undefined,style:undefined}]);
    assert.deepEqual(inputs.get('c'),[{readme:repaired,data:'fresh-b',style:undefined}]);
    assert.equal(h.calls.filter(c=>c.kind==='submission'&&c.material.task.key==='c').length,1);
  }finally{await h.dispose();}
});

test('T15 a stored dependency-preparation conflict resumes after restart without repeating the accepted round',async()=>{
  const {h,inputs}=await run(twoRounds());let restarted:Engine|undefined;
  try{
    await h.confirm();const fixed=await repairFirst(h);await h.accept();
    const task=fixed.tasks.find(t=>t.key==='a')!,submission=fixed.submissions.find(s=>s.id===task.latestSubmissionId)!;
    const artifacts:FlowArtifacts=(h.engine as any).projectFlow.artifacts,old=artifacts.get(submission.version.artifactId),capture=artifacts.capture.bind(artifacts);
    let reproduceOldMerge=true;
    // Recreate the original pre-dispatch failure with a real artifact merge, then save that state for restart.
    artifacts.capture=async(...args:Parameters<FlowArtifacts['capture']>)=>{
      const copy=await capture(...args);
      if(reproduceOldMerge&&args[2]==='task-base'){
        reproduceOldMerge=false;
        const conflicts=await artifacts.merge(copy.root,old);
        assert.deepEqual(conflicts.map(c=>c.path),['README.md']);
        throw new FlowError('SCOPE_CONFLICT','任务依赖成果合入发生冲突：编写打开说明（README.md）。');
      }
      return copy;
    };
    await startNext(h,1);const blocked=await h.wait(s=>s.tasks.find(t=>t.key==='c')?.status==='blocked');
    assert.match(blocked.tasks.find(t=>t.key==='c')!.blockedReason!,/README.md/);
    assert.equal(h.calls.some(c=>c.kind==='submission'&&c.material.task.key==='c'),false);
    await h.engine.close();
    restarted=new Engine(path.join(h.root,'data'),()=>{},()=>{},h.adapterFactory);await restarted.probe();
    (restarted as any).projectFlow.host.quotaAllows=()=>true;
    const restored=await restarted.invoke('projectFlow.get',{projectId:h.project.id}) as ProjectFlowSnapshot;
    assert.ok(restored.allowedActions.some(a=>a.name==='projectFlow.resume'&&a.enabled));
    await restarted.invoke('projectFlow.resume',{requestId:'resume-t15',flowId:restored.flow!.id,expectedRevision:restored.flow!.revision});
    const ready=await waitEngine(restarted,h.project.id,s=>s.rounds[1]?.status==='awaiting_acceptance'||s.tasks.find(t=>t.key==='c')?.status==='blocked');
    assert.equal(ready.rounds[1].status,'awaiting_acceptance',ready.tasks.find(t=>t.key==='c')?.blockedReason??'resumed round should reach acceptance');
    assert.deepEqual(inputs.get('c'),[{readme:repaired,data:'fresh-b',style:undefined}]);
    assert.deepEqual(inputs.get('d'),[{readme:repaired,data:'fresh-b',style:'fresh-c'}]);
    for(const key of ['a','b','c','d'])assert.equal(h.calls.filter(c=>c.kind==='submission'&&c.material.task.key===key).length,1);
    assert.equal(ready.flow!.blockedReasons.length,0);assert.equal(await read(h.source,'README.md'),repaired);
  }finally{await restarted?.close();await h.dispose();}
});

