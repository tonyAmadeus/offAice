import { memberUserSummary, reportForDisplay } from '../src/shared/report-presentation';
import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { harness, plan, passing, proof } from './helpers/project-flow-harness';
import type { RoundResults, ResultPreview } from '../src/shared/round-results';
import type { FlowArtifact, Round, Integration, Evidence } from '../src/shared/project-flow';
import { presentRoundReport } from '../src/backend/round-report';
import { validateSubmission } from '../src/shared/project-flow-protocol';

test('results preserve submitted bytes after acceptance and later project edits; current access needs a write receipt', async () => {
  const h=await harness();
  try {
    await h.confirm();const s=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance'),round=s.rounds[0];
    const params={projectId:h.project.id,roundId:round.id};
    const read=()=>h.engine.invoke('projectFlow.round.results',params) as Promise<RoundResults>;
    const results=await read();assert.equal(results.availability,'ready');assert.equal(results.applied,false);assert.ok(results.files.some(f=>f.path==='a.txt'&&f.kind==='modified'));
    await assert.rejects(h.engine.invoke('projectFlow.round.preview',{...params,path:'a.txt',source:'current'}),/尚未确认写入/);
    await assert.rejects(h.engine.invoke('project.openPath',{...params,relativePath:'a.txt',mode:'open'}),/尚未确认写入/);
    await h.accept();await h.wait(s=>s.flow?.status==='completed');assert.equal((await read()).applied,true);
    await writeFile(path.join(h.source,'a.txt'),'later-round');
    const old=await h.engine.invoke('projectFlow.round.preview',{...params,path:'a.txt'}) as ResultPreview;
    const current=await h.engine.invoke('projectFlow.round.preview',{...params,path:'a.txt',source:'current'}) as ResultPreview;
    assert.equal(old.content,'new-a');assert.equal(current.content,'later-round');assert.equal(current.comparison,'changed');
    const opened=await h.engine.invoke('project.openPath',{...params,relativePath:'a.txt',mode:'open'}) as any;assert.equal(opened.mode,'open');assert.equal(opened.target,path.join(h.source,'a.txt'));
    await unlink(path.join(h.source,'a.txt'));await assert.rejects(h.engine.invoke('projectFlow.round.preview',{...params,path:'a.txt',source:'current'}));
    assert.equal((await h.engine.invoke('projectFlow.round.preview',{...params,path:'a.txt'}) as ResultPreview).content,'new-a');
    await assert.rejects(h.engine.invoke('projectFlow.round.results',{...params,projectId:'other'}),/不属于/);
    await assert.rejects(h.engine.invoke('projectFlow.round.preview',{...params,path:'../outside.txt'}));
    const artifact=h.engine.store.get<FlowArtifact>('flow_artifacts',results.version!.artifactId)!;
    await writeFile(path.join(artifact.root,'a.txt'),'tampered');
    assert.equal((await read()).availability,'changed');await assert.rejects(h.engine.invoke('projectFlow.round.preview',{...params,path:'a.txt'}),/变化/);
    h.engine.store.put('flow_artifacts',artifact.id,{...artifact,status:'removed'});assert.equal((await read()).availability,'missing');
  } finally {await h.dispose();}
});

test('lead acceptance without apply never claims the project has received files', async () => {
  const p=plan();p.rounds.push({...p.rounds[0],key:'r2',title:'第二轮'});p.rounds[0].requiresUserAcceptance=false;
  p.tasks[1].roundKey='r2';p.tasks[1].dependencies=['a'];const h=await harness({plan:p});
  try {await h.confirm();const s=await h.wait(s=>s.rounds[0]?.status==='accepted');const result=await h.engine.invoke('projectFlow.round.results',{projectId:h.project.id,roundId:s.rounds[0].id}) as RoundResults;assert.equal(result.applied,false);assert.equal(result.availability,'ready');assert.equal(await h.original(),'old-a');}
  finally{await h.dispose();}
});

