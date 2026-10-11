import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/backend/store';
import {ProjectProgress} from '../src/backend/project-progress';
import {harness} from './helpers/project-flow-harness';
import {PROJECT_FLOW_READS} from '../src/shared/project-flow';
const at='2026-10-07T00:00:00.000Z';
async function data(){
  const root=await mkdtemp(path.join(os.tmpdir(),'airoom-progress-')),store=new Store(path.join(root,'data'));const source=path.join(root,'source');await mkdir(source);store.put('projects','p',{id:'p',name:'研究',directory:source,createdAt:at,collaborationPaused:false});store.put('projects','other',{id:'other',name:'其它',directory:source,createdAt:at,collaborationPaused:false});
  const record=(id:string,flowId:string,extra:object={})=>({id,projectId:'p',flowId,schemaVersion:1,revision:1,createdAt:at,updatedAt:at,...extra});
  const flow=(id:string,status:string='completed')=>{const f=record(id,id,{leadMemberId:'codex',memberIds:['codex','claude'],memberNames:{codex:'历史负责人'},activePlanId:id+'-final',roomId:'project:p',topic:'调研 '+id,status,dispatchMode:'running',blockedReasons:[]});store.put('project_flows',id,f);return f;};
  const plan=(flowId:string,version:number,status:string)=>{const id=flowId+(version===2?'-final':'-old'),p=record(id,flowId,{version,status,objective:'研究结论 '+flowId,scope:'资料和报告',deliverables:['报告.md'],acceptanceCriteria:[{text:'表达清楚',kind:'judge'}],rounds:[{key:'r',title:'资料',goal:'汇集资料',requiresUserAcceptance:true}],tasks:[],notes:[]});store.put('flow_plans',id,p);return p;};
  const round=(flowId:string,planId:string,id:string,status:string)=>{const r=record(id,flowId,{planId,key:id,title:'资料汇总',goal:'研究资料',index:0,taskIds:[],requiresUserAcceptance:true,integrationFixCount:0,status,report:{summary:'已完成文献整理',completedTaskKeys:[],deliverables:['报告.md'],validationSummary:'核对来源',remainingIssues:[],nextRoundSummary:'继续分析',userDecisionNeeded:'确认表达效果'}});store.put('flow_rounds',id,r);return r;};
  const task=(flowId:string,planId:string,roundId:string,id:string,status:string)=>{const t=record(id,flowId,{planId,roundId,key:id,title:'阅读资料',memberId:'claude',reviewerMemberId:'codex',goal:'整理来源',inputs:[],completionCriteria:['来源存在'],dependencies:[],allowedPaths:['报告.md'],kind:'implementation',returnCount:0,rearrangeCount:0,status,findingIds:[]});store.put('flow_tasks',id,t);return t;};
  return {root,store,record,flow,plan,round,task,reader:new ProjectProgress(store),dispose:async()=>{store.close();await rm(root,{recursive:true,force:true});}};
}
test('M4 whole-project counts distinguish adopted plans from every saved version including cancelled work',async()=>{
  const h=await data();try{
    h.flow('done');h.flow('cancelled','cancelled');h.flow('working','active');
    const old=h.plan('done',1,'superseded'),final=h.plan('done',2,'confirmed'),cancel=h.plan('cancelled',2,'confirmed'),current=h.plan('working',2,'confirmed');
    h.round('done',old.id,'round-old','accepted');h.round('done',final.id,'round-final','accepted');h.round('cancelled',cancel.id,'round-cancel','blocked');h.round('working',current.id,'round-working','executing');
    h.task('done',old.id,'round-old','task-old','accepted');h.task('done',final.id,'round-final','task-final','accepted');h.task('cancelled',cancel.id,'round-cancel','task-cancel','cancelled');h.task('working',current.id,'round-working','task-working','running');
    h.store.put('flow_integrations','i-old',h.record('i-old','done',{roundId:'round-old',sequence:1,status:'stale',version:{artifactId:'old',fingerprint:'a',baselineId:'a'}}));h.store.put('flow_integrations','i-final',h.record('i-final','done',{roundId:'round-final',sequence:2,status:'accepted',version:{artifactId:'final',fingerprint:'b',baselineId:'a'}}));
    h.store.put('flow_acceptances','accepted',h.record('accepted','done',{roundId:'round-final',integrationId:'i-final',status:'accepted',acceptedAt:at,opinion:'可以交付',actor:'user',appliedPaths:['报告.md'],conflictPaths:[]}));
    const page=h.reader.timeline({projectId:'p',limit:1},{flowId:'working',label:'正在执行资料整理'});
    assert.equal(page.total,3);assert.equal(page.items.length,1);assert.deepEqual(page.counts.flows,{total:3,active:1,completed:1,cancelled:1});assert.deepEqual(page.counts.latestPlans,{rounds:3,acceptedRounds:1,tasks:3,acceptedTasks:1,cancelledTasks:1});assert.equal(page.counts.allSaved.rounds,4);assert.equal(page.counts.allSaved.tasks,4);assert.equal(page.counts.allSaved.results,2);assert.match(page.countScope,/被替代方案/);
    const all=h.reader.timeline({projectId:'p',limit:100},{flowId:'working',label:'正在执行资料整理'});assert.equal(all.items.find(f=>f.id==='working')!.stage,'正在执行资料整理');assert.equal(all.items.find(f=>f.id==='done')!.lastAcceptedAt,at);assert.equal(all.items.find(f=>f.id==='done')!.planCount,2);
    const plans=h.reader.detail({projectId:'p',flowId:'done',section:'plans',limit:100});assert.equal(plans.items.length,2);assert.ok(plans.items.some((p:any)=>p.status==='superseded'));const results=h.reader.detail({projectId:'p',flowId:'done',section:'results',limit:100});assert.equal(results.items.length,2);assert.ok(results.items.some((r:any)=>r.version.artifactId==='old'));
  }finally{await h.dispose();}
});
test('M4 equal timestamps and inserted work do not duplicate or skip fixed pagination',async()=>{
  const h=await data();try{
    for(let i=0;i<205;i++)h.flow('flow-'+String(i).padStart(3,'0'));
    let page=h.reader.timeline({projectId:'p',limit:100});const ids=page.items.map(f=>f.id);assert.equal(page.total,205);h.flow('new-after-open','active');
    while(page.cursor){page=h.reader.timeline({projectId:'p',limit:100,cursor:page.cursor});ids.push(...page.items.map(f=>f.id));assert.equal(page.total,205);assert.equal(page.counts.flows.total,205);}
    assert.equal(ids.length,205);assert.equal(new Set(ids).size,205);assert.ok(!ids.includes('new-after-open'));assert.equal(h.reader.timeline({projectId:'p'}).total,206);
    const f=h.flow('many-versions');for(let i=1;i<=26;i++)h.store.put('flow_plans','pv-'+i,h.record('pv-'+i,f.id,{version:i,status:i===26?'confirmed':'superseded'}));
    let detail=h.reader.detail({projectId:'p',flowId:f.id,section:'plans',limit:10}),collected=detail.items.map(p=>p.id);
    while(detail.cursor){detail=h.reader.detail({projectId:'p',flowId:f.id,section:'plans',limit:10,cursor:detail.cursor});collected.push(...detail.items.map(p=>p.id));}assert.equal(collected.length,26);assert.equal(new Set(collected).size,26);
  }finally{await h.dispose();}
});
test('M4 awaiting plan revisions do not count draft tasks as accepted work or erase the last confirmed progress',async()=>{
  const h=await data();try{
    const flow=h.flow('revise','awaiting_plan'),old=h.plan(flow.id,1,'superseded');h.store.put('flow_plans',old.id,{...old,confirmedAt:at});const draft=h.plan(flow.id,2,'awaiting_confirmation');
    h.round(flow.id,old.id,'accepted-old-round','accepted');h.task(flow.id,old.id,'accepted-old-round','accepted-old-task','accepted');
    const page=h.reader.timeline({projectId:'p'});assert.equal(page.items[0].plan?.id,draft.id);assert.equal(page.items[0].adoptedPlanId,old.id);assert.equal(page.items[0].rounds.accepted,1);assert.equal(page.counts.latestPlans.acceptedTasks,1);assert.equal(page.counts.allSaved.plans,2);
  }finally{await h.dispose();}
});
test('M4 pagination cannot cross projects, flows or record categories and exposes honest scope',async()=>{
  const h=await data();try{
    h.flow('a');h.flow('b');h.plan('a',1,'superseded');h.plan('a',2,'confirmed');
    const page=h.reader.timeline({projectId:'p',limit:1}),detail=h.reader.detail({projectId:'p',flowId:'a',section:'plans',limit:1});
    assert.throws(()=>h.reader.timeline({projectId:'other',cursor:page.cursor}),/分页/);assert.throws(()=>h.reader.detail({projectId:'p',flowId:'b',section:'plans',cursor:detail.cursor}),/分页/);assert.throws(()=>h.reader.detail({projectId:'p',flowId:'a',section:'tasks',cursor:detail.cursor}),/分页/);assert.throws(()=>h.reader.detail({projectId:'other',flowId:'a',section:'plans'}),/不属于/);assert.throws(()=>h.reader.detail({projectId:'p',flowId:'a',section:'__proto__'}),/类别/);
    assert.equal(h.reader.timeline({projectId:'p',includeChildren:true}).total,2);assert.throws(()=>h.reader.timeline({projectId:'p',includeChildren:'yes'}),/必须明确/);assert.throws(()=>h.reader.timeline({projectId:'p',limit:0}),/数量/);assert.throws(()=>h.reader.timeline({projectId:'p',cursor:'bad'}),/分页/);assert.equal(h.reader.timeline({projectId:'other'}).total,0);
  }finally{await h.dispose();}
});
test('M4 APIs are read-only saved-fact projections after real workflow acceptance',async()=>{
  const h=await harness();try{
    await h.confirm();await h.wait(s=>s.rounds[0].status==='awaiting_acceptance');await h.accept();const s=await h.wait(s=>s.flow!.status==='completed'),before=h.calls.length;
    assert.ok(PROJECT_FLOW_READS.includes('projectFlow.timeline'));assert.ok(PROJECT_FLOW_READS.includes('projectFlow.progress.detail'));
    const page=await h.engine.invoke('projectFlow.timeline',{projectId:h.project.id}) as any;assert.equal(page.counts.flows.completed,1);assert.equal(page.items[0].rounds.accepted,1);
    for(const section of ['plans','rounds','tasks','results','acceptances']){const d=await h.engine.invoke('projectFlow.progress.detail',{projectId:h.project.id,flowId:s.flow!.id,section}) as any;assert.ok(d.items.length>0);}
    assert.equal(h.calls.length,before);assert.equal((await h.state()).flow!.status,'completed');
  }finally{await h.dispose();}
});
test('M4 history includes actual user rejections and their reasons alongside accepted versions',async()=>{
  const h=await harness();try{
    await h.confirm();let s=await h.wait(s=>s.rounds[0].status==='awaiting_acceptance');await h.engine.invoke('projectFlow.round.requestChanges',{requestId:'reject-history',roundId:s.rounds[0].id,integrationId:s.rounds[0].integrationId,expectedRevision:s.rounds[0].revision,opinion:'补足研究依据'});s=await h.wait(s=>s.rounds[0].status==='awaiting_acceptance');await h.accept();s=await h.wait(s=>s.flow!.status==='completed');
    const reader=new ProjectProgress(h.engine.store),items=reader.detail({projectId:h.project.id,flowId:s.flow!.id,section:'acceptances'}).items as any[];
    assert.ok(items.some(i=>i.recordedVia==='user-change'&&i.opinion==='补足研究依据'&&i.status==='changes_requested'));assert.ok(items.some(i=>i.status==='accepted'));assert.equal(reader.timeline({projectId:h.project.id}).counts.allSaved.acceptances,items.length);
  }finally{await h.dispose();}
});
