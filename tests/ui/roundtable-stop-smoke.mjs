import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {roundtableHarness} from '../helpers/roundtable-harness.ts';

const output=path.resolve('.test-cache/ui-roundtable-stop');await mkdir(output,{recursive:true});
const h=await roundtableHarness({handler:async c=>{if(c.kind==='joint-independent')await new Promise(r=>c.release=r);}});
const artifacts=h.engine.projectFlow.artifacts,originalCapture=artifacts.capture;
let release,entered,held=false;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
artifacts.capture=async function(record,root,kind,...args){if(!held&&kind==='base'&&record.projectId.startsWith('roundtable-')){held=true;entered();await gate;}return originalCapture.call(this,record,root,kind,...args);};
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1100,height:850}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.exposeFunction('rpc',async(method,params)=>['window.attention','window.show','renderer.error'].includes(method)?{}:h.engine.invoke(method,params));
await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:window.rpc,onEvent:fn=>{window.__listeners.push(fn);return()=>{};}};});
let publishing=true;const publish=(async()=>{while(publishing){await new Promise(r=>setTimeout(r,80));try{await page.evaluate(s=>window.__listeners?.forEach(fn=>fn({type:'snapshot',snapshot:s})),h.engine.snapshot());}catch{}}})();
try{
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port);await page.getByRole('button',{name:/^圆桌/}).click();const room=page.getByRole('main',{name:'圆桌',exact:true});
  await room.locator(':scope > .room-top').getByRole('button',{name:'开新议题',exact:true}).click();const form=page.getByRole('dialog',{name:'开圆桌议题'});
  await form.getByRole('combobox',{name:'圆桌议题类型'}).selectOption('proposals');await form.getByRole('textbox',{name:'圆桌议题名称'}).fill('可中止的材料准备');await form.getByRole('textbox',{name:'圆桌材料或要求'}).fill('各自提出活动策划方案');await form.getByRole('button',{name:'开始方案比较',exact:true}).click();await ready;
  await expect(form).toHaveCount(0);await expect(room).toContainText('准备材料');const preparing=h.engine.snapshot().roundtable.currentTopicId;
  const stop=room.getByRole('button',{name:'中止当前对话',exact:true});await expect(stop).toBeEnabled();await page.screenshot({path:path.join(output,'material-preparation-can-stop-1100.png'),animations:'disabled'});
  await stop.click();release();await h.wait(preparing,d=>d.topic.status==='reviewing');assert.equal(h.calls.length,0);assert.equal((await h.get(preparing)).review.review.dispatchMode,'paused');
  artifacts.capture=originalCapture;
  const first=await h.open({title:'当前议题',memberIds:['claude','dsh'],synthesizerId:'codex',peerReview:false});await h.wait(first.topic.id,()=>h.calls.filter(c=>c.ctx.run.projectId===first.topic.projectId).length===2);
  const other=await h.open({title:'另一议题',memberIds:['codex'],synthesizerId:'codex',peerReview:false});await h.wait(other.topic.id,()=>h.calls.some(c=>c.ctx.run.projectId===other.topic.projectId));
  await room.getByRole('combobox',{name:'圆桌议题记录'}).selectOption(first.topic.id);await expect(room).toContainText('各自准备中（0/2 完成）');await expect(stop).toBeEnabled();await stop.click();
  const blocked=await h.wait(first.topic.id,d=>d.review?.review.status==='blocked');await expect(room).toContainText('先核对已有记录');
  await expect(room).toContainText('需要核对');await expect(room.getByRole('button',{name:'继续评审',exact:true})).toBeDisabled();
  await expect(room.getByRole('alert').filter({hasText:blocked.review.review.error})).toHaveCount(1);
  assert.ok(h.calls.filter(c=>c.ctx.run.projectId===first.topic.projectId).every(c=>c.stopped));assert.equal(h.calls.find(c=>c.ctx.run.projectId===other.topic.projectId).stopped,false);
  const count=h.calls.length;await new Promise(r=>setTimeout(r,100));assert.equal(h.calls.length,count);await page.screenshot({path:path.join(output,'current-topic-stopped-peer-preserved-1100.png'),animations:'disabled'});assert.deepEqual(errors,[]);
  console.log('Roundtable stop UI passed: preparation can be stopped before dispatch; only the selected topic stops, and blocked receipts show one error with resume disabled until checked.');
}finally{release();artifacts.capture=originalCapture;for(const c of h.calls)c.release();publishing=false;await publish;await browser.close();await server.close();await h.dispose();}
