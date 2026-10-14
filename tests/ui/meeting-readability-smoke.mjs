import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium,expect} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {Engine} from '../helpers/seeded-engine.ts';

const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM readable-meeting-'));
const output=path.resolve('.test-cache/ui-meeting-readability');await mkdir(output,{recursive:true});
const engine=new Engine(directory,()=>{},()=>{},id=>({
  probe:async()=>({id,name:id,available:true,auth:'subscription',detail:'fixture',capabilities:{steer:false,cancel:'native',streaming:true,write:false,history:true}}),
  stop:async()=>{},start:async(ctx,prompt)=>{
    if(id==='claude')throw Error('AIROOM 组装的消息超过本地输入上限，消息尚未发送。');
    const input=JSON.parse(prompt.split('\nAIROOM_CONTEXT\n')[1]);ctx.markDelivery('confirmed');
    ctx.emit('delta',JSON.stringify({version:1,turn:input.turn,revision:input.revision,action:'speak',body:JSON.stringify({concept:'共同协作',storyboard:[{description:'一起完成成果'}]})}));return {};
  },
}));
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1100,height:850}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
try{
  await engine.probe();await engine.invoke('room.send',{mode:'discuss',text:'各自说明怎么一起完成成果',memberIds:['claude','codex'],maxCalls:6});
  for(let i=0;engine.store.roomState().active&&i<500;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(engine.store.roomState().active,false);
  await page.exposeFunction('__rpc',async(method,params)=>['window.attention','window.show','renderer.error'].includes(method)?{}:engine.invoke(method,params));
  await page.addInitScript(()=>{window.airoom={invoke:(method,params)=>window.__rpc(method,params),onEvent:()=>()=>{}};});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.locator('.room-entry').filter({hasText:'茶歇室'}).click();
  await expect(page.locator('.room-failed').filter({hasText:'未发送'})).toBeVisible();
  await expect(page.locator('.room-messages')).toContainText('共同协作');
  await expect(page.locator('.room-messages')).toContainText('一起完成成果');
  await expect(page.locator('.room-messages')).not.toContainText('"storyboard"');
  await expect(page.locator('.room-messages')).not.toContainText('没能说完');
  const exported=await engine.invoke('room.export',{});assert.match(exported.content,/共同协作/);assert.doesNotMatch(exported.content,/"storyboard"|"turn"/);
  await page.screenshot({path:path.join(output,'readable-meeting-1100.png'),animations:'disabled'});assert.deepEqual(errors,[]);
  console.log('Meeting UI passed: unsent local failure, continued peer response, structured prose rendered as readable content, clean export.');
}finally{await browser.close();await server.close();await engine.close();await rm(directory,{recursive:true,force:true});}
