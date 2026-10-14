import '../../scripts/test-bootstrap.mjs';
// Real Engine + renderer; advancing a controlled clock never contacts real accounts.
// node --import tsx tests/ui/automation-smoke.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium, expect } from '@playwright/test';
import { createServer } from '../../scripts/ui-test-server.mjs';
import { Engine } from '../helpers/seeded-engine.ts'; // Scenarios opt into the built-in team; production starts empty.

const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM automation-ui-'));
const output=path.resolve('.test-cache/ui-automation');await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1360,height:900}});
const errors=[],rpc=[],calls=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
const providers=['claude','codex','dsh'].map(id=>({id,name:id,available:true,auth:id==='dsh'?'account':'subscription',detail:'fixture',capabilities:{steer:false,cancel:'native',streaming:true,write:false,history:true}}));
let at=Date.parse('2026-10-04T01:00:00Z'),publish=Promise.resolve();
const engine=new Engine(directory,event=>{
  if(event.type==='snapshot')event.snapshot.providers=providers;
  publish=publish.then(()=>page.evaluate(event=>window.__listeners?.forEach(fn=>fn(event)),event)).catch(()=>{});
},()=>{},id=>({probe:async()=>providers.find(p=>p.id===id),start:async ctx=>{calls.push(ctx.run);assert.equal(ctx.session.writeMode,false);assert.ok(ctx.run.automatic);ctx.markDelivery('confirmed');ctx.emit('message','提醒你检查今天的待办。',{source:'assistant'});return {};},stop:async()=>{}}),{automationNow:()=>at,automationTickMs:5});
const wait=async check=>{for(let i=0;i<500;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('engine did not settle');};
const tick=async jobId=>{at+=60_000;await wait(()=>engine.snapshot().automation.recent.some(item=>item.jobId===jobId&&Date.parse(item.startedAt)===at&&item.status!=='running'));await publish;};
try{
  await page.exposeFunction('__rpc',async(method,params)=>{rpc.push({method,params});if(['window.attention','window.show','renderer.error'].includes(method))return {};const result=await engine.invoke(method,params);if(method==='snapshot')result.providers=providers;return result;});
  await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:(method,params)=>window.__rpc(method,params),onEvent:fn=>{window.__listeners.push(fn);return()=>{window.__listeners=window.__listeners.filter(item=>item!==fn);};}};});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.getByRole('button',{name:'自动功能与定时任务',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'自动功能与定时任务',exact:true});
  for(const name of ['开启每日开场','开启成员闲聊','开启定时发言','启用此定时任务'])await expect(dialog.getByRole('checkbox',{name,exact:true})).not.toBeChecked();
  await dialog.getByLabel('定时任务名称',{exact:true}).fill('本地待办提醒');await dialog.getByLabel('定时任务内容',{exact:true}).fill('检查今天的待办');await dialog.getByLabel('定时触发方式',{exact:true}).selectOption('interval');await dialog.getByLabel('定时间隔分钟',{exact:true}).fill('1');await dialog.getByLabel('启用此定时任务',{exact:true}).check();await dialog.getByRole('button',{name:'保存定时任务',exact:true}).click();
  await wait(()=>engine.snapshot().automation.jobs.length===1);const local=engine.snapshot().automation.jobs[0];await tick(local.id);assert.equal(calls.length,0);await expect(dialog.locator('.automation-history')).toContainText('已完成');
  await dialog.getByLabel('定时任务名称',{exact:true}).fill('Claudia 定时问候');await dialog.getByLabel('定时任务动作',{exact:true}).selectOption('member-message');await dialog.getByLabel('定时发言成员',{exact:true}).selectOption('claude');await dialog.getByLabel('定时任务内容',{exact:true}).fill('提醒我检查今天的待办');await dialog.getByLabel('启用此定时任务',{exact:true}).check();await dialog.getByRole('button',{name:'保存定时任务',exact:true}).click();
  await wait(()=>engine.snapshot().automation.jobs.length===2);const speech=engine.snapshot().automation.jobs.find(job=>job.action.kind==='member-message');await tick(speech.id);assert.equal(calls.length,0);await expect(dialog.locator('.automation-history')).toContainText('这项自动发言还没开启');
  await dialog.getByLabel('开启定时发言',{exact:true}).check();await dialog.getByLabel('定时发言每日上限',{exact:true}).fill('1');await dialog.getByRole('button',{name:'保存每日预算',exact:true}).click();await wait(()=>engine.snapshot().automation.policies['scheduled-message'].enabled);await tick(speech.id);assert.equal(calls.length,1);
  await expect(dialog.locator('.automation-policy').filter({hasText:'定时发言'})).toContainText('今日 1 / 1 次');await tick(speech.id);assert.equal(calls.length,1);await expect(dialog.locator('.automation-history')).toContainText('每日上限');
  await page.screenshot({path:path.join(output,'automation-budget-1360.png'),animations:'disabled'});
  await page.setViewportSize({width:1100,height:750});await page.screenshot({path:path.join(output,'automation-budget-1100.png'),animations:'disabled'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await dialog.getByRole('button',{name:'暂停定时任务',exact:true}).click();await wait(()=>engine.snapshot().automation.paused);await tick(speech.id);assert.equal(calls.length,1);await dialog.getByRole('button',{name:'恢复定时任务',exact:true}).click();await wait(()=>!engine.snapshot().automation.paused);
  const localRow=dialog.locator('.automation-job').filter({hasText:'本地待办提醒'});await localRow.getByRole('button',{name:'停用',exact:true}).click();await wait(()=>!engine.snapshot().automation.jobs.find(job=>job.id===local.id).enabled);await localRow.getByRole('button',{name:'删除定时任务 本地待办提醒',exact:true}).click();await wait(()=>engine.snapshot().automation.jobs.length===1);assert.equal(engine.snapshot().automation.jobs[0].id,speech.id);
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();await page.locator('.room-entry').filter({hasText:'茶歇室'}).click();await expect(page.locator('.room-messages')).toContainText('提醒你检查今天的待办。');assert.ok(engine.snapshot().room.messages.find(message=>message.automatic)?.runId);assert.deepEqual(errors,[]);
  console.log('Automation UI passed: independent default-closed budgets, zero-cost local reminders, explicit scheduled speech, daily cap, pause/resume, job management and 1100px layout.');
}catch(error){console.error(JSON.stringify({rpc,state:engine.snapshot().automation,ui:await page.locator('body').innerText()},null,2));throw error;}
finally{await engine.close();await publish;await browser.close();await server.close();assert.ok(path.basename(directory).startsWith('AIROOM automation-ui-'));await rm(directory,{recursive:true,force:true});}
