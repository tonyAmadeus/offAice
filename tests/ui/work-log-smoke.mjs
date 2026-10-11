import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {harness,plan} from '../helpers/project-flow-harness.ts';

const output=path.resolve('.test-cache/ui-work-log');await mkdir(output,{recursive:true});
const p=plan();p.tasks=p.tasks.slice(0,1);
const h=await harness({plan:p,handler:async c=>{
  if(c.kind==='submission'){
    c.ctx.emit('tool','查看 a.txt',{toolCallId:'read-a',status:'in_progress',rawInput:{command:'Get-Content a.txt'}},'native');
    c.ctx.emit('tool','已读取文件内容',{toolCallId:'read-a',status:'completed'},'native');
    for(let i=0;i<95;i++)c.ctx.emit('tool','日志检查 '+i,{toolCallId:'row-'+i,status:'completed'},'native');
  }
}});
const ordinary=h.engine.createSession(h.project.id,'codex','自己的历史对话',false);
const hidden=h.engine.createSession(h.project.id,'codex','点名后台记录',false);h.engine.store.put('sessions',hidden.id,{...hidden,purpose:'room-mention',roomId:`project:${h.project.id}`});
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1100,height:750}});
const errors=[],saved=[];let publish=Promise.resolve();page.on('pageerror',e=>errors.push(e.message));
await page.exposeFunction('__rpc',async(method,params)=>{if(['window.attention','window.show','renderer.error'].includes(method))return {};if(method==='file.save'){saved.push(params);return {saved:true,path:'selected-work-log.md'};}return h.engine.invoke(method,params);});
await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:(m,p)=>window.__rpc(m,p),onEvent:f=>{window.__listeners.push(f);return()=>{window.__listeners=window.__listeners.filter(x=>x!==f);};}};});
h.engine.push=e=>{publish=publish.then(()=>page.evaluate(e=>window.__listeners?.forEach(f=>f(e)),e)).catch(()=>{});};
try{
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);await page.locator('.project-item .list-row-main').first().click();
  const room=page.getByRole('main',{name:`${h.project.name} 的项目会议室`});await expect(room).toBeVisible();
  await expect(page.getByText('旧会话与全部历史',{exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Gptia 的工位',exact:true}).click();
  await page.getByRole('button',{name:'切换工位文件夹'}).click();await page.getByRole('dialog',{name:'切换工位文件夹'}).getByRole('button',{name:'切换到 '+h.project.name,exact:true}).click();await expect(page.getByLabel('话题记录')).toContainText(ordinary.title);await expect(page.getByLabel('话题记录')).not.toContainText(hidden.title);await page.getByRole('button',{name:h.project.name,exact:true}).click();
  await room.getByRole('button',{name:'确认方案，开工'}).click();await expect(room.getByRole('article',{name:'第 1 轮成品'})).toContainText('本轮汇总',{timeout:20000});
  await room.getByRole('button',{name:'任务：A',exact:true}).click();await room.getByRole('button',{name:'看工作日志',exact:true}).click();
  let log=page.getByRole('dialog',{name:'工作日志'});await expect(log).toBeVisible();await expect(log).toContainText('Get-Content a.txt');await expect(log).toContainText('原生记录已完成 · 退出码：未知');
  await expect(log.getByRole('checkbox')).not.toBeChecked();const calls=h.calls.length;
  await log.getByRole('button',{name:'读取更多日志'}).click();await expect(log).toContainText('日志检查 94');
  await log.getByRole('button',{name:'导出 Markdown'}).click();await expect(log).toContainText('工作日志已导出');assert.match(saved[0].content,/日志检查 94/);assert.equal(h.calls.length,calls);
  await log.getByRole('checkbox').check();await expect.poll(()=>h.engine.store.get('projects',h.project.id).writeWorkLogs).toBe(true);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,'task-log-1100.png'),animations:'disabled'});
  await log.getByRole('button',{name:'关闭日志'}).click();
  await mkdir(path.join(h.source,'.airoom'));await writeFile(path.join(h.source,'.airoom','logs'),'user-owned file');
  await h.accept();await h.wait(s=>s.flow?.status==='completed');
  await expect(room.getByText('成果已经验收，工作日志保存失败。',{exact:false})).toBeVisible({timeout:20000});
  await room.getByRole('button',{name:'查看日志并重试'}).click();log=page.getByRole('dialog',{name:'工作日志'});
  await expect(log).toContainText('日志保存失败');await expect(log.getByRole('button',{name:'保存到项目日志'})).toBeVisible();
  await page.screenshot({path:path.join(output,'archive-failure-1100.png'),animations:'disabled'});
  const afterAcceptance=h.calls.length;await rm(path.join(h.source,'.airoom','logs'));
  await log.getByRole('button',{name:'保存到项目日志'}).click();await expect(log).toContainText('工作日志已保存在项目');assert.equal(h.calls.length,afterAcceptance);
  await page.screenshot({path:path.join(output,'round-archive-1100.png'),animations:'disabled'});
  await log.getByRole('button',{name:'关闭日志'}).click();await expect(room.getByRole('button',{name:'查看日志并重试'})).toHaveCount(0);
  await room.getByRole('button',{name:'看本轮工作日志'}).click();await expect(page.getByRole('dialog',{name:'工作日志'})).toContainText('第一轮');await page.keyboard.press('Escape');await expect(page.getByRole('dialog',{name:'工作日志'})).toHaveCount(0);
  assert.deepEqual(errors,[]);console.log('Work-log UI passed: task/round read-only logs, bounded paging, unknown exit codes, Markdown export, hidden internal sessions, opt-in archiving and independent failure/retry.');
}finally{await h.dispose();await publish;await browser.close();await server.close();}
