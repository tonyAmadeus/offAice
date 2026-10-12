import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Engine} from './helpers/seeded-engine';
import {Store} from '../src/backend/store';
import {ProjectTree} from '../src/backend/project-tree';
import {projectRows,descendantIds} from '../src/shared/project-tree';
import {assertProjectPaths,assertProjectSerial,assertProjectIdle,withProjectWrite,directoriesOverlap,markProjectRemoving} from '../src/backend/project-access';
import {ProjectProgress} from '../src/backend/project-progress';
import {FlowArtifacts} from '../src/backend/project-flow-artifacts';
import {FlowApply} from '../src/backend/project-flow-apply';
import {workspaceFingerprint,prepareWorkspace} from '../src/backend/workspace';
import type {Project} from '../src/shared/types';
import {harness} from './helpers/project-flow-harness';

async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'airoom-project-tree-')),source=path.join(root,'source');await mkdir(source);await writeFile(path.join(source,'a.txt'),'old-a');await writeFile(path.join(source,'b.txt'),'old-b');
  const engine=new Engine(path.join(root,'data'),()=>{},()=>{}),store=engine.store,tree=new ProjectTree(store),p=tree.create(source,{name:'研究'});
  return {root,source,engine,store,tree,p,dispose:async()=>{await engine.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}};
}
test('M5 legacy flat rows, nested order and collapsed branches preserve every public project',()=>{
  const make=(id:string,extra:Partial<Project>={})=>({id,name:id,directory:'C:/work',createdAt:id,collaborationPaused:false,...extra});
  const projects=[make('old'),make('root',{order:1}),make('child',{parentId:'root'}),make('grandchild',{parentId:'child'}),make('second',{parentId:'root',order:1}),make('orphan',{parentId:'missing'}),make('private',{kind:'lounge'})];
  assert.deepEqual(projectRows(projects).map(r=>r.project.id),['old','orphan','root','child','grandchild','second']);assert.equal(projectRows(projects).find(r=>r.project.id==='grandchild')!.depth,2);
  assert.deepEqual(projectRows(projects,new Set(['root'])).map(r=>r.project.id),['old','orphan','root']);assert.deepEqual(descendantIds(projects,'root'),['root','child','grandchild','second']);
  const damaged=[make('cycle-a',{parentId:'cycle-b'}),make('cycle-b',{parentId:'cycle-a'})];assert.equal(projectRows(damaged).length,2);
});
test('M5 child creation is independent of physical folders and starts with its own empty project room',async()=>{
  const h=await fixture();try{
    h.store.put('projects',h.p.id,{...h.p,memberIds:['codex','claude'],memberConfigs:{codex:{model:'chosen'}}});
    const child=await h.engine.invoke('project.create',{name:'调研',directory:h.source,parentId:h.p.id,writeScopes:['a.txt'],requestId:'child'}) as Project;
    const grand=await h.engine.invoke('project.create',{name:'资料',directory:h.source,parentId:child.id,writeScopes:['b.txt']}) as Project;
    assert.equal(grand.parentId,child.id);assert.equal(child.directory,h.p.directory);assert.equal(child.memberIds,undefined);assert.equal(child.memberConfigs,undefined);assert.equal(h.store.currentRoomThread(`project:${child.id}`).roomId,`project:${child.id}`);assert.notEqual(h.store.currentRoomThread(`project:${child.id}`).id,h.store.currentRoomThread(`project:${h.p.id}`).id);
    assert.deepEqual(child.writeScopes,['a.txt']);assert.equal(h.store.list('sessions').length,0);assert.equal(h.store.list('project_flows').length,0);
    const retry=await h.engine.invoke('project.create',{requestId:'child',writeScopes:['a.txt'],parentId:h.p.id,directory:h.source,name:'调研'}) as Project;assert.equal(retry.id,child.id);
    await assert.rejects(h.engine.invoke('project.create',{name:'别的',directory:h.source,parentId:h.p.id,requestId:'child'}),/操作编号/);
  }finally{await h.dispose();}
});
test('M5 moves reject cycles and stale edits while preserving files and using explicit hierarchy revisions',async()=>{
  const h=await fixture();try{
    const c=h.tree.create(h.source,{name:'子',parentId:h.p.id}),g=h.tree.create(h.source,{name:'孙',parentId:c.id});
    assert.throws(()=>h.tree.move({projectId:h.p.id,parentId:g.id,expectedRevision:1}),/自己或自己的子项目/);assert.throws(()=>h.tree.move({projectId:c.id,parentId:c.id,expectedRevision:1}),/自己/);
    const moved=h.tree.move({projectId:c.id,parentId:null,order:4,writeScopes:['a.txt'],expectedRevision:1,requestId:'move'});assert.equal(moved.parentId,undefined);assert.equal(moved.hierarchyRevision,2);assert.equal(moved.directory,c.directory);assert.equal((h.store.get<Project>('projects',g.id))!.parentId,c.id);
    assert.equal(h.tree.move({requestId:'move',expectedRevision:1,writeScopes:['a.txt'],order:4,parentId:null,projectId:c.id}).hierarchyRevision,2);assert.throws(()=>h.tree.move({projectId:c.id,parentId:h.p.id,expectedRevision:1}),/刷新/);
    assert.throws(()=>h.tree.move({projectId:c.id,directory:'other',expectedRevision:2}),/不支持/);assert.equal(await readFile(path.join(h.source,'a.txt'),'utf8'),'old-a');
    const scopeOnly=h.tree.move({projectId:g.id,writeScopes:['b.txt'],expectedRevision:1});assert.equal(scopeOnly.parentId,c.id);
  }finally{await h.dispose();}
});
test('M5 a failed room initialization rolls back the project and its creation receipt',async()=>{
  const h=await fixture();try{
    const count=h.store.list('projects').length,original=h.store.ensureProjectRoom.bind(h.store);h.store.ensureProjectRoom=()=>{throw Error('room unavailable');};
    assert.throws(()=>h.tree.create(h.source,{name:'retry',requestId:'atomic-create'}),/room unavailable/);assert.equal(h.store.list('projects').length,count);assert.equal(h.store.get('project_tree_requests','atomic-create'),undefined);
    h.store.ensureProjectRoom=original;const p=h.tree.create(h.source,{name:'retry',requestId:'atomic-create'});assert.equal(h.store.list('projects').length,count+1);assert.ok(h.store.currentRoomThread(`project:${p.id}`));
  }finally{await h.dispose();}
});
test('M5 removing a parent requires moving its children first and never removes project files',async()=>{
  const h=await fixture();try{
    const c=h.tree.create(h.source,{parentId:h.p.id});await assert.rejects(h.engine.invoke('project.remove',{projectId:h.p.id}),/子项目/);assert.ok(h.store.get('projects',h.p.id));
    h.tree.move({projectId:c.id,parentId:null,expectedRevision:1});await h.engine.invoke('project.remove',{projectId:h.p.id});assert.equal(h.store.get('projects',h.p.id),undefined);assert.ok(h.store.get('projects',c.id));assert.equal(await readFile(path.join(h.source,'b.txt'),'utf8'),'old-b');
  }finally{await h.dispose();}
});
test('M5 in-flight removal cannot orphan a newly created or moved child or admit another writer',async()=>{
  const h=await fixture();let release!:()=>void;try{
    h.engine.createSession(h.p.id,'codex','idle',false);const runtimes=(h.engine as any).roomRuntimes,original=runtimes.closeSession.bind(runtimes),gate=new Promise<void>(r=>{release=r;});runtimes.closeSession=async()=>gate;
    const remove=h.engine.invoke('project.remove',{projectId:h.p.id});await new Promise(r=>setTimeout(r,20));
    await assert.rejects(h.engine.invoke('project.create',{name:'late',directory:h.source,parentId:h.p.id}),/正在移除/);assert.throws(()=>assertProjectSerial(h.store,h.p.id),/正在移除/);
    const other=h.tree.create(h.source,{name:'other'});assert.throws(()=>assertProjectSerial(h.store,other.id),/正在移除/);release();await remove;runtimes.closeSession=original;assert.equal(h.store.list<Project>('projects').filter(p=>p.parentId===h.p.id).length,0);
  }finally{release?.();await h.dispose();}
});
test('M5 scope checks resolve directory aliases and future paths without permitting sibling or external escape',async()=>{
  const h=await fixture();try{
    await mkdir(path.join(h.source,'docs'));await mkdir(path.join(h.root,'external'));await symlink(path.join(h.source,'docs'),path.join(h.source,'alias'),process.platform==='win32'?'junction':'dir');await symlink(path.join(h.root,'external'),path.join(h.source,'outside'),process.platform==='win32'?'junction':'dir');
    h.store.put('projects',h.p.id,{...h.p,writeScopes:['docs']});assertProjectPaths(h.store,h.p.id,['docs/new/deep/report.md','alias/new.md']);assert.throws(()=>assertProjectPaths(h.store,h.p.id,['docs-other/report.md']),/超出/);assert.throws(()=>assertProjectPaths(h.store,h.p.id,['outside/secret.md']),/安全|目录|范围/);
    assert.throws(()=>h.tree.move({projectId:h.p.id,writeScopes:['../escape'],expectedRevision:1}),/路径|范围/);assert.throws(()=>h.tree.move({projectId:h.p.id,writeScopes:[],expectedRevision:1}),/范围/);assert.throws(()=>h.tree.move({projectId:h.p.id,writeScopes:['docs/*'],expectedRevision:1}),/路径|范围/);
    assert.equal(directoriesOverlap(h.source,path.join(h.source,'docs')),true);assert.equal(directoriesOverlap(h.source,path.join(h.root,'source-other')),false);if(process.platform==='win32')assert.equal(directoriesOverlap(h.source,h.source.toUpperCase()),true);
  }finally{await h.dispose();}
});
test('M5 serial admission includes paused flows, actual aliases, unresolved receipts and recovery journals',async()=>{
  const h=await fixture();try{
    const alias=path.join(h.root,'alias');await symlink(h.source,alias,process.platform==='win32'?'junction':'dir');const c=h.tree.create(alias,{writeScopes:['b.txt']});h.store.put('projects',h.p.id,{...h.p,writeScopes:['a.txt']});
    h.store.put('project_flows','f',{id:'f',projectId:h.p.id,status:'active',dispatchMode:'paused'});assert.throws(()=>assertProjectSerial(h.store,c.id),/串行/);assert.throws(()=>h.tree.move({projectId:h.p.id,writeScopes:['b.txt'],expectedRevision:1}),/先结束/);h.tree.move({projectId:h.p.id,writeScopes:['a.txt'],order:2,expectedRevision:1});h.store.delete('project_flows','f');
    const session=h.engine.createSession(h.p.id,'codex','unknown',true);h.store.put('runs','u',{id:'u',projectId:h.p.id,sessionId:session.id,status:'unknown',delivery:'unknown',revision:session.revision});h.store.put('blocked_sessions',session.id,{reason:'unknown'});assert.throws(()=>assertProjectSerial(h.store,c.id),/待核对/);h.store.put('sessions',session.id,{...session,revision:2});assert.doesNotThrow(()=>assertProjectSerial(h.store,c.id));
    h.store.put('flow_operations','op',{id:'op',state:'unknown'});h.store.put('runs','u',{id:'u',projectId:h.p.id,sessionId:session.id,status:'unknown',flowOperationId:'op'});assert.throws(()=>assertProjectSerial(h.store,c.id),/待核对/);h.store.put('flow_operations','op',{id:'op',state:'done',result:{abandoned:true,evidence:'人工核对放弃'}});assert.doesNotThrow(()=>assertProjectSerial(h.store,c.id));
    h.store.put('flow_apply_journals','j',{id:'j',projectId:'removed',directory:h.source,state:'recovery_required'});assert.throws(()=>assertProjectSerial(h.store,c.id),/写回结果/);h.store.delete('flow_apply_journals','j');
    markProjectRemoving(h.store,h.p.id,true);assert.throws(()=>assertProjectSerial(h.store,c.id),/移除/);markProjectRemoving(h.store,h.p.id,false);
  }finally{await h.dispose();}
});
test('M5 filesystem leases reserve the physical directory before an await and release after errors',async()=>{
  const h=await fixture();try{
    const c=h.tree.create(h.source,{});let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});const first=withProjectWrite(h.store,h.p.id,h.source,async()=>{await gate;throw Error('write failed');});
    assert.throws(()=>assertProjectSerial(h.store,c.id),/写入/);assert.throws(()=>assertProjectIdle(h.store,h.p.id),/先结束/);let entered=false;const second=withProjectWrite(h.store,c.id,h.source,async()=>{entered=true;});await new Promise(r=>setTimeout(r,10));assert.equal(entered,false);release();await assert.rejects(first,/write failed/);await second;assert.equal(entered,true);assert.doesNotThrow(()=>assertProjectSerial(h.store,c.id));
  }finally{await h.dispose();}
});
test('M5 an apply target must belong to its project while equivalent directory aliases remain valid',async()=>{
  const h=await fixture();try{
    const other=path.join(h.root,'other'),alias=path.join(h.root,'alias');await mkdir(other);await symlink(h.source,alias,process.platform==='win32'?'junction':'dir');let entered=false;
    await assert.rejects(withProjectWrite(h.store,h.p.id,other,async()=>{entered=true;}),/目录.*不一致/);assert.equal(entered,false);await withProjectWrite(h.store,h.p.id,alias,async()=>{entered=true;});assert.equal(entered,true);
  }finally{await h.dispose();}
});
test('M5 shared-directory workflow and joint review starts reject concurrent sibling admission before model calls',async()=>{
  const h=await harness();try{
    const c=await h.engine.invoke('project.create',{directory:h.source,parentId:h.project.id,name:'子'}) as Project,before=h.calls.length,s=(await h.state());
    await assert.rejects(h.engine.invoke('projectFlow.start',{projectId:c.id,requestId:'blocked',topic:'子任务',leadMemberId:'codex',memberIds:['codex','claude','dsh']}),/串行/);
    await assert.rejects(h.engine.invoke('projectFlow.jointReview.start',{projectId:c.id,requestId:'retired-review'}),/圆桌/);
    await assert.rejects((h.engine as any).projectFlow.joint.mutate('projectFlow.jointReview.start',{projectId:c.id,requestId:'blocked-review',kind:'proposal',subject:'对比',reviewerMemberIds:['claude'],leadMemberId:'codex'}),/串行/);
    const writer=h.engine.createSession(c.id,'claude','写入',true);await assert.rejects(h.engine.send(writer.id,'写文件'),/串行/);assert.equal(h.calls.length,before);assert.equal(h.engine.store.list<any>('runs').some(r=>r.projectId===c.id),false);
    await h.engine.invoke('projectFlow.cancel',{requestId:'cancel-parent',flowId:s.flow!.id,expectedRevision:s.flow!.revision});
    const d=await h.engine.invoke('project.create',{directory:h.source,parentId:h.project.id,name:'另一个子'}) as Project;
    const results=await Promise.allSettled([c,d].map(p=>h.engine.invoke('projectFlow.start',{projectId:p.id,requestId:'start-'+p.id,topic:'子任务',leadMemberId:'codex',memberIds:['codex','claude','dsh']})));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  }finally{await h.dispose();}
});
test('M5 a confirmed plan cannot exceed the project declaration even when an older draft exists',async()=>{
  const h=await harness();try{h.engine.store.put('projects',h.project.id,{...h.project,writeScopes:['a.txt']});const before=h.calls.length;await assert.rejects(h.confirm(),/超出|实际文件夹或修改范围/);assert.equal(h.calls.length,before);assert.equal((await h.state()).rounds.length,0);assert.equal(await h.original(),'old-a');}finally{await h.dispose();}
});
test('M5 copy apply and formal apply both reject all out-of-scope changes before touching originals',async()=>{
  const h=await fixture();try{
    h.store.put('projects',h.p.id,{...h.p,writeScopes:['a.txt']});const session=h.engine.createSession(h.p.id,'codex','copy',true),copy=await prepareWorkspace(h.p,session,true,h.store.dataDirectory);await writeFile(path.join(copy.directory,'a.txt'),'new-a');await writeFile(path.join(copy.directory,'b.txt'),'new-b');
    h.store.put('sessions',session.id,{...session,workspace:copy.directory,workspaceKind:copy.kind});await assert.rejects(h.engine.invoke('workspace.apply',{sessionId:session.id}),/超出/);assert.equal(await readFile(path.join(h.source,'a.txt'),'utf8'),'old-a');assert.equal(await readFile(path.join(h.source,'b.txt'),'utf8'),'old-b');
    const artifacts=new FlowArtifacts(h.store),base=await artifacts.capture({id:'f',projectId:h.p.id},h.source,'base'),result=await artifacts.capture({id:'f',projectId:h.p.id},copy.directory,'integration',base.id);result.fingerprint=await workspaceFingerprint(result.root);h.store.put('flow_artifacts',result.id,result);
    await assert.rejects(new FlowApply(h.store,artifacts).apply('accept',result,h.source),/超出/);assert.equal(h.store.list('flow_apply_journals').length,0);assert.equal(await readFile(path.join(h.source,'a.txt'),'utf8'),'old-a');
  }finally{await h.dispose();}
});
test('M5 recursive progress preserves project/version references and invalidates cursors after a hierarchy move',async()=>{
  const h=await fixture();try{
    const c=h.tree.create(h.source,{name:'子',parentId:h.p.id}),g=h.tree.create(h.source,{name:'孙',parentId:c.id}),other=h.tree.create(h.source,{name:'其它'});
    for(const p of [h.p,c,g,other])h.store.put('project_flows',p.id,{id:p.id,projectId:p.id,schemaVersion:1,revision:1,createdAt:'at',updatedAt:'at',leadMemberId:'codex',memberIds:['codex','claude'],topic:p.name,status:'completed',dispatchMode:'paused'});
    h.store.put('flow_integrations','version',{id:'version',flowId:g.id,projectId:g.id,schemaVersion:1,revision:1,roundId:'round',sequence:2,status:'accepted',createdAt:'at',updatedAt:'at',version:{artifactId:'stored-version',fingerprint:'hash',baselineId:'base'}});
    h.store.put('flow_integrations','foreign',{id:'foreign',flowId:g.id,projectId:other.id,version:{artifactId:'secret'}});
    const reader=new ProjectProgress(h.store),page=reader.timeline({projectId:h.p.id,includeChildren:true,limit:1}),all=reader.timeline({projectId:h.p.id,includeChildren:true,limit:100});assert.equal(all.total,3);assert.equal(reader.timeline({projectId:h.p.id}).total,1);assert.equal(all.counts.allSaved.results,1);
    const grandson=all.items.find(f=>f.projectId===g.id)!;assert.deepEqual(grandson.projectPath,['研究','子','孙']);assert.equal(grandson.resultVersions![0].version.artifactId,'stored-version');assert.throws(()=>reader.detail({projectId:h.p.id,flowId:g.id,section:'results'}),/不属于/);assert.equal(reader.detail({projectId:g.id,flowId:g.id,section:'results'}).items.length,1);
    h.tree.move({projectId:c.id,parentId:null,expectedRevision:1});assert.throws(()=>reader.timeline({projectId:h.p.id,includeChildren:true,cursor:page.cursor}),/分页/);assert.equal(reader.timeline({projectId:h.p.id,includeChildren:true}).total,1);assert.equal(h.store.list('runs').length,0);
  }finally{await h.dispose();}
});
