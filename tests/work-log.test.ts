import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/backend/store';
import { WorkLogs } from '../src/backend/work-log';
import { observeTool, type LogReceipt, type WorkLogPage } from '../src/shared/work-log';
import { classifySession } from '../src/shared/session-classification';
import { bindFlowEvidence } from '../src/backend/project-flow-evidence';
import { workspaceFingerprint } from '../src/backend/workspace';
import type { TimelineEvent, Session } from '../src/shared/types';
import { harness } from './helpers/project-flow-harness';

const event=(id:string,data:unknown,text='实际命令')=>({id,sessionId:'s1',runId:'r1',provider:'codex',at:'2026-10-06T12:00:00Z',kind:'tool',text,data,fidelity:'native'} as TimelineEvent);
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'airoom-log-')),store=new Store(root),logs=new WorkLogs(store);
  store.put('projects','p1',{id:'p1',name:'项目',directory:root});store.put('projects','p2',{id:'p2',name:'别的项目',directory:root});
  store.put('flow_tasks','t1',{id:'t1',projectId:'p1',flowId:'f1',roundId:'round1',title:'完成网页'});
  store.put('flow_rounds','round1',{id:'round1',projectId:'p1',flowId:'f1',title:'第一轮',status:'executing'});
  store.put('flow_operations','o1',{id:'o1',projectId:'p1',flowId:'f1',targetId:'t1',kind:'task',runId:'r1'});
  store.put('sessions','s1',{id:'s1',projectId:'p1',provider:'codex',memberId:'codex'});
  store.put('sessions','s2',{id:'s2',projectId:'p2',provider:'claude'});
  store.put('runs','r1',{id:'r1',projectId:'p1',sessionId:'s1',provider:'codex',flowOperationId:'o1',status:'ended',delivery:'confirmed'});
  store.put('runs','r2',{id:'r2',projectId:'p2',sessionId:'s2',provider:'claude',status:'ended',delivery:'confirmed'});
  return {root,store,logs,p:{projectId:'p1',target:{kind:'task',id:'t1'}},close:async()=>{store.close();await rm(root,{recursive:true,force:true});}};
}

test('native tool projection and verification share explicit completion semantics for Codex, Claude and ACP',()=>{
  const start=event('e1',{type:'commandExecution',id:'tool1',command:'npm test',airoomPhase:'started'});
  const end=event('e2',{type:'commandExecution',id:'tool1',status:'completed',exitCode:3});
  assert.equal(observeTool(start)?.phase,'started');assert.equal(observeTool(end)?.phase,'failed');
  const claim=bindFlowEvidence([{kind:'command',description:'测试',command:'npm test',exitCode:0,result:'通过',eventIds:[],source:'reported'}],[start,end],['r1'])[0];
  assert.equal(claim.observedExitCode,3);assert.equal(claim.executionStatus,'failed');
  const unknown=event('u',{toolCallId:'a',sessionUpdate:'tool_call_update',status:'completed'});
  assert.equal(observeTool(unknown)?.phase,'completed');assert.equal(observeTool(unknown)?.exitCode,undefined);
  assert.equal(observeTool(event('c',{type:'tool_result',tool_use_id:'c',is_error:true}))?.phase,'failed');
  assert.equal(observeTool(event('file',{type:'fileChange',changes:[{path:'a.ts'}],status:'completed'}))?.paths[0],'a.ts');
  assert.equal(observeTool(event('text',undefined,'退出码 0，成功'))?.phase,'unknown');
});

test('session ownership uses positive domains and retains unclassified legacy history',()=>{
  const session={id:'s',projectId:'p',provider:'codex'} as Session;
  assert.equal(classifySession({...session,flowId:'f'}),'flow');assert.equal(classifySession({...session,purpose:'flow-review'}),'flow');
  assert.equal(classifySession(session,[{sessionId:'s',flowOperationId:'o'}]),'flow');
  assert.equal(classifySession({...session,roomThreadId:'thread'}),'room');assert.equal(classifySession({...session,purpose:'room-mention'}),'room');
  assert.equal(classifySession(session),'conversation');assert.equal(classifySession({...session,purpose:'legacy-unknown' as any}),'history');
});

