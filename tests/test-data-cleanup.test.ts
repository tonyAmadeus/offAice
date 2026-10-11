import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {testDataCandidates,fullTestCleanupBackup,testCleanupPreflight,assertTestCleanupReady} from '../scripts/cleanup-test-data';

test('cleanup preview shows non-test-named descendants and legacy blockers; apply rejects before making a backup',async()=>{
  const root=path.resolve('.test-cache/cleanup-preflight');await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(path.join(root,'run-')),data=path.join(dir,'data');await fs.mkdir(data);
  const row=(entity:string,id:string,value:any)=>({entity,id,value:JSON.stringify({id,...value})});
  const rows=[row('projects','parent',{name:'验收项目',createdAt:'2026-10-08'}),row('projects','child',{name:'普通子任务',parentId:'parent'}),row('projects','grandchild',{name:'普通孙项目',parentId:'child'}),row('projects','other',{name:'日常项目'}),row('sessions','session',{projectId:'parent'}),row('runs','unknown',{projectId:'parent',sessionId:'session',status:'unknown',delivery:'unknown'}),row('project_flows','flow',{projectId:'parent',status:'paused'}),row('project_flows','finished',{projectId:'parent',status:'completed'}),row('flow_apply_journals','journal',{projectId:'parent',state:'recovery_required'})];
  const selected=[{entity:'projects',id:'parent'}],preview=testCleanupPreflight(rows,selected)[0];
  assert.deepEqual(preview.children.map(c=>c.id),['child','grandchild']);assert.deepEqual(preview.blockers.map(b=>b.id),['unknown','flow','journal']);assert.ok(preview.blockers.every(b=>b.resolution.length>0));assert.equal(preview.ready,false);
  assert.throws(()=>assertTestCleanupReady(rows,selected),/尚未复制或删除资料/);
  const clean=rows.filter(r=>['parent','other'].includes(r.id));assert.equal(testCleanupPreflight(clean,selected)[0].ready,true);assert.doesNotThrow(()=>assertTestCleanupReady(clean,selected));
  const db=new DatabaseSync(path.join(data,'airoom.sqlite'));db.exec('CREATE TABLE entities(entity TEXT,id TEXT,value TEXT)');const insert=db.prepare('INSERT INTO entities VALUES (?,?,?)');for(const r of rows)insert.run(r.entity,r.id,r.value);db.close();
  const candidates=testDataCandidates(rows.filter(r=>r.entity==='projects'),[{file:'fixture',text:'parent'}],'2026-10-05','2026-10-11');
  const plan=path.join(dir,'plan.json');await fs.writeFile(plan,JSON.stringify({version:1,data,candidates}));
  try{
    const result=spawnSync(process.execPath,['--import','tsx','scripts/cleanup-test-data.ts','--data',data,'--apply-plan',plan,'--confirm','projects:parent','--app-closed'],{encoding:'utf8',windowsHide:true});
    assert.notEqual(result.status,0);assert.match(result.stderr,/清理预检未通过/);assert.match(result.stderr,/普通子任务/);
    await assert.rejects(fs.stat(path.join(dir,'test-cleanup-backups')),/ENOENT/);
    const unchanged=new DatabaseSync(path.join(data,'airoom.sqlite'),{readOnly:true});assert.equal(unchanged.prepare('SELECT count(*) AS n FROM entities').get()?.n,rows.length);unchanged.close();
  }finally{await fs.rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
});
test('test cleanup requires name, time and exact acceptance reference; listing never removes anything',()=>{
  const rows=[['test','补测验收项目','2026-10-08'],['owner','主人日常作品','2026-10-08'],['old','旧测试','2026-09-01'],['unproven','测试候选','2026-10-08']].map(([id,name,createdAt])=>({entity:'projects',id,value:JSON.stringify({id,name,createdAt})}));
  const results=testDataCandidates(rows,[{file:'acceptance.md',text:'test owner old'}],'2026-10-05','2026-10-11');
  assert.deepEqual(results.filter(r=>r.eligible).map(r=>r.id),['test']);assert.equal(rows.length,4);assert.equal(results.find(r=>r.id==='unproven')?.eligible,false);
});
test('cleanup backup includes desk manuscripts and isolated account files; source database remains unchanged',async()=>{
  const root=path.resolve('.test-cache/cleanup-tool');await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(path.join(root,'run-')),data=path.join(dir,'data');await fs.mkdir(data);
  const db=new DatabaseSync(path.join(data,'airoom.sqlite'));db.exec('CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES (\'preserved\')');db.close();
  for(const name of ['desks/member/story.txt','roundtable/topic/manuscript.txt','native/fake/account.txt']){await fs.mkdir(path.dirname(path.join(data,name)),{recursive:true});await fs.writeFile(path.join(data,name),'fixture');}
  try{const backup=await fullTestCleanupBackup(data);for(const name of ['desks/member/story.txt','roundtable/topic/manuscript.txt','native/fake/account.txt'])assert.equal(await fs.readFile(path.join(backup,'data',name),'utf8'),'fixture');const copy=new DatabaseSync(path.join(backup,'data/airoom.sqlite'),{readOnly:true});assert.equal(copy.prepare('SELECT value FROM fixture').get()?.value,'preserved');copy.close();assert.equal((await fs.stat(path.join(data,'desks/member/story.txt'))).isFile(),true);
  }finally{assert.equal(path.dirname(dir),root);await fs.rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
});
