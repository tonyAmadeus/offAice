import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,unlink,link} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/backend/store';
import {ProjectTree} from '../src/backend/project-tree';
import {captureProjectBoundary,assertProjectBoundary,assertProjectAdmission,assertProjectPaths,withProjectWrite,projectClaims} from '../src/backend/project-access';
import {FlowArtifacts} from '../src/backend/project-flow-artifacts';
import {FlowApply} from '../src/backend/project-flow-apply';
import {ProjectProgress} from '../src/backend/project-progress';
import {prepareWorkspace,applyWorkspace,workspaceFingerprint} from '../src/backend/workspace';
import type {Project,WriteBoundary} from '../src/shared/types';
import {harness,plan} from './helpers/project-flow-harness';
const delay=(ms=10)=>new Promise(r=>setTimeout(r,ms));
async function until(test:()=>boolean|Promise<boolean>){const end=Date.now()+20000;while(!await test()){if(Date.now()>end)throw Error('parallel test timed out');await delay();}}
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'airoom-parallel-')),source=path.join(root,'source'),data=path.join(root,'data');await mkdir(source);for(const f of ['a.txt','b.txt','extra.txt'])await writeFile(path.join(source,f),'old-'+f);
  const store=new Store(data);let closed=false;const close=()=>{if(!closed){store.close();closed=true;}};const tree=new ProjectTree(store),a=tree.create(source,{name:'A',writeScopes:['a.txt']}),b=tree.create(source,{name:'B',parentId:a.id,writeScopes:['b.txt']});
  const flow=(p:Project,boundary:WriteBoundary|undefined=captureProjectBoundary(store,p.id))=>{const f={id:'flow-'+p.id,projectId:p.id,flowId:'flow-'+p.id,createdAt:'2026-10-07T00:00:00Z',updatedAt:'2026-10-07T00:00:00Z',leadMemberId:'codex',memberIds:['codex','claude'],status:'active',dispatchMode:'paused',writeBoundary:boundary,topic:p.name};store.put('project_flows',f.id,f);return f;};
  return {root,source,data,store,tree,a,b,flow,close,dispose:async()=>{close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}};
}
test('M6 disjoint physical declarations admit parent, child and sibling workflows but overlapping and legacy scopes remain blocked',async()=>{
  const h=await fixture();try{
    h.flow(h.a);assert.doesNotThrow(()=>assertProjectAdmission(h.store,h.b.id));h.flow(h.b);
    const same=h.tree.create(h.source,{writeScopes:['a.txt']});assert.throws(()=>assertProjectAdmission(h.store,same.id),/重叠/);const full=h.tree.create(h.source,{});assert.throws(()=>assertProjectAdmission(h.store,full.id),/重叠/);
    await mkdir(path.join(h.source,'module'));const directory=h.tree.create(h.source,{writeScopes:['module']}),nested=h.tree.create(path.join(h.source,'module'),{writeScopes:['future.txt']});h.flow(directory);assert.throws(()=>assertProjectAdmission(h.store,nested.id),/重叠/);
    h.store.delete('project_flows','flow-'+directory.id);h.store.put('project_flows','legacy',{id:'legacy',projectId:directory.id,status:'active'});assert.throws(()=>assertProjectAdmission(h.store,nested.id),/重叠/);
  }finally{await h.dispose();}
});
test('M6 actual aliases and Windows case cannot bypass a paused workflow range',async()=>{
  const h=await fixture();try{
    const alias=path.join(h.root,'alias');await symlink(h.source,alias,process.platform==='win32'?'junction':'dir');h.flow(h.a);
    const same=h.tree.create(alias,{writeScopes:[process.platform==='win32'?'A.TXT':'a.txt']}),other=h.tree.create(alias,{writeScopes:['b.txt']});assert.throws(()=>assertProjectAdmission(h.store,same.id),/重叠/);assert.doesNotThrow(()=>assertProjectAdmission(h.store,other.id));
    assert.equal(captureProjectBoundary(h.store,same.id).directoryKey,captureProjectBoundary(h.store,h.a.id).directoryKey);assertProjectPaths(h.store,other.id,['b.txt']);assert.throws(()=>assertProjectPaths(h.store,other.id,['a.txt']),/超出/);
  }finally{await h.dispose();}
});
test('M6 a retargeted directory freezes dispatch and apply while reserving both old and current paths',async()=>{
  const h=await fixture();try{
    const other=path.join(h.root,'other'),alias=path.join(h.root,'alias');await mkdir(other);await writeFile(path.join(other,'a.txt'),'other');await symlink(h.source,alias,process.platform==='win32'?'junction':'dir');const p=h.tree.create(alias,{writeScopes:['a.txt']}),f=h.flow(p),artifacts=new FlowArtifacts(h.store),base=await artifacts.capture({id:f.id,projectId:p.id},h.source,'base'),result=await artifacts.capture({id:f.id,projectId:p.id},base.root,'integration',base.id);await writeFile(path.join(result.root,'a.txt'),'new');result.fingerprint=await workspaceFingerprint(result.root);h.store.put('flow_artifacts',result.id,result);
    await unlink(alias);await symlink(other,alias,process.platform==='win32'?'junction':'dir');assert.throws(()=>assertProjectBoundary(h.store,p.id,f.writeBoundary),/实际文件夹或修改范围/);assert.throws(()=>assertProjectAdmission(h.store,h.a.id),/重叠/);const now=h.tree.create(other,{writeScopes:['a.txt']});assert.throws(()=>assertProjectAdmission(h.store,now.id),/重叠/);
    await assert.rejects(new FlowApply(h.store,artifacts).apply('retarget',result,alias),/实际文件夹或修改范围/);assert.equal(await readFile(path.join(h.source,'a.txt'),'utf8'),'old-a.txt');assert.equal(await readFile(path.join(other,'a.txt'),'utf8'),'other');assert.equal(h.store.list('flow_apply_journals').length,0);assert.equal(new ProjectProgress(h.store).timeline({projectId:p.id}).total,1);
  }finally{await h.dispose();}
});
test('M6 a queued write rechecks its frozen target after waiting and cannot write through a moved alias',async()=>{
  const h=await fixture();let release!:()=>void;try{
    const other=path.join(h.root,'other'),alias=path.join(h.root,'alias');await mkdir(other);await symlink(h.source,alias,process.platform==='win32'?'junction':'dir');const p=h.tree.create(alias,{writeScopes:['a.txt']}),gate=new Promise<void>(r=>{release=r;});let firstEntered=false,secondEntered=false;
    const first=withProjectWrite(h.store,p.id,alias,async()=>{firstEntered=true;await gate;}),second=withProjectWrite(h.store,p.id,alias,async check=>{secondEntered=true;check();await writeFile(path.join(alias,'a.txt'),'wrong');});await until(()=>firstEntered);await unlink(alias);await symlink(other,alias,process.platform==='win32'?'junction':'dir');release();await first;await assert.rejects(second,/实际文件夹或修改范围|实际路径/);assert.equal(secondEntered,false);await assert.rejects(readFile(path.join(other,'a.txt')));assert.equal(projectClaims(h.store).length,0);
  }finally{release?.();await h.dispose();}
});
test('M6 actual directory write queues preserve ordering across owners and release on failure',async()=>{
  const h=await fixture();let release!:()=>void;try{
    const order:string[]=[],gate=new Promise<void>(r=>{release=r;});const first=withProjectWrite(h.store,h.a.id,h.source,async check=>{order.push('A');await gate;check();throw Error('first failed');}),second=withProjectWrite(h.store,h.b.id,h.source,async check=>{check();order.push('B');await writeFile(path.join(h.source,'b.txt'),'new-b');});await until(()=>order.length===1);assert.doesNotThrow(()=>assertProjectAdmission(h.store,h.tree.create(h.source,{writeScopes:['future.md']}).id));await delay();assert.deepEqual(order,['A']);release();await assert.rejects(first,/first failed/);await second;assert.deepEqual(order,['A','B']);assert.equal(await readFile(path.join(h.source,'b.txt'),'utf8'),'new-b');assert.equal(projectClaims(h.store).length,0);
  }finally{release?.();await h.dispose();}
});
test('M6 original snapshots wait for the directory writer and retain a coherent cross-file version',async()=>{
  const h=await fixture();let release!:()=>void;try{
    h.store.put('projects',h.a.id,{...h.a,writeScopes:['a.txt','extra.txt']});const gate=new Promise<void>(r=>{release=r;});let entered=false,ready=false;
    const writer=withProjectWrite(h.store,h.a.id,h.source,async check=>{await writeFile(path.join(h.source,'a.txt'),'new-a');entered=true;await gate;check();await writeFile(path.join(h.source,'extra.txt'),'new-extra');});await until(()=>entered);const artifacts=new FlowArtifacts(h.store),snapshot=artifacts.capture({id:'reader',projectId:h.b.id},h.source,'base').then(a=>{ready=true;return a;});await delay(25);assert.equal(ready,false);release();await writer;const a=await snapshot;assert.equal(await readFile(path.join(a.root,'a.txt'),'utf8'),'new-a');assert.equal(await readFile(path.join(a.root,'extra.txt'),'utf8'),'new-extra');assert.equal(await readFile(path.join(a.root,'b.txt'),'utf8'),'old-b.txt');
  }finally{release?.();await h.dispose();}
});
test('M6 overlapping apply requests queue, then the second baseline conflicts without overwriting the first',async()=>{
  const h=await fixture();try{
    const p=h.tree.create(h.source,{writeScopes:['a.txt']}),artifacts=new FlowArtifacts(h.store),base=await artifacts.capture({id:'f',projectId:h.a.id},h.source,'base'),base2=await artifacts.capture({id:'g',projectId:p.id},h.source,'base'),a=await artifacts.capture({id:'f',projectId:h.a.id},base.root,'integration',base.id),b=await artifacts.capture({id:'g',projectId:p.id},base2.root,'integration',base2.id);
    for(const [item,text] of [[a,'first'],[b,'second']] as const){await writeFile(path.join(item.root,'a.txt'),text);item.fingerprint=await workspaceFingerprint(item.root);h.store.put('flow_artifacts',item.id,item);}
    const apply=new FlowApply(h.store,artifacts),[one,two]=await Promise.all([apply.apply('first',a,h.source),apply.apply('second',b,h.source)]);assert.equal(one.state,'applied');assert.equal(two.state,'conflict');assert.equal(await readFile(path.join(h.source,'a.txt'),'utf8'),'first');assert.equal(two.conflicts[0].path,'a.txt');
  }finally{await h.dispose();}
});
test('M6 recovery journals preserve scoped reservations after restart and refuse external changes',async()=>{
  const h=await fixture();let restarted:Store|undefined;try{
    h.store.put('projects',h.a.id,{...h.a,writeScopes:['a.txt','extra.txt']});const f=h.flow({...h.a,writeScopes:['a.txt','extra.txt']}),artifacts=new FlowArtifacts(h.store),base=await artifacts.capture({id:f.id,projectId:h.a.id},h.source,'base'),result=await artifacts.capture({id:f.id,projectId:h.a.id},base.root,'integration',base.id);
    for(const file of ['a.txt','extra.txt'])await writeFile(path.join(result.root,file),'new-'+file);result.fingerprint=await workspaceFingerprint(result.root);h.store.put('flow_artifacts',result.id,result);const temporary=path.join(h.source,'extra.txt.airoom-flow-recovery');await mkdir(temporary);const j=await new FlowApply(h.store,artifacts).apply('recovery',result,h.source);assert.equal(j.state,'recovery_required');assert.ok(j.writeBoundary);h.store.put('project_flows',f.id,{...f,status:'cancelled'});h.close();restarted=new Store(h.data);
    assert.doesNotThrow(()=>assertProjectAdmission(restarted!,h.b.id));const same=new ProjectTree(restarted).create(h.source,{writeScopes:['extra.txt']});assert.throws(()=>assertProjectAdmission(restarted!,same.id),/待核对/);await writeFile(path.join(h.source,'a.txt'),'external');await rm(temporary,{recursive:true});const recovered=await new FlowApply(restarted,new FlowArtifacts(restarted)).recover(j.id,'continue');assert.equal(recovered.state,'recovery_required');assert.equal(await readFile(path.join(h.source,'a.txt'),'utf8'),'external');assert.equal(await readFile(path.join(h.source,'extra.txt'),'utf8'),'old-extra.txt');
  }finally{restarted?.close();await h.dispose();}
});
test('M6 unknown native runs keep their saved range after restart until their actual operation is reconciled',async()=>{
  const h=await fixture();let restarted:Store|undefined;try{
    h.store.put('sessions','native',{id:'native',projectId:h.a.id,writeMode:true,revision:1});
    h.store.put('flow_operations','unknown-op',{id:'unknown-op',state:'unknown'});
    h.store.put('runs','unknown-run',{id:'unknown-run',projectId:h.a.id,sessionId:'native',revision:1,status:'unknown',delivery:'unknown',flowOperationId:'unknown-op',writeBoundary:captureProjectBoundary(h.store,h.a.id)});
    h.close();restarted=new Store(h.data);const overlapping=new ProjectTree(restarted).create(h.source,{writeScopes:['a.txt']});
    assert.doesNotThrow(()=>assertProjectAdmission(restarted!,h.b.id));assert.throws(()=>assertProjectAdmission(restarted!,overlapping.id),/待核对/);
    assert.equal(restarted.get<any>('runs','unknown-run').status,'unknown');assert.equal(restarted.get<any>('flow_operations','unknown-op').state,'unknown');
    restarted.put('flow_operations','unknown-op',{id:'unknown-op',state:'done',result:{abandoned:true,evidence:'人工核对后放弃'}});assert.doesNotThrow(()=>assertProjectAdmission(restarted!,overlapping.id));assert.equal(restarted.list('runs').length,1);
  }finally{restarted?.close();await h.dispose();}
});
test('M6 replacing a copy file does not mutate another original filename linked to the same bytes',async()=>{
  const h=await fixture();try{
    await unlink(path.join(h.source,'b.txt'));await link(path.join(h.source,'a.txt'),path.join(h.source,'b.txt'));const session={id:'copy',projectId:h.a.id,provider:'codex' as const,title:'copy',createdAt:'at',updatedAt:'at',revision:1,writeMode:true},copy=await prepareWorkspace(h.a,session,true,h.store.dataDirectory);await writeFile(path.join(copy.directory,'a.txt'),'new-a');
    await withProjectWrite(h.store,h.a.id,h.source,check=>applyWorkspace(copy.directory,h.source,paths=>{check();assertProjectPaths(h.store,h.a.id,paths);}));assert.equal(await readFile(path.join(h.source,'a.txt'),'utf8'),'new-a');assert.equal(await readFile(path.join(h.source,'b.txt'),'utf8'),'old-a.txt');
  }finally{await h.dispose();}
});
test('M6 two real engine workflows share a directory with independent authors, versions and successful cumulative acceptance',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;}),active=new Set<string>();let peak=0;
  const h=await harness({handler:async c=>{
    if(c.kind==='plan'&&c.material.projectWriteScopes?.[0]!=='.'){const file=c.material.projectWriteScopes[0],p=plan(),task={...p.tasks[0],key:file[0],allowedPaths:[file]};return {...p,objective:c.material.topic,scope:file,deliverables:[file],tasks:[task]};}
    if(c.kind==='submission'){active.add(c.ctx.run.projectId);peak=Math.max(peak,active.size);await gate;active.delete(c.ctx.run.projectId);}
  }});try{
    const root=await h.state();await h.engine.invoke('projectFlow.cancel',{requestId:'cancel-root',flowId:root.flow!.id,expectedRevision:root.flow!.revision});
    const a=await h.engine.invoke('project.create',{name:'A',directory:h.source,parentId:h.project.id,writeScopes:['a.txt']}) as Project,b=await h.engine.invoke('project.create',{name:'B',directory:h.source,parentId:h.project.id,writeScopes:['b.txt']}) as Project;
    const state=(p:Project)=>h.engine.invoke('projectFlow.get',{projectId:p.id}) as Promise<any>;
    await Promise.all([a,b].map(p=>h.engine.invoke('projectFlow.start',{requestId:'start-'+p.id,projectId:p.id,topic:p.name,leadMemberId:'codex',memberIds:['codex','claude','dsh']})));await until(async()=>Boolean((await state(a)).plan&&(await state(b)).plan));
    await Promise.all([a,b].map(async p=>{const s=await state(p);await h.engine.invoke('projectFlow.plan.confirm',{requestId:'confirm-'+p.id,planId:s.plan.id,expectedRevision:s.plan.revision});}));await until(()=>active.size===2);assert.equal(peak,2);release();
    await until(async()=>[await state(a),await state(b)].every(s=>s.rounds[0]?.allowedActions?.some((x:any)=>x.name==='projectFlow.round.accept'&&x.enabled)));
    await Promise.all([a,b].map(async p=>{const s=await state(p),r=s.rounds[0],i=s.integrations.find((i:any)=>i.id===r.integrationId);await h.engine.invoke('projectFlow.round.accept',{requestId:'accept-'+p.id,roundId:r.id,integrationId:i.id,expectedRevision:r.revision,fingerprint:i.version.fingerprint,opinion:'通过'});}));await until(async()=>[await state(a),await state(b)].every(s=>s.flow.status==='completed'));
    assert.equal(await readFile(path.join(h.source,'a.txt'),'utf8'),'new-a');assert.equal(await readFile(path.join(h.source,'b.txt'),'utf8'),'new-b');const journals=h.engine.store.list<any>('flow_apply_journals');assert.equal(journals.length,2);assert.ok(journals.every(j=>j.state==='applied'&&j.writeBoundary));const timeline=new ProjectProgress(h.engine.store).timeline({projectId:h.project.id,includeChildren:true});assert.equal(timeline.counts.flows.completed,2);assert.equal(timeline.counts.allSaved.results,2);assert.notEqual((await state(a)).integrations[0].version.artifactId,(await state(b)).integrations[0].version.artifactId);
  }finally{release();await h.dispose();}
});
