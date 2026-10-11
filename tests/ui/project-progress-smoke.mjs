import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {harness,plan} from '../helpers/project-flow-harness.ts';
const output=path.resolve('.test-cache/ui-project-progress');await mkdir(output,{recursive:true});
const p=plan();p.objective='第一段研究报告';let planning=0;
const h=await harness({plan:p,handler:async c=>{if(c.kind==='plan'&&++planning>1)return {...p,objective:c.material.instruction};return undefined;}});
await h.engine.invoke('project.update',{projectId:h.project.id,memberIds:['codex','claude','dsh']});
await h.confirm();await h.wait(s=>s.rounds[0].status==='awaiting_acceptance');await h.accept();const first=await h.wait(s=>s.flow.status==='completed'),firstId=first.flow.id;
await h.engine.invoke('projectFlow.start',{requestId:'second-work',projectId:h.project.id,topic:'取消的资料探索',leadMemberId:'codex',memberIds:['codex','claude','dsh']});let s=await h.wait(s=>s.flow.id!==firstId&&s.plan?.status==='awaiting_confirmation');await h.engine.invoke('projectFlow.cancel',{requestId:'cancel-second',flowId:s.flow.id,expectedRevision:s.flow.revision});
for(let i=0;i<12;i++){const id='fixture-history-'+i,at='2026-01-01T00:00:00.000Z';h.engine.store.put('project_flows',id,{...first.flow,id,flowId:id,activePlanId:undefined,topic:'旧工作 '+i,status:'completed',createdAt:at,updatedAt:at});}
const oldPlan={...first.plan,id:'fixture-old-plan',status:'superseded',version:0,objective:'被替代的旧版报告'};h.engine.store.put('flow_plans',oldPlan.id,oldPlan);
const oldIntegration={...first.integrations[0],id:'fixture-old-result',sequence:0,status:'stale'};h.engine.store.put('flow_integrations',oldIntegration.id,oldIntegration);
await h.engine.invoke('projectFlow.start',{requestId:'third-work',projectId:h.project.id,topic:'当前研究工作',leadMemberId:'codex',memberIds:['codex','claude','dsh']});s=await h.wait(s=>s.plan?.objective==='当前研究工作'&&s.plan.status==='awaiting_confirmation');const currentId=s.flow.id,before=h.calls.length;
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1100,height:820}}),errors=[],calls=[];let publish=Promise.resolve();page.on('pageerror',e=>errors.push(e.message));
h.engine.push=e=>{publish=publish.then(()=>page.evaluate(e=>window.__listeners?.forEach(fn=>fn(e)),e)).catch(()=>{});};
try{
  await page.exposeFunction('__rpc',async(method,params)=>{calls.push({method,params});if(method==='file.save')return {cancelled:true};if(['window.attention','window.show','renderer.error'].includes(method))return {};return h.engine.invoke(method,params);});
  await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:(m,p)=>window.__rpc(m,p),onEvent:fn=>{window.__listeners.push(fn);return()=>{};}};});
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port);await page.locator('.project-item .list-row-main').first().click();
  await page.getByRole('tab',{name:'项目进度',exact:true}).click();const progress=page.getByRole('complementary',{name:'项目进度'});
  await expect(progress).toContainText('共 15 段工作');await expect(progress).toContainText('1 段进行中');await expect(progress).toContainText('1 段已取消');await expect(progress).toContainText('历史总数包含被替代方案');await expect(progress).toContainText('已显示 10 / 15');
  await progress.getByRole('button',{name:'更多工作',exact:true}).click();await expect(progress).toContainText('已显示 15 / 15');
  // The board folds into a rail so the chat gets the width, stays folded after a reload, and opens again.
  const chatWidth=()=>page.locator('.project-room-grid > .room-embedded').evaluate(n=>n.getBoundingClientRect().width);const wide=await chatWidth();
  await page.getByRole('button',{name:'收起看板',exact:true}).click();await expect(page.getByRole('complementary',{name:'看板已收起'})).toBeVisible();await expect(progress).toHaveCount(0);assert.ok(await chatWidth()>wide+200,'the chat takes the board width');
  await page.reload();await page.locator('.project-item .list-row-main').first().click();await expect(page.getByRole('complementary',{name:'看板已收起'})).toBeVisible();
  await page.getByRole('button',{name:'展开看板',exact:true}).click();await page.getByRole('tab',{name:'项目进度',exact:true}).click();await progress.getByRole('button',{name:'更多工作',exact:true}).click();await expect(progress).toContainText('已显示 15 / 15');
  const flow=progress.locator('.progress-flow',{has:page.getByRole('button',{name:/第一段研究报告/})});await flow.getByRole('button',{name:/第一段研究报告/}).click();await expect(flow).toContainText('本轮汇总');
  await flow.getByRole('tab',{name:'方案版本',exact:true}).click();await expect(flow).toContainText('被替代的旧版报告');await expect(flow).toContainText('已被替代');
  await flow.getByRole('tab',{name:'成果版本',exact:true}).click();await expect(flow).toContainText('成果第 0 次 · 旧版本');await expect(flow).toContainText('成果第 1 次 · 已验收');
  await flow.getByRole('tab',{name:'任务记录',exact:true}).click();await expect(flow).toContainText('作者：Claudia；复核人');
  await flow.getByRole('tab',{name:'验收记录',exact:true}).click();await expect(flow).toContainText('验收通过');
  await flow.getByRole('button',{name:'查看本段项目记录',exact:true}).click();const record=page.getByRole('dialog',{name:'项目记录'});await expect(record).toContainText('第一段研究报告');await record.getByRole('button',{name:'关闭',exact:true}).click();
  await progress.evaluate(node=>{node.scrollTop=0;});await page.screenshot({path:path.join(output,'project-progress-1100.png'),animations:'disabled'});
  await page.setViewportSize({width:1360,height:900});await page.screenshot({path:path.join(output,'project-progress-1360.png'),animations:'disabled'});
  assert.equal(h.calls.length,before);assert.equal((await h.state()).flow.id,currentId);assert.equal((await h.state()).plan.status,'awaiting_confirmation');assert.deepEqual(errors,[]);assert.equal(calls.filter(c=>c.method==='renderer.error').length,0);
  assert.ok(calls.some(c=>c.method==='projectFlow.progress.detail'));assert.ok(calls.every(c=>!['projectFlow.plan.confirm','projectFlow.resume','run.start'].includes(c.method)));
  console.log('Project progress UI passed: full-project scope and distinct counts, completed/cancelled/current flows, stable paging, superseded plans, all result versions, task roles, acceptance and saved record without model calls or restarting historical work at 1100/1360px.');
}catch(e){console.log('Renderer diagnostics:',JSON.stringify(calls.filter(c=>c.method==='renderer.error')));throw e;}finally{await h.dispose();await publish;await browser.close();await server.close();}
