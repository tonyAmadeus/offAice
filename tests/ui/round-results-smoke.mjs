import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {harness,plan,passing,proof} from '../helpers/project-flow-harness.ts';

const output=path.resolve('.test-cache/ui-round-results');await mkdir(output,{recursive:true});
const p=plan();p.tasks=p.tasks.slice(0,1);p.tasks[0].allowedPaths=['a.txt','index.html'];
const h=await harness({plan:p,handler:async c=>{if(c.kind!=='submission')return;
  await writeFile(path.join(c.ctx.cwd,'a.txt'),'new-a');await writeFile(path.join(c.ctx.cwd,'index.html'),'<script>window.__resultScriptRan=true</script>');
  return {summary:'网页完成',userSummary:'页面文件已准备好，可以查看。',completionResults:passing(c.material.task.completionCriteria).criteriaResults,evidence:proof};}});
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1100,height:750}});
const errors=[],opened=[];let publish=Promise.resolve();page.on('pageerror',e=>errors.push(e.message));
await page.exposeFunction('__rpc',async(method,params)=>{if(['window.attention','window.show','renderer.error'].includes(method))return {};
  if(method==='project.openPath'){const validated=await h.engine.invoke(method,params);opened.push(validated);return {revealed:validated.mode==='reveal',opened:validated.mode==='open'};}
  return h.engine.invoke(method,params);});
await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:(m,p)=>window.__rpc(m,p),onEvent:f=>{window.__listeners.push(f);return()=>{window.__listeners=window.__listeners.filter(x=>x!==f);};}};});
h.engine.push=e=>{publish=publish.then(()=>page.evaluate(e=>window.__listeners?.forEach(f=>f(e)),e)).catch(()=>{});};
try{
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.locator('.project-item .list-row-main').first().click();
  const room=page.getByRole('main',{name:`${h.project.name} 的项目会议室`});await expect(room).toBeVisible();
  await room.getByRole('button',{name:'确认方案，开工'}).click();
  let card=room.getByRole('article',{name:'第 1 轮成品'});await expect(card).toContainText('本轮汇总',{timeout:20000});
  // The round waiting for the owner opens its product files by itself.
  await expect(card.getByRole('button',{name:'收起成果'})).toBeVisible();await expect(card).toContainText('本轮提交版本；项目当前文件另行查看。');await expect(card).toContainText('还没写入项目');
  assert.equal(await card.getByRole('button',{name:'查看项目当前文件 a.txt',exact:true}).count(),0);
  await card.getByRole('button',{name:'查看本轮版本 index.html',exact:true}).click();await expect(card.getByRole('region',{name:'文件预览 index.html'})).toContainText('<script>');assert.equal(await page.evaluate(()=>window.__resultScriptRan),undefined);
  await page.screenshot({path:path.join(output,'submitted-html-1100.png'),animations:'disabled'});
  await h.accept();await h.wait(s=>s.flow?.status==='completed');await writeFile(path.join(h.source,'a.txt'),'later-project-content');await publish;
  await room.getByRole('button',{name:/^收起会议待办/}).click();
  card=room.getByRole('article',{name:'第 1 轮 · 第一轮 · 汇报'});const heading=card.getByRole('button',{name:'第 1 轮 · 第一轮 · 汇报'});if(await heading.getAttribute('aria-expanded')!=='true')await heading.click();
  await card.getByRole('button',{name:'查看成果文件'}).click();await expect(card.getByRole('region',{name:'本轮成果'})).toContainText('已写入项目');
  await card.getByRole('button',{name:'查看项目当前文件 a.txt',exact:true}).click();await expect(card.getByRole('region',{name:'文件预览 a.txt'})).toContainText('later-project-content');await expect(card).toContainText('已有后续改动');
  await card.getByRole('button',{name:'查看本轮版本 a.txt',exact:true}).click();await expect(card.getByRole('region',{name:'文件预览 a.txt'})).toContainText('new-a');
  await card.getByRole('button',{name:'用默认程序打开 index.html',exact:true}).click();await expect(card.getByRole('alert')).toContainText('不会直接运行');assert.equal(opened.at(-1).mode,'reveal');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,'accepted-history-1100.png'),animations:'disabled'});
  assert.deepEqual(errors,[]);console.log('Round result UI passed: immutable history, current file drift, HTML code only, open action routing.');
}finally{await h.dispose();await publish;await browser.close();await server.close();}
