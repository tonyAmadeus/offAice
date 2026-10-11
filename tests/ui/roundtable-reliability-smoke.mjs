import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {roundtableHarness} from '../helpers/roundtable-harness.ts';

const output=path.resolve('.test-cache/ui-roundtable-reliability');await mkdir(output,{recursive:true});
const h=await roundtableHarness(),first=(await h.open({title:'保留的议题'})).topic;await h.act(first.id,'end');
const removed=(await h.open({title:'删除的议题'})).topic;await h.act(removed.id,'end');await h.wait(removed.id,()=>!h.engine.projectFlow.joint.busyFor(removed.reviewId));
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1100,height:850}}),errors=[],failures=[],calls=[];
let hold=false;const delayed=[];
page.on('pageerror',error=>errors.push(error.message));
await page.exposeFunction('rpc',async(method,params)=>{
  calls.push({method,params});
  if(['window.attention','window.show','renderer.error'].includes(method))return {};
  if(hold&&(method==='roundtable.get'&&params.topicId===removed.id||method==='room.get'&&params.roomId===removed.roomId))await new Promise(resolve=>delayed.push(resolve));
  try{const result=await h.engine.invoke(method,params);if(method==='roundtable.delete')await new Promise(resolve=>setTimeout(resolve,450));return result;}catch(error){failures.push({method,error:error.message});throw error;}
});
await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:window.rpc,onEvent:fn=>{window.__listeners.push(fn);return()=>{};}};});
let publishing=true;const publish=(async()=>{while(publishing){await new Promise(resolve=>setTimeout(resolve,80));try{await page.evaluate(snapshot=>window.__listeners?.forEach(fn=>fn({type:'snapshot',snapshot})),h.engine.snapshot());}catch{}}})();
async function removeCurrent(){await page.getByRole('button',{name:'圆桌议题操作'}).click();await page.getByRole('menuitem',{name:'议题管理'}).click();await page.getByRole('dialog',{name:'圆桌议题管理'}).getByRole('button',{name:'删除',exact:true}).click();await page.getByRole('dialog',{name:'删除圆桌议题'}).getByRole('button',{name:'确认删除',exact:true}).click();}
try{
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port);await page.getByRole('button',{name:/^圆桌/}).click();const room=page.getByRole('main',{name:'圆桌',exact:true});
  await expect(room.getByRole('combobox',{name:'圆桌议题记录'})).toHaveValue(removed.id);await expect(room.getByRole('button',{name:'圆桌议题操作'})).toBeEnabled();
  hold=true;const state=h.engine.store.roomState(removed.roomId);h.engine.store.put('room_states',removed.roomId,{...state,revision:(state.revision??0)+1});h.engine.broadcast();await expect.poll(()=>delayed.length).toBeGreaterThan(0);
  // Removing owned workspaces is real disk I/O; delayed view reads stay held throughout cleanup.
  await removeCurrent();await expect.poll(()=>h.engine.store.get('roundtable_topics',removed.id),{timeout:15000}).toBeUndefined();hold=false;for(const resolve of delayed.splice(0))resolve();
  await expect(page.getByRole('dialog',{name:'删除圆桌议题'})).toHaveCount(0);await expect(room.getByRole('combobox',{name:'圆桌议题记录'})).toHaveValue(first.id);await expect(room.getByRole('button',{name:'圆桌议题操作'})).toBeEnabled();
  await expect(page.getByText(/议题不存在/)).toHaveCount(0);assert.deepEqual(failures,[]);await page.screenshot({path:path.join(output,'delete-race-next-topic.png')});
  await removeCurrent();await expect(page.getByRole('dialog',{name:'删除圆桌议题'})).toHaveCount(0);await expect(room).toContainText('开一个独立议题');await expect(page.getByText(/议题不存在/)).toHaveCount(0);assert.equal(h.engine.snapshot().roundtable.topics.length,0);assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);
  await page.screenshot({path:path.join(output,'delete-last-topic.png')});console.log('Roundtable deletion UI passed: delayed topic/room reads arrive after deletion, snapshot precedes delete acknowledgement, next topic and empty state appear without a false error. No real model calls.');
}catch(error){console.error('Roundtable deletion UI failure:',JSON.stringify({calls,failures,topics:h.engine.snapshot().roundtable}));await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw error;}finally{hold=false;for(const resolve of delayed)resolve();publishing=false;await publish;await browser.close();await server.close();await h.dispose();}
