import '../../scripts/test-bootstrap.mjs';
// Real Engine + renderer; deterministic adapters write only the test project's managed copy.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium, expect } from '@playwright/test';
import { createServer } from '../../scripts/ui-test-server.mjs';
import { Engine } from '../../src/backend/engine.ts';

const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM undo-quota-ui-')),source=path.join(directory,'project');await mkdir(source);await writeFile(path.join(source,'file.txt'),'baseline');
const output=path.resolve('.test-cache/ui-undo-quota');await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1360,height:900}});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const providers=['claude','codex','dsh'].map(id=>({id,name:id,available:true,auth:id==='dsh'?'account':'subscription',detail:'fixture',capabilities:{steer:false,cancel:'native',streaming:true,write:true,history:true}}));
let publish=Promise.resolve();
let balanceState='ready',balanceReads=0,quotaReads=0,quotaState='ready',codexQuotaReads=0,codexQuotaState='ready';
const engine=new Engine(path.join(directory,'data'),event=>{if(event.type==='snapshot')event.snapshot.providers=providers;publish=publish.then(()=>page.evaluate(event=>window.__listeners?.forEach(fn=>fn(event)),event)).catch(()=>{});},()=>{},id=>({
  probe:async()=>({...providers.find(p=>p.id===id),...(id==='codex'?{quota:{rateLimits:{primary:{usedPercent:55,windowDurationMins:300},secondary:{usedPercent:91,windowDurationMins:10080}}},quotaCheckedAt:new Date().toISOString()}:{} )}),
  accountBalance:async()=>{balanceReads++;if(balanceState==='failed')throw Error('fixture balance unavailable');return {status:'ready',wallets:[{currency:'CNY',balance:balanceState==='zero'?'0.004':'12.34567890123456789'}],bonusWallets:[{currency:'USD',balance:balanceState==='zero'?'0E-16':'0.50000000000000000'}],checkedAt:new Date().toISOString()};},
  accountQuota:async()=>{if(id==='codex'){codexQuotaReads++;return {payload:{accountRateLimits:codexQuotaState==='ready'?{rateLimits:{primary:{usedPercent:31,windowDurationMins:300},secondary:{usedPercent:7,windowDurationMins:10080}}}:null},checkedAt:new Date().toISOString()};}quotaReads++;return {payload:{accountUsage:quotaState==='ready'?{rate_limits:{limits:[{kind:'session',percent:3},{kind:'weekly_all',percent:5}]}}:null},checkedAt:new Date().toISOString()};},
  start:async ctx=>{
    ctx.markDelivery('confirmed');
    if(ctx.run.input==='first')await writeFile(path.join(ctx.cwd,'earlier.txt'),'earlier round');
    if(ctx.run.input==='second')await writeFile(path.join(ctx.cwd,'file.txt'),'second round');
    ctx.emit('status','quota',{rateLimit:{status:'allowed',rateLimitType:'five_hour',unifiedWindows:{five_hour:{utilization:.82,resetsAt:Math.floor(Date.now()/1000)+3600},seven_day:{utilization:.10,resetsAt:Math.floor(Date.now()/1000)+86400}}}});
    ctx.emit('message',ctx.run.input==='second'?'第二轮文件已改动。':'第一轮文件已改动。',{source:'assistant'});return {};
  },stop:async()=>{},
}));
const idle=async id=>{for(let i=0;i<300;i++){if(engine.store.get('runs',id)?.status==='ended')return;await new Promise(r=>setTimeout(r,10));}assert.fail('run did not complete');};
try{
  await engine.invoke('provider.probe',{provider:'codex'});
  const project=await engine.invoke('project.create',{directory:source,name:'撤销验收项目'}),session=engine.createSession(project.id,'claude','撤销验收',true);
  const first=await engine.invoke('room.handoff',{projectId:project.id,sessionId:session.id,text:'first'});await idle(first.runId);
  const second=await engine.invoke('room.handoff',{projectId:project.id,sessionId:session.id,text:'second'});await idle(second.runId);
  const workspace=engine.store.get('sessions',session.id).workspace;
  await page.exposeFunction('__rpc',async(method,params)=>{if(['window.attention','window.show','renderer.error'].includes(method))return {};const result=await engine.invoke(method,params);if(method==='snapshot')result.providers=providers;return result;});
  await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:(method,params)=>window.__rpc(method,params),onEvent:fn=>{window.__listeners.push(fn);return ()=>{window.__listeners=window.__listeners.filter(item=>item!==fn);};}};});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await expect(page.locator('.roster-row.member-claude .quota-badge')).toHaveAttribute('title',/剩 18%/);
  await page.getByRole('button',{name:'用量与额度',exact:true}).click();
  let dialog=page.getByRole('dialog',{name:'用量与额度'});await expect(dialog).toContainText('已用 82%');await expect(dialog).toContainText('已用 10%');await expect(dialog).toContainText('已用 91%');await expect(dialog).toContainText('账户余额：未提供');
  const claudeCard=dialog.getByRole('region',{name:'Claudia 的额度'}),codexCard=dialog.getByRole('region',{name:'Gptia 的额度'});
  await claudeCard.getByRole('button',{name:'刷新额度',exact:true}).click();await expect(claudeCard).toContainText('已用 3%');await expect(claudeCard).toContainText('已用 5%');assert.equal(quotaReads,1);
  quotaState='failed';await claudeCard.getByRole('button',{name:'刷新额度',exact:true}).click();await expect(claudeCard).toContainText('暂未提供订阅额度数据');await expect(claudeCard).not.toContainText('已用 3%');quotaState='ready';await claudeCard.getByRole('button',{name:'刷新额度',exact:true}).click();await expect(claudeCard).toContainText('已用 3%');assert.equal(quotaReads,3);
  await codexCard.getByRole('button',{name:'刷新额度',exact:true}).click();await expect(codexCard).toContainText('已用 31%');await expect(codexCard).toContainText('已用 7%');assert.equal(codexQuotaReads,1);assert.equal(quotaReads,3,'Gptia refresh must not query Claudia');
  codexQuotaState='failed';await codexCard.getByRole('button',{name:'刷新额度',exact:true}).click();await expect(codexCard).toContainText('Gptia 暂未提供订阅额度数据');await expect(codexCard).not.toContainText('已用 31%');await expect(claudeCard).toContainText('已用 3%');
  codexQuotaState='ready';await codexCard.getByRole('button',{name:'刷新额度',exact:true}).click();await expect(codexCard).toContainText('已用 31%');assert.equal(codexQuotaReads,3);
  await dialog.getByRole('button',{name:'刷新余额',exact:true}).click();await expect(dialog.locator('.balance-detail')).toContainText('¥12.35');await expect(dialog.locator('.balance-detail')).toContainText('US$0.5');assert.equal(balanceReads,1);
  const dshCard=dialog.locator('.quota-card:has(.balance-detail)');await expect(dshCard.locator('.quota-track')).toHaveCount(0);await expect(dshCard).not.toContainText('5 小时');
  await page.screenshot({path:path.join(output,'quota-overview-1360.png'),animations:'disabled'});
  await page.setViewportSize({width:1100,height:750});await page.screenshot({path:path.join(output,'balance-overview-1100.png'),animations:'disabled'});await page.setViewportSize({width:1360,height:900});
  balanceState='zero';await dialog.getByRole('button',{name:'刷新余额',exact:true}).click();await expect(dialog.locator('.balance-detail')).toContainText('余额已耗尽，自动发言已暂停');await expect(dialog.locator('.balance-wallet strong').first()).toHaveText('¥0.00');
  balanceState='failed';await dialog.getByRole('button',{name:'刷新余额',exact:true}).click();await expect(dialog.locator('.balance-detail')).toContainText('账户余额：未提供');await expect(dialog.locator('.balance-wallet')).toHaveCount(0);await expect(dialog).not.toContainText('余额已耗尽');assert.equal(balanceReads,3);
  balanceState='ready';await dialog.getByRole('button',{name:'刷新余额',exact:true}).click();await expect(dialog.locator('.balance-detail')).toContainText('¥12.35');
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();await expect(page.locator('.roster-row.member-dsh .quota-badge.balance')).toHaveAttribute('title',/充值余额.*赠送余额/);
  await page.getByRole('button',{name:'Claudia 的工位',exact:true}).click();await page.getByRole('button',{name:'切换工位文件夹'}).click();await page.getByRole('dialog',{name:'切换工位文件夹'}).getByRole('button',{name:'切换到 '+project.name,exact:true}).click();await page.getByRole('button',{name:'话题工作副本操作'}).click();
  await expect(page.getByRole('menuitem',{name:'撤销最近一轮',exact:true})).toBeEnabled();
  await writeFile(path.join(workspace,'file.txt'),'later human edit');await page.getByRole('menuitem',{name:'撤销最近一轮',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'撤销最近一轮'});await expect(dialog).toContainText('检测到后续改动');await expect(dialog.getByRole('button',{name:'撤销本轮改动'})).toBeDisabled();await page.screenshot({path:path.join(output,'undo-conflict.png'),animations:'disabled'});await dialog.getByRole('button',{name:'取消'}).click();
  await writeFile(path.join(workspace,'file.txt'),'second round');await page.getByRole('button',{name:'话题工作副本操作'}).click();await page.getByRole('menuitem',{name:'撤销最近一轮',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'撤销最近一轮'});await expect(dialog).toContainText(second.runId);await expect(dialog).toContainText('file.txt');await expect(dialog.getByRole('button',{name:'撤销本轮改动'})).toBeEnabled();await page.screenshot({path:path.join(output,'undo-preview.png'),animations:'disabled'});await dialog.getByRole('button',{name:'撤销本轮改动'}).click();await expect(dialog).toHaveCount(0);
  assert.equal(await readFile(path.join(workspace,'file.txt'),'utf8'),'baseline');assert.equal(await readFile(path.join(workspace,'earlier.txt'),'utf8'),'earlier round');assert.equal(await readFile(path.join(source,'file.txt'),'utf8'),'baseline');
  await expect(page.getByRole('main',{name:'个人工位'}).getByRole('status')).toContainText('本轮文件改动已撤销');
  const notes=engine.store.list('room_messages');
  assert.ok(notes.filter(note=>note.link?.runId===second.runId).every(note=>note.link.undoneAt));
  assert.ok(notes.filter(note=>note.link?.runId===first.runId).every(note=>!note.link.undoneAt));
  // The handoff note, result report and undo report all refer to this exact round.
  await page.locator('.room-entry').filter({hasText:'茶歇室'}).click();await expect(page.locator('.room-note-verdict').filter({hasText:'对应轮次的文件改动已撤销'})).toHaveCount(3);
  await page.setViewportSize({width:1100,height:750});await page.screenshot({path:path.join(output,'room-undo-quota-1100.png'),animations:'disabled'});
  assert.deepEqual(errors,[]);console.log('Undo/quotas/balance UI passed: actual file restoration, conflict blocking, older-round preservation, precise wallet display, refresh, zero/failed balances and exact-run report state.');
}finally{
  await engine.close();await publish;await browser.close();await server.close();assert.ok(path.basename(directory).startsWith('AIROOM undo-quota-ui-'));await rm(directory,{recursive:true,force:true});
}
