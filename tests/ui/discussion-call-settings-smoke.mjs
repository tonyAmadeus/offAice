import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {Engine} from '../../src/backend/engine.ts';
const root=path.resolve('.test-cache/call-settings');await mkdir(root,{recursive:true});const data=await mkdtemp(path.join(root,'run-'));
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
let engine;const factory=id=>({probe:async()=>({id,name:id,available:false,auth:'none',detail:'isolated',capabilities:{steer:false,cancel:'native',streaming:true,write:false,history:false}}),start:async()=>assert.fail('settings must not dispatch models'),stop:async()=>{}});
engine=new Engine(data,()=>{},()=>{},factory);
try{
  await page.exposeFunction('__invoke',(method,params)=>engine.invoke(method,params));
  await page.addInitScript(()=>{window.airoom={invoke:(m,p)=>window.__invoke(m,p),onEvent:()=>()=>{}};});
  const url=`http://127.0.0.1:${server.httpServer.address().port}`;
  async function open(){await page.goto(url);await page.getByRole('button',{name:'设置与连接',exact:true}).click();await page.getByRole('button',{name:'工作台',exact:true}).click();}
  await open();await expect(page.getByLabel('闲聊调用次数',{exact:true})).toHaveValue('unlimited');await expect(page.getByLabel('开会调用次数',{exact:true})).toHaveValue('per-member');
  await page.getByLabel('闲聊调用次数',{exact:true}).selectOption('custom');await page.getByLabel('闲聊自定义次数',{exact:true}).fill('12');
  await page.getByLabel('开会调用次数',{exact:true}).selectOption('custom');await page.getByLabel('开会自定义次数',{exact:true}).fill('0');
  await page.getByRole('button',{name:'保存设置',exact:true}).click();await expect(page.getByRole('dialog',{name:'设置与成员连接'})).toBeVisible();await expect(page.locator('.toast.error')).toContainText('1–1000');
  await page.getByLabel('开会自定义次数',{exact:true}).fill('9');await page.getByRole('button',{name:'保存设置',exact:true}).click();await expect(page.getByRole('dialog',{name:'设置与成员连接'})).toHaveCount(0);
  await engine.close();engine=new Engine(data,()=>{},()=>{},factory);assert.deepEqual(engine.settings.discussionCallLimits,{chat:{mode:'custom',calls:12},work:{mode:'custom',calls:9}});
  await open();await expect(page.getByLabel('闲聊自定义次数',{exact:true})).toHaveValue('12');await expect(page.getByLabel('开会自定义次数',{exact:true})).toHaveValue('9');
  await page.getByLabel('开会调用次数',{exact:true}).selectOption('unlimited');await page.getByRole('button',{name:'保存设置',exact:true}).click();await expect(page.getByRole('dialog',{name:'设置与成员连接'})).toHaveCount(0);assert.equal(engine.settings.discussionCallLimits.work.mode,'unlimited');
  await assert.rejects(engine.invoke('settings.save',{discussionCallLimits:{chat:{mode:'custom',calls:1.5},work:{mode:'unlimited',calls:8}}}),/整数/);
  assert.deepEqual(errors,[]);console.log('Discussion call settings UI passed: defaults, custom values, invalid-input feedback, restart persistence and unlimited. No model calls.');
}finally{await engine.close();await browser.close();await server.close();assert.equal(path.dirname(data),root);await rm(data,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