test('interleaved sequences, skipped events and new output preserve a bounded log page with no duplicate IDs',async()=>{
  const f=await fixture();try{
    f.store.appendEvent(event('a',{toolCallId:'tool',status:'in_progress',rawInput:{command:'Get-Content a.txt'}}));
    f.store.appendEvent({...event('foreign',{}),sessionId:'s2',runId:'r2',text:'private foreign'});
    f.store.appendEvent({...event('delta',{}),kind:'delta',text:'stream'});
    f.store.appendEvent(event('b',{toolCallId:'tool',status:'failed'}));f.store.appendEvent(event('b',{toolCallId:'tool',status:'failed'}));
    const first=f.logs.page({...f.p,limit:1});assert.equal(first.entries[0].id,'a');assert.equal(first.hasMore,true);
    f.store.appendEvent(event('late',{status:'completed',exitCode:0}));
    let page=first;const ids=first.entries.map(e=>e.id);while(page.hasMore){page=f.logs.page({...f.p,cursor:page.cursor,limit:1});ids.push(...page.entries.map(e=>e.id));}
    assert.deepEqual(ids,['a','b']);assert.equal(page.scannedThrough,first.through);
    assert.ok(f.logs.page(f.p).entries.some(e=>e.id==='late'));
    assert.throws(()=>f.logs.page({projectId:'p2',target:f.p.target}),/不属于/);
    assert.throws(()=>f.logs.page({projectId:'p2',target:{kind:'session',id:'s2'},cursor:first.cursor}),/位置已无效/);
    const position=JSON.parse(Buffer.from(first.checkpoint,'base64url').toString());position.runIds=['r2'];
    assert.throws(()=>f.logs.page({...f.p,cursor:Buffer.from(JSON.stringify(position)).toString('base64url')}),/位置已无效/);
    const exported=f.logs.export({...f.p,checkpoint:first.checkpoint});assert.equal(exported.entryCount,2);assert.doesNotMatch(exported.content,/private foreign|late/);assert.match(exported.content,/退出码：未知/);
  }finally{await f.close();}
});

test('log export uses the full selected checkpoint even when requested from a later page, and redacts raw data',async()=>{
  const f=await fixture();try{
    f.store.appendEvent(event('a',{command:'echo first',status:'completed'}));
    f.store.appendEvent(event('b',{command:'echo second',password:'private-value'},'api_key=secret-example-value'));
    const first=f.logs.page({...f.p,limit:1}),second=f.logs.page({...f.p,cursor:first.cursor,limit:1});
    const exported=f.logs.export({...f.p,checkpoint:second.checkpoint});assert.equal(exported.entryCount,2);assert.doesNotMatch(exported.content,/private-value|secret-example-value/);assert.match(exported.content,/credential redacted/);
    assert.match(exported.content,/事件 a/);assert.match(exported.content,/事件 b/);
    const same=f.logs.export({...f.p,checkpoint:first.checkpoint});assert.equal(same.hash,exported.hash);
  }finally{await f.close();}
});

test('project-room logs read their hidden execution project without admitting a different room',async()=>{
  const f=await fixture();try{
    f.store.put('projects','hidden',{id:'hidden',kind:'lounge',roomId:'project:p1',directory:f.root});
    f.store.put('sessions','room-session',{id:'room-session',projectId:'hidden',provider:'codex',roomId:'project:p1',purpose:'room-mention'});
    f.store.put('runs','room-run',{id:'room-run',projectId:'hidden',sessionId:'room-session',provider:'codex',status:'ended',delivery:'confirmed'});
    f.store.appendEvent({...event('room-event',{status:'completed'}),runId:'room-run',sessionId:'room-session'});
    f.store.put('room_messages','reply',{id:'reply',runId:'room-run',text:'点名回复已保存',author:'codex',status:'done'});
    const p={projectId:'p1',target:{kind:'session',id:'room-session'}},page=f.logs.page(p);
    assert.equal(page.entries[0].id,'room-event');assert.equal(page.records[0].kind,'reply');assert.equal(page.canWrite,false);
    assert.throws(()=>f.logs.page({...p,projectId:'p2'}),/不属于/);
    f.store.put('projects','hidden',{id:'hidden',kind:'lounge',roomId:'project:p2',directory:f.root});
    assert.throws(()=>f.logs.page(p),/不属于/);
  }finally{await f.close();}
});

test('real task log includes author and review attempts without dispatch, and project logging is off by default',async()=>{
  const h=await harness();try{
    await h.confirm();const s=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance'),task=s.tasks[0];
    const calls=h.calls.length,p={projectId:h.project.id,target:{kind:'task',id:task.id}};
    const page=await h.engine.invoke('projectFlow.log',p) as WorkLogPage;
    assert.ok(page.runs.some(r=>r.stage==='task'));assert.ok(page.runs.some(r=>r.stage==='review'));
    assert.ok(page.records.some(r=>r.kind==='submission'));assert.ok(page.records.some(r=>r.kind==='review'));assert.ok(page.entries.some(e=>e.text==='已发送本次工作说明；完整内容可展开原始记录。'));
    await h.engine.invoke('projectFlow.log.export',p);assert.equal(h.calls.length,calls);
    await assert.rejects(h.engine.invoke('projectFlow.log.write',{...p,requestId:'too-early'}),/验收并写入/);
    await h.accept();await h.wait(s=>s.flow?.status==='completed');assert.equal(h.engine.store.list('flow_log_receipts').length,0);
  }finally{await h.dispose();}
});

