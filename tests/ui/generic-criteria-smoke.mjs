import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {harness,plan,passing} from '../helpers/project-flow-harness.ts';
import {memberCriteria} from '../../src/shared/project-flow-review.ts';

const output=path.resolve('.test-cache/ui-generic-criteria');await mkdir(output,{recursive:true});
const p=plan();p.tasks=p.tasks.slice(0,1);p.objective='形成一份研究说明';
p.acceptanceCriteria=[{text:'最终风格由主人确认',kind:'owner'}];
p.tasks[0].completionCriteria=['A 正确',{text:'论证结构清楚',kind:'judge'},{text:'颜色符合偏好',kind:'owner'}];
const sources=[{kind:'source',title:'本机资料',location:'a.txt:1',excerpt:'引用资料'},{kind:'source',title:'外部资料',location:'https://example.com/article',excerpt:'引用原文'}];
const h=await harness({plan:p,handler:async c=>{
  if(c.kind==='submission'){await writeFile(path.join(c.ctx.cwd,'a.txt'),'引用资料\n研究说明');return {summary:'说明已完成',completionResults:memberCriteria(c.material.task.completionCriteria).required.map(criterion=>({criterion,verified:true,evidence:'核对内容'})),evidence:sources};}
  if(['review','integration-check'].includes(c.kind))return {...passing(c.material.criteria??c.material.task.completionCriteria),assessments:(c.material.judgedCriteria??[]).map(criterion=>({criterion,rating:'partly',reason:'结尾可以精简'})),strengths:['出处交代清楚'],evidence:sources};
}});
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1100,height:820}});
let publish=Promise.resolve();const errors=[],calls=[];page.on('pageerror',e=>errors.push(e.message));
h.engine.push=event=>{publish=publish.then(()=>page.evaluate(e=>window.__listeners?.forEach(fn=>fn(e)),event)).catch(()=>{});};
try{
  await page.exposeFunction('__rpc',async(method,params)=>{calls.push({method,params});if(['window.attention','window.show','renderer.error'].includes(method))return {};return h.engine.invoke(method,params);});
  await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:(m,p)=>window.__rpc(m,p),onEvent:fn=>{window.__listeners.push(fn);return ()=>{window.__listeners=window.__listeners.filter(f=>f!==fn);};}};});
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port);
  await page.locator('.project-item .list-row-main').first().click();
  const room=page.getByRole('main',{name:h.project.name+' 的项目会议室'});
  const planCard=room.getByRole('article',{name:'方案第 1 版'});
  await expect(planCard).toContainText('你来定');await expect(planCard).toContainText('成员评价');
  await planCard.getByRole('button',{name:'确认方案，开工'}).click();
  const product=room.getByRole('article',{name:'第 1 轮成品'});
  await expect(product).toContainText('需要你判断的几点',{timeout:20000});await expect(product).toContainText('颜色符合偏好');
  await expect(product).toContainText('成员的评价');await expect(product).toContainText('结尾可以精简');
  await expect(product).toContainText('出处交代清楚');await expect(product).toContainText('未核实来源');await expect(product).toContainText('已核对本机原文');
  await expect(product.getByRole('link',{name:'外部资料'})).toHaveAttribute('href','https://example.com/article');
  const before=h.calls.length;await product.getByRole('button',{name:'本机资料',exact:true}).click();
  await expect(product.locator('pre')).toContainText('引用资料');
  assert.equal(h.calls.length,before,'opening saved sources never invokes a model');
  await expect(product.getByRole('button',{name:'通过',exact:true})).toBeEnabled();
  await page.screenshot({path:path.join(output,'generic-product-1100.png'),animations:'disabled'});
  await product.getByRole('button',{name:'通过',exact:true}).click();await h.wait(s=>s.flow?.status==='completed');
  assert.deepEqual(errors,[]);assert.ok(calls.some(c=>c.method==='projectFlow.artifact.read'));
  console.log('Generic criteria UI passed: mixed criteria, owner acceptance, member evaluations, strengths, honest external sources, saved local-source preview without new model calls.');
}finally{await h.dispose();await publish;await browser.close();await server.close();}
