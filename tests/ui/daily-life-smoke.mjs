import '../../scripts/test-bootstrap.mjs';
// Real Engine + renderer, deterministic native adapters. No account or model calls.
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium,expect } from '@playwright/test';
import { createServer } from '../../scripts/ui-test-server.mjs';
import { Engine } from '../../src/backend/engine.ts';

const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM daily-life-ui-')),output=path.resolve('.test-cache/ui-daily-life');await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1360,height:900}});
const errors=[],calls=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
let at=Date.parse('2026-10-04T01:00:00Z'),publish=Promise.resolve();
const engine=new Engine(directory,event=>{publish=publish.then(()=>page.evaluate(event=>window.__listeners?.forEach(fn=>fn(event)),event)).catch(()=>{});},()=>{},id=>({
  probe:async()=>({id,name:id,available:true,auth:id==='dsh'?'account':'subscription',detail:'fixture',capabilities:{steer:false,cancel:'native',streaming:true,write:false,history:true}}),
  start:async ctx=>{calls.push(ctx);assert.equal(ctx.session.writeMode,false);assert.ok(ctx.run.automatic);assert.ok(!ctx.persona?.includes('disabled-memory'));assert.ok(!ctx.run.input.includes('unapproved-proposal'));ctx.markDelivery('confirmed');ctx.emit('message',ctx.run.automatic.feature==='daily-opening'?'早上好，昨天聊过测试计划，今天想先做什么？':calls.filter(call=>call.run.automatic.feature==='member-chat').length%2?'按我们的作息设定，想象现在正泡一壶茶。':'那就先聊到这里，等主人有空再说。',{source:'assistant'});return {};},stop:async()=>{},
}),{automationNow:()=>at,automationTickMs:5});
const wait=async check=>{for(let i=0;i<800;i++){if(check())return;await new Promise(done=>setTimeout(done,10));}assert.fail('daily life UI did not settle');};
const tick=async feature=>{const job=engine.snapshot().automation.jobs.find(job=>job.managed===feature);assert.ok(job.nextAt);at=Date.parse(job.nextAt);await wait(()=>engine.snapshot().automation.recent.some(item=>!item.parentOccurrenceId&&item.jobId===job.id&&item.dueAt===job.nextAt&&item.status!=='running'));await publish;};
try{
  await engine.probe();await engine.invoke('internal.room.opened',{visible:true});
  const thread=engine.store.currentRoomThread();engine.store.put('room_threads',thread.id,{...thread,summary:{text:'摘要',proposals:['unapproved-proposal']}});
  engine.store.put('room_messages','yesterday',{id:'yesterday',author:'user',authorName:'主人',threadId:thread.id,text:'今天先说说测试计划',status:'done',at:'2026-10-04T01:00:00Z'});
  const member=engine.store.members()[0];engine.store.put('members',member.id,{...member,routine:{morning:'泡一壶茶'},quirks:['转笔'],memories:[{id:'off',text:'disabled-memory',source:'manual',createdAt:'',off:true}]});
  await page.exposeFunction('__rpc',async(method,params)=>{if(['window.attention','window.show','renderer.error'].includes(method))return {};return engine.invoke(method,params);});
  await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:(method,params)=>window.__rpc(method,params),onEvent:fn=>{window.__listeners.push(fn);return()=>{window.__listeners=window.__listeners.filter(item=>item!==fn);};}};});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);await page.getByRole('button',{name:'自动功能与定时任务',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'自动功能与定时任务',exact:true});
  for(const feature of ['每日开场','成员闲聊'])await expect(dialog.getByRole('checkbox',{name:`开启${feature}`,exact:true})).not.toBeChecked();
  await expect(dialog).toContainText('角色设定');await dialog.getByLabel('开启每日开场',{exact:true}).check();await dialog.getByLabel('开启成员闲聊',{exact:true}).check();await dialog.getByLabel('成员闲聊间隔分钟',{exact:true}).fill('5');await dialog.getByRole('button',{name:'保存每日预算',exact:true}).click();
  await wait(()=>engine.snapshot().automation.policies['member-chat'].enabled);assert.equal(calls.length,0);assert.equal(engine.settings.dailyLife.memberChatMinutes,5);
  await engine.invoke('internal.room.opened',{visible:true});assert.equal(engine.snapshot().automation.jobs.some(job=>job.managed==='daily-opening'),false);
  at+=86_400_000;await engine.invoke('internal.room.opened',{visible:true});await tick('daily-opening');assert.equal(calls.length,1);assert.ok(calls[0].run.input.includes('今天先说说测试计划'));
  await expect(dialog.locator('.automation-policy').filter({hasText:'每日开场'})).toContainText('今日 1 / 1 次');
  await tick('member-chat');assert.equal(calls.length,3);assert.ok(calls[1].run.input.includes('不是真实发生的事'));assert.ok(calls[2].run.input.includes('自然收尾'));
  await expect(dialog.locator('.automation-policy').filter({hasText:'成员闲聊'})).toContainText('今日 2 / 4 次');
  await page.screenshot({path:path.join(output,'daily-life-1360.png'),animations:'disabled'});await page.setViewportSize({width:1100,height:750});await page.screenshot({path:path.join(output,'daily-life-1100.png'),animations:'disabled'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await dialog.getByRole('button',{name:'暂停定时任务',exact:true}).click();await wait(()=>engine.snapshot().automation.paused);await tick('member-chat');assert.equal(calls.length,3);await dialog.getByRole('button',{name:'恢复定时任务',exact:true}).click();await wait(()=>!engine.snapshot().automation.paused);
  await engine.invoke('internal.room.opened',{visible:false});await tick('member-chat');assert.equal(calls.length,3);await engine.invoke('internal.room.opened',{visible:true});await tick('member-chat');assert.equal(calls.length,5);await tick('member-chat');assert.equal(calls.length,5);
  await expect(dialog.locator('.automation-policy').filter({hasText:'成员闲聊'})).toContainText('今日 4 / 4 次');
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();await page.locator('.room-entry').filter({hasText:'茶歇室'}).click();await expect(page.locator('.room-messages')).toContainText('早上好');await expect(page.locator('.room-messages')).toContainText('等主人有空再说');
  const messages=engine.snapshot().room.messages.filter(message=>message.automatic);assert.equal(messages.length,5);assert.ok(messages.every(message=>message.runId&&message.automatic.reservationId));assert.deepEqual(errors,[]);
  console.log('Daily-life UI passed: default-off switches, next-day first opening, finite two-member chat, budget receipts, fictional settings, pause, hidden window and 1100px layout.');
}finally{await engine.close();await publish;await browser.close();await server.close();assert.ok(path.basename(directory).startsWith('AIROOM daily-life-ui-'));await rm(directory,{recursive:true,force:true});}
