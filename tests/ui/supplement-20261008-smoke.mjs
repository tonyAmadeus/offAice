import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {harness,plan} from '../helpers/project-flow-harness.ts';
import {roundtableHarness} from '../helpers/roundtable-harness.ts';

const output=path.resolve('.test-cache/ui-supplement-20261008');await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1360,height:900}}),errors=[];
let current,publish=Promise.resolve(),release=()=>{},pickedDirectory=null,openedMaterial,pauseGate,pauseStarted=false,pauseFinished=false;
page.on('pageerror',e=>errors.push(e.message));
await page.exposeFunction('rpc',async(method,params)=>{if(method==='dialog.directory')return pickedDirectory;if(method==='roundtable.open')openedMaterial=params.material;if(method==='projectFlow.pause'&&pauseGate){pauseStarted=true;await pauseGate;const result=await current.engine.invoke(method,params);pauseFinished=true;return result;}return ['window.attention','window.show','renderer.error'].includes(method)?{}:current.engine.invoke(method,params);});
await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:window.rpc,onEvent:listener=>{window.__listeners.push(listener);return()=>{};}};});
async function show(h){current=h;h.engine.push=e=>{publish=publish.then(()=>page.evaluate(e=>window.__listeners?.forEach(fn=>fn(e)),e)).catch(()=>{});};await page.goto('http://127.0.0.1:'+server.httpServer.address().port);}
async function close(){release();await current?.dispose();await publish;current=undefined;}
try{
  {
    const gate=new Promise(r=>release=r),p=plan();p.tasks=p.tasks.slice(0,1);
    const h=await harness({plan:p,handler:async c=>{if(c.kind==='submission')await gate;}});
    await h.engine.invoke('project.update',{projectId:h.project.id,name:'隔离项目 A'});const secondPath=path.join(h.root,'second');await mkdir(secondPath);
    const second=await h.engine.invoke('project.create',{directory:secondPath});await h.engine.invoke('project.update',{projectId:second.id,name:'隔离项目 B',memberIds:['codex','claude','dsh']});
    await h.confirm();await h.wait(s=>s.tasks[0]?.status==='running');await show(h);await page.getByRole('button',{name:'隔离项目 A',exact:true}).click();
    const a=page.getByRole('main',{name:'隔离项目 A 的项目会议室'});await expect(a.getByRole('button',{name:'任务：A',exact:true})).toHaveCount(1);
    let releasePause;pauseGate=new Promise(r=>releasePause=r);await a.getByRole('button',{name:'暂停',exact:true}).click();await expect.poll(()=>pauseStarted).toBe(true);
    await page.getByRole('button',{name:'隔离项目 B',exact:true}).click();const b=page.getByRole('main',{name:'隔离项目 B 的项目会议室'});await expect(b.getByRole('button',{name:'任务：A',exact:true})).toHaveCount(0);
    releasePause();await expect.poll(()=>pauseFinished).toBe(true);await publish;await expect(b.getByRole('heading',{name:'这次想一起做什么？',exact:true})).toBeVisible();await page.waitForTimeout(300);await expect(b.getByRole('button',{name:'任务：A',exact:true})).toHaveCount(0);
    await page.screenshot({path:path.join(output,'project-switch-late-mutation.png'),animations:'disabled'});pauseGate=undefined;await close();
  }
  {
    const p=plan();p.tasks=p.tasks.slice(0,1);const h=await harness({plan:p,level:'medium',handler:async c=>c.kind==='task-addition'?{completionCriteria:[{text:'追加内容正确',kind:'check'}],allowedPaths:['a.txt'],inScope:true,scopeReason:'在当前文件内补充'}:undefined});await h.confirm();const ready=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');
    const result=await h.engine.invoke('projectFlow.task.prepare',{requestId:crypto.randomUUID(),flowId:ready.flow.id,expectedRevision:ready.flow.revision,roundId:ready.rounds[0].id,memberId:'claude',title:'补测追加',goal:'补充 a.txt'});
    const deadline=Date.now()+20000;let proposal;do{proposal=await h.engine.invoke('projectFlow.task.proposal',{projectId:h.project.id,proposalId:result.proposalId});if(proposal.status==='ready')break;assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,25));}while(true);
    const count=h.calls.length;await show(h);await page.getByRole('button',{name:/^待你处理/}).click();await page.getByRole('dialog',{name:'待你处理',exact:true}).getByRole('button',{name:'查看追加草案',exact:true}).click();const room=page.getByRole('main',{name:h.project.name+' 的项目会议室'});
    await room.getByRole('button',{name:'查看待确认追加：补测追加',exact:true}).click();const dialog=page.getByRole('dialog',{name:'追加任务 · Claudia',exact:true});await expect(dialog).toContainText('追加内容正确');assert.equal((await h.state()).tasks.length,1);assert.equal(h.calls.length,count);
    await dialog.getByRole('button',{name:'取消',exact:true}).click();await room.getByRole('button',{name:'查看待确认追加：补测追加',exact:true}).click();assert.equal(h.calls.length,count,'opening a saved proposal never prepares another model call');
    await dialog.getByRole('button',{name:'确认追加到看板',exact:true}).click();await h.wait(s=>s.tasks.length===2);await expect(dialog).toHaveCount(0);assert.equal(h.engine.snapshot().attention.items.some(item=>item.id==='task-addition:'+proposal.id),false);await page.screenshot({path:path.join(output,'saved-task-addition-confirmation.png'),animations:'disabled'});await close();
  }
  for(const level of ['high','medium','low']){
    const gate=new Promise(r=>release=r),p=plan();p.tasks=p.tasks.slice(0,1);
    const h=await harness({plan:p,level,handler:async c=>{if(c.kind==='integration-check')await gate;}});await show(h);await page.getByRole('button',{name:h.project.name,exact:true}).click();await h.confirm();
    const room=page.getByRole('main',{name:h.project.name+' 的项目会议室'}),board=room.getByRole('complementary',{name:'看板'});
    if(level==='low')await h.wait(s=>s.decisions.some(d=>d.kind==='review-choice'&&d.status==='open'));else await h.wait(s=>s.rounds[0]?.status==='checking');
    await publish;await expect(board.getByRole('region',{name:'待复核',exact:true})).toHaveCount(level==='high'?1:0);
    if(level==='medium'){await expect(board).toContainText('本轮整体检查中');await expect(board.getByRole('button',{name:'任务：A'})).toContainText('等本轮整体检查');}
    if(level==='low')await expect(board.getByRole('region',{name:'已完成',exact:true})).toContainText('A');
    await page.screenshot({path:path.join(output,'board-'+level+'.png'),animations:'disabled'});await close();
  }
  let fail=true;const h=await roundtableHarness({handler:async c=>c.kind==='joint-independent'&&(c.ctx.session.memberId??c.ctx.session.provider)==='codex'&&fail?{wrong:'invalid'}:undefined});
  const t=(await h.open({kind:'proposals',memberIds:['claude','codex'],peerReview:false})).topic;await h.wait(t.id,d=>d.topic.status==='blocked'&&d.review.slots.some(s=>s.memberId==='claude'&&s.status==='completed'));await show(h);await page.getByRole('button',{name:/^圆桌/}).click();
  const room=page.getByRole('main',{name:'圆桌',exact:true}),dock=room.getByRole('region',{name:'圆桌进度'});await expect(dock.getByLabel('本议题调用次数')).toContainText('含补正 1 次');
  await expect(dock.getByRole('button',{name:'让 TA 重写这一份',exact:true})).toBeEnabled();await expect(dock.getByRole('textbox',{name:'评审运行核对依据'})).toHaveValue('');fail=false;await dock.getByRole('button',{name:'让 TA 重写这一份',exact:true}).click();
  await h.wait(t.id,d=>d.review.review.status==='awaiting_decision');await publish;await expect(room.getByRole('article',{name:/圆桌候选/})).toHaveCount(2);await expect.poll(async()=>{const label=await dock.getByLabel('本议题调用次数').innerText(),current=await h.get(t.id);return label.includes('累计尝试 '+current.callUsage.total+' 次');}).toBe(true);await page.screenshot({path:path.join(output,'roundtable-rewritten-preserved.png'),animations:'disabled'});await close();
  const folders=await roundtableHarness();await show(folders);await page.getByRole('button',{name:/^圆桌/}).click();await page.getByRole('main',{name:'圆桌',exact:true}).locator(':scope > .room-top').getByRole('button',{name:'开新议题',exact:true}).click();
  const form=page.getByRole('dialog',{name:'开圆桌议题'});pickedDirectory=folders.original;await form.getByRole('button',{name:'选择材料文件夹',exact:true}).click();await expect(form).toContainText(folders.original);
  pickedDirectory=null;await form.getByRole('button',{name:'选择材料文件夹',exact:true}).click();await expect(form).toContainText(folders.original);
  await form.getByRole('button',{name:'移除文件夹',exact:true}).click();await expect(form.getByRole('button',{name:'移除文件夹',exact:true})).toHaveCount(0);
  pickedDirectory=folders.original;await form.getByRole('button',{name:'选择材料文件夹',exact:true}).click();await form.getByRole('button',{name:'开始评审',exact:true}).click();await expect(form).toHaveCount(0);assert.equal(openedMaterial.directory,folders.original);await close();
  assert.deepEqual(errors,[]);console.log('Supplement UI passed: late project response isolation, saved task-addition attention/reopen/confirmation, high/medium/low board lanes, whole-round check label, completed task label, real receipt counter, per-slot rewrite, preserved other candidate, and native directory string/cancellation/import contract.');
}finally{await close();await browser.close();await server.close();}