test('opted-in archive is independent from acceptance, stable on retries and excluded from project scans',async()=>{
  const h=await harness();try{
    await h.engine.invoke('project.update',{projectId:h.project.id,writeWorkLogs:true});await h.confirm();await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');
    await h.accept();await h.wait(s=>s.flow?.status==='completed');
    const until=Date.now()+10000;while(!h.engine.store.list<LogReceipt>('flow_log_receipts').some(r=>r.state==='written')){if(Date.now()>until)throw Error('logs not saved');await new Promise(r=>setTimeout(r,25));}
    const s=await h.state(),p={projectId:h.project.id,target:{kind:'round',id:s.rounds[0].id}},calls=h.calls.length;
    const receipts=await h.engine.invoke('projectFlow.log.write',{...p,requestId:'write-1'}) as LogReceipt[];
    assert.equal(receipts.length,s.tasks.length+1);assert.ok(receipts.every(r=>r.state==='written'));
    const before=await workspaceFingerprint(h.source),bytes=await readFile(path.join(h.source,receipts[0].path),'utf8');
    await Promise.all(['write-2','write-3'].map(requestId=>h.engine.invoke('projectFlow.log.write',{...p,requestId})));
    assert.equal(await workspaceFingerprint(h.source),before);assert.equal(await readFile(path.join(h.source,receipts[0].path),'utf8'),bytes);assert.equal(h.engine.store.list('flow_log_receipts').length,receipts.length);assert.equal(h.calls.length,calls);
    h.engine.store.put('flow_log_receipts',receipts[0].id,{...receipts[0],state:'prepared'});
    const restarted=new WorkLogs(h.engine.store);const recovered=await restarted.write(p);
    assert.ok(recovered.every(r=>r.state==='written'));assert.equal(await readFile(path.join(h.source,receipts[0].path),'utf8'),bytes);
  }finally{await h.dispose();}
});

test('log reads and export stay available during backup maintenance while settings and disk writes are blocked',async()=>{
  const h=await harness();try{
    await h.confirm();const s=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance'),p={projectId:h.project.id,target:{kind:'round',id:s.rounds[0].id}},calls=h.calls.length;
    (h.engine as any).maintenance=true;
    await h.engine.invoke('projectFlow.log',p);await h.engine.invoke('projectFlow.log.export',p);assert.equal(h.calls.length,calls);
    await assert.rejects(h.engine.invoke('projectFlow.log.write',{...p,requestId:'maintenance'}),/备份或恢复/);
    await assert.rejects(h.engine.invoke('project.update',{projectId:h.project.id,writeWorkLogs:true}),/备份或恢复/);
  }finally{(h.engine as any).maintenance=false;await h.dispose();}
});

test('archive path failures preserve accepted files and permit a safe retry without model calls',async()=>{
  const h=await harness();try{
    await h.engine.invoke('project.update',{projectId:h.project.id,writeWorkLogs:true});
    await mkdir(path.join(h.source,'.airoom'));await writeFile(path.join(h.source,'.airoom','logs'),'user-owned file');
    await h.confirm();await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');await h.accept();await h.wait(s=>s.flow?.status==='completed');
    const s=await h.state(),p={projectId:h.project.id,target:{kind:'round',id:s.rounds[0].id}};
    const failed=await h.engine.invoke('projectFlow.log.write',{...p,requestId:'failure-retry'}) as LogReceipt[];
    assert.ok(failed.every(r=>r.state==='failed'));assert.equal(await h.original(),'new-a');assert.equal((await h.state()).acceptances[0].status,'accepted');assert.equal(h.engine.snapshot().workLogFailures.length,1);
    assert.equal(await readFile(path.join(h.source,'.airoom','logs'),'utf8'),'user-owned file');const calls=h.calls.length;
    await rm(path.join(h.source,'.airoom','logs'));
    const written=await h.engine.invoke('projectFlow.log.write',{...p,requestId:'fixed-retry'}) as LogReceipt[];assert.ok(written.every(r=>r.state==='written'));assert.equal(h.calls.length,calls);
  }finally{await h.dispose();}
});

test('project log export never follows an outside junction or overwrites an unrelated same-name file',async()=>{
  const h=await harness();try{
    await h.confirm();await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');await h.accept();await h.wait(s=>s.flow?.status==='completed');
    const s=await h.state(),p={projectId:h.project.id,target:{kind:'round',id:s.rounds[0].id}},outside=path.join(h.root,'outside');await mkdir(outside);await mkdir(path.join(h.source,'.airoom'));await symlink(outside,path.join(h.source,'.airoom','logs'),'junction');
    const receipts=await h.engine.invoke('projectFlow.log.write',{...p,requestId:'junction'}) as LogReceipt[];assert.ok(receipts.every(r=>r.state==='failed'));assert.match(receipts[0].error!,/之外/);
    // Failed receipts already pin an export identity; a user file at its destination is preserved.
    await rm(path.join(h.source,'.airoom','logs'));await mkdir(path.dirname(path.join(h.source,receipts[0].path)),{recursive:true});await writeFile(path.join(h.source,receipts[0].path),'user file');
    const retried=await h.engine.invoke('projectFlow.log.write',{...p,requestId:'user-file'}) as LogReceipt[];assert.equal(retried[0].state,'failed');assert.equal(await readFile(path.join(h.source,receipts[0].path),'utf8'),'user file');
  }finally{await h.dispose();}
});