test('images, HTML-as-code, deletions, unsupported binaries and userSummary are represented without executing files', async () => {
  const p=plan();p.tasks=p.tasks.slice(0,1);p.tasks[0].allowedPaths=['a.txt','b.txt','index.html','image.png','large.png','report.pdf'];
  const h=await harness({plan:p,handler:async c=>{if(c.kind!=='submission')return;
    await writeFile(path.join(c.ctx.cwd,'a.txt'),'new-a');await unlink(path.join(c.ctx.cwd,'b.txt'));
    await writeFile(path.join(c.ctx.cwd,'index.html'),'<script>window.__shouldNeverRun=true</script>');
    await writeFile(path.join(c.ctx.cwd,'image.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1cAAAAASUVORK5CYII=','base64'));
    await writeFile(path.join(c.ctx.cwd,'large.png'),Buffer.alloc(8*1024*1024+1));await writeFile(path.join(c.ctx.cwd,'report.pdf'),'%PDF-1.4 fake');
    return {summary:'任务完成',userSummary:'写好了网页与图片，待你查看。',completionResults:passing(c.material.task.completionCriteria).criteriaResults,evidence:proof};}});
  try{await h.confirm();const s=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');const params={projectId:h.project.id,roundId:s.rounds[0].id};
    assert.equal(s.submissions[0].userSummary,'写好了网页与图片，待你查看。');
    const result=await h.engine.invoke('projectFlow.round.results',params) as RoundResults;assert.equal(result.files.find(f=>f.path==='b.txt')?.kind,'deleted');
    const preview=(name:string,source='submitted')=>h.engine.invoke('projectFlow.round.preview',{...params,path:name,source}) as Promise<ResultPreview>;
    assert.equal((await preview('b.txt','previous')).content,'old-b');assert.equal((await preview('image.png')).kind,'image');assert.equal((await preview('large.png')).kind,'file');assert.equal((await preview('report.pdf')).kind,'file');
    assert.equal((await preview('index.html')).kind,'text');assert.match((await preview('index.html')).content!,/<script>/);
    await h.accept();await h.wait(s=>s.flow?.status==='completed');const opened=await h.engine.invoke('project.openPath',{...params,relativePath:'index.html',mode:'open'}) as any;assert.equal(opened.mode,'reveal');
  }finally{await h.dispose();}
});

test('open path validates mode, file ownership, links and traversal independently of UI', async () => {
  const h=await harness();try{
    await assert.rejects(h.engine.invoke('project.openPath',{projectId:h.project.id,relativePath:'../secret',mode:'open'}));
    await assert.rejects(h.engine.invoke('project.openPath',{projectId:h.project.id,relativePath:'a.txt',mode:'execute'}));
    await assert.rejects(h.engine.invoke('project.openPath',{projectId:h.project.id,relativePath:'.',mode:'open'}));
    const outside=path.join(h.root,'outside');await mkdir(outside);await writeFile(path.join(outside,'secret.txt'),'private');await symlink(outside,path.join(h.source,'linked'),'junction');
    await assert.rejects(h.engine.invoke('project.openPath',{projectId:h.project.id,relativePath:'linked/secret.txt',mode:'open'}),/之外/);
  }finally{await h.dispose();}
});

test('T17 separates system facts, avoids full commands, and replaces contradictory claims without another model call',()=>{
  const report={summary:'退出码为 0，全部通过',completedTaskKeys:['a'],deliverables:['a.txt'],validationSummary:'退出码为 0',remainingIssues:[],nextRoundSummary:'继续',userDecisionNeeded:'请查看'};
  const task={title:'网页',reviewSkipped:'configured'} as any,round={manualAcceptance:{reason:'待判断'}} as Round;
  const integration={reviewLevel:'low',deferredUserCriteria:['页面手感']} as Integration;
  const evidence:Evidence[]=[{kind:'command',description:'检查网页',command:'private-long-command',exitCode:0,executionStatus:'failed',exitCodeSource:'reported',source:'observed',eventIds:['e1'],result:'success'}];
  const result=presentRoundReport(report,round,integration,[task],evidence);
  assert.doesNotMatch(result.summary,/退出码为 0/);assert.doesNotMatch(result.validationSummary,/退出码为 0/);assert.deepEqual(result.remainingIssues,[]);
  assert.ok(result.systemNotes?.some(n=>n.kind==='evidence-conflict'));assert.ok(result.systemNotes?.some(n=>n.kind==='unverified'));assert.ok(result.systemNotes?.some(n=>n.kind==='user-check'));
  assert.doesNotMatch(JSON.stringify(result),/private-long-command/);assert.deepEqual(result.systemNotes?.find(n=>n.kind==='exit-code')?.eventIds,['e1']);
});

test('old submissions remain valid and optional summaries cannot require a new file task',()=>{
  const raw={summary:'旧摘要',completionResults:[{criterion:'标准',verified:true,evidence:'文件'}],evidence:proof};
  assert.equal(validateSubmission(raw).userSummary,undefined);assert.equal(validateSubmission({...raw,userSummary:42}).userSummary,undefined);
  assert.equal(validateSubmission({...raw,userSummary:'x'.repeat(2100)}).userSummary?.length,2000);
});


test('legacy report presentation extracts only known system notes without rewriting saved reports',()=>{
  const raw={summary:'本轮汇总',completedTaskKeys:['a'],deliverables:['a.txt'],validationSummary:'实际检查\n退出码未核实：检查网页（long private command）；成员填写 0，原生记录确认命令已完成，但未提供退出码。',remainingIssues:['本轮成果未经 AI 复核通过。','仍需调整字号'],nextRoundSummary:'',userDecisionNeeded:''};
  const presented=reportForDisplay(raw);assert.equal(presented.validationSummary,'实际检查');assert.deepEqual(presented.remainingIssues,['仍需调整字号']);assert.equal(presented.systemNotes?.length,2);assert.doesNotMatch(JSON.stringify(presented),/long private command/);assert.match(raw.validationSummary,/long private command/);
  assert.equal(memberUserSummary({summary:'旧成员记录'}),'旧成员记录');assert.equal(memberUserSummary({summary:'技术摘要',userSummary:'写好了页面'}),'写好了页面');
});
