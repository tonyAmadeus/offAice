import '../../scripts/test-bootstrap.mjs';
// Real Engine + renderer: the pending-items entry lists what waits on the user and only navigates.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium, expect } from '@playwright/test';
import { createServer } from '../../scripts/ui-test-server.mjs';
import { Engine } from '../helpers/seeded-engine.ts'; // Scenarios opt into the built-in team; production starts empty.

const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM attention-ui-')),source=path.join(directory,'project');await mkdir(source);await writeFile(path.join(source,'file.txt'),'baseline');
const output=path.resolve('.test-cache/ui-attention');await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1360,height:900}});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const ready=id=>({id,name:id,available:true,auth:id==='dsh'?'account':'subscription',detail:'fixture',capabilities:{steer:false,cancel:'native',streaming:true,write:true,history:true}});
let publish=Promise.resolve(),starts=0;
const engine=new Engine(path.join(directory,'data'),event=>{publish=publish.then(()=>page.evaluate(event=>window.__listeners?.forEach(fn=>fn(event)),event)).catch(()=>{});},()=>{},id=>({
  // DeepSeek is signed out: the entry asks for a login without probing anything itself.
  probe:async()=>id==='dsh'?{...ready(id),available:false,auth:'none',detail:'未登录'}:ready(id),
  start:async ctx=>{
    starts++;ctx.markDelivery('confirmed');
    if(ctx.run.input==='改文件')await writeFile(path.join(ctx.cwd,'file.txt'),'changed by the member');
    ctx.emit('message',ctx.run.input==='改文件'?'文件已改好。':'1+1 等于 2。',{source:'assistant'});return {};
  },stop:async()=>{},
}));
const idle=async id=>{for(let i=0;i<300;i++){if(engine.store.get('runs',id)?.status==='ended')return;await new Promise(r=>setTimeout(r,10));}assert.fail('run did not complete');};
try{
  for(const id of ['claude','codex','dsh'])await engine.invoke('provider.probe',{provider:id});
  const project=await engine.invoke('project.create',{directory:source,name:'待处理项目'});
  const changed=engine.createSession(project.id,'claude','改文件的任务',true),answered=engine.createSession(project.id,'codex','只回答的任务',true);
  const first=await engine.invoke('room.handoff',{projectId:project.id,sessionId:changed.id,text:'改文件'});await idle(first.runId);
  const second=await engine.invoke('room.handoff',{projectId:project.id,sessionId:answered.id,text:'只回答'});await idle(second.runId);
  // A meeting waits on the user's answer to a member's question.
  const threadId=engine.store.currentRoomThread().id,at=new Date().toISOString();
  for(let i=0;i<30;i++)engine.store.put('room_messages',`filler-${i}`,{id:`filler-${i}`,threadId,author:'codex',text:`较早的发言 ${i}`,at:new Date(Date.now()-60_000+i).toISOString(),status:'done'});
  engine.store.put('room_messages','question-message',{id:'question-message',threadId,author:'codex',text:'周末去公园还是博物馆？',at,status:'done'});
  engine.store.put('room','state',{...engine.store.roomState(),mode:'discuss',discussion:{id:'meeting',style:'work',phase:'waiting_user',members:['claude','codex'],questions:[{id:'q1',from:'codex',to:'user',text:'周末去公园还是博物馆？',messageId:'question-message'}],reviewRequired:[],calls:3,limit:0,minutes:0,reason:'等你回答 Gptia 的问题。'}});
  const before=starts;
  await page.exposeFunction('__rpc',async(method,params)=>{if(['window.attention','window.show','renderer.error'].includes(method))return {};const result=await engine.invoke(method,params);if(method==='snapshot')result.providers=result.providers.map(p=>p.id==='dsh'?p:ready(p.id));return result;});
  await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:(method,params)=>window.__rpc(method,params),onEvent:fn=>{window.__listeners.push(fn);return ()=>{window.__listeners=window.__listeners.filter(item=>item!==fn);};}};});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);

  // D1: an idle member's line follows the time of day instead of a flat "空闲中".
  await expect(page.locator('.roster-row.member-claude .roster-text small').first()).toHaveText(/^空闲 · \S/);
  const entry=page.getByRole('button',{name:/待你处理/});
  await expect(entry.locator('.attention-count')).toHaveText('3');
  await expect(entry).toContainText('1 项等你回答 · 1 项需要登录 · 1 项待验收');
  await expect(page.getByText('旧会话与全部历史',{exact:true})).toHaveCount(0);
  await entry.click();const panel=page.getByRole('dialog',{name:'待你处理'});
  await expect(panel.getByRole('region',{name:'等你回答'})).toContainText('周末去公园还是博物馆？');
  await expect(panel.getByRole('region',{name:'待验收'})).toContainText('改文件');
  await expect(panel).not.toContainText('只回答','an answer that changed no files has nothing to accept');
  await page.screenshot({path:path.join(output,'attention-panel-1360.png'),animations:'disabled'});
  // Escape closes; nothing was started by opening or reading the list.
  await page.keyboard.press('Escape');await expect(panel).toHaveCount(0);

  await entry.click();await panel.getByRole('button',{name:'核对并验收',exact:true}).click();await expect(panel).toHaveCount(0);
  await expect(page.getByRole('log',{name:'茶歇室消息'})).toContainText('文件已改好。');await expect(page.getByRole('button',{name:'通过',exact:true}).first()).toBeVisible();

  await entry.click();await panel.getByRole('button',{name:'回答聊天室问题',exact:true}).click();
  const asked=page.locator('[data-message-id="question-message"]');await expect(asked).toHaveClass(/focus-flash/);await expect(asked).toBeInViewport();

  await entry.click();await panel.getByRole('button',{name:'去登录',exact:true}).click();
  await page.locator('[data-provider="dsh"].focus-flash').waitFor();await page.getByRole('button',{name:'关闭对话框'}).click();

  await page.setViewportSize({width:1100,height:750});await entry.click();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal scroll at 1100px');
  const box=await panel.boundingBox();assert.ok(box&&box.x+box.width<=1100&&box.y+box.height<=750,'the panel stays inside the window');
  await page.screenshot({path:path.join(output,'attention-panel-1100.png'),animations:'disabled'});
  await page.mouse.click(1000,700);await expect(panel).toHaveCount(0);

  // Kinds a later backend adds (G0 §8) still show: a known label for decision cards, a plain heading for anything unknown.
  const later=engine.snapshot();const extra=[{id:'decision:x',kind:'decision',title:'Gptia 可以提前开工吗',detail:'第 2 轮已复核',at:new Date().toISOString(),projectId:project.id,action:{view:'project-room',label:'去决定'}},{id:'future:x',kind:'future-kind',title:'新的事项',detail:'',at:new Date().toISOString(),action:{view:'session',label:'查看'}}];
  later.attention={...later.attention,items:[...later.attention.items,...extra],total:later.attention.total+2};
  await page.evaluate(snapshot=>window.__listeners.forEach(fn=>fn({type:'snapshot',snapshot})),later);
  await expect(entry.locator('.attention-count')).toHaveText('5');await expect(entry).toContainText('1 项等你决定');await expect(entry).toContainText('1 项其他事项');
  await entry.click();await expect(panel.getByRole('region',{name:'等你决定'})).toContainText('Gptia 可以提前开工吗');await expect(panel.getByRole('region',{name:'其他事项'})).toContainText('新的事项');
  await panel.getByRole('button',{name:'去决定',exact:true}).click();await expect(page.locator('.project-item.selected')).toContainText('待处理项目');
  // Ignoring hides only this notice, keeps the panel open, and persists after reopening the app.
  await entry.click();await panel.getByRole('region',{name:'需要登录'}).getByRole('button',{name:'忽略',exact:true}).click();
  await expect(entry.locator('.attention-count')).toHaveText('2');await expect(panel).toBeVisible();await expect(panel.getByRole('region',{name:'需要登录'})).toHaveCount(0);
  assert.equal(engine.store.list('attention_dismissals').length,1);assert.equal(engine.snapshot().providers.find(p=>p.id==='dsh').auth,'none','ignore does not log in or rewrite auth');
  await page.reload();await expect(entry.locator('.attention-count')).toHaveText('2');await entry.click();await expect(panel.getByRole('button',{name:'忽略',exact:true})).toHaveCount(2);
  await page.screenshot({path:path.join(output,'attention-ignore-persisted-1100.png'),animations:'disabled'});
  assert.equal(starts,before,'opening pending items never starts, resends or accepts anything');
  assert.equal(engine.store.get('runs',first.runId).status,'ended');
  assert.deepEqual(errors,[]);
  console.log('Attention UI passed: fixed entry count and summary, grouped panel, answers excluded from acceptance, session/room message/login navigation without side effects, Escape and outside close, 1100px layout.');
}finally{await engine.close();await publish;await browser.close();await server.close();await rm(directory,{recursive:true,force:true});}
