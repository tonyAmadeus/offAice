import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {Engine} from '../../src/backend/engine.ts';
import {catalogCandidate} from '../../src/backend/executor-catalog.ts';

const root=path.resolve('.test-cache/responsiveness-ui');await mkdir(root,{recursive:true});const data=await mkdtemp(path.join(root,'run-')),output=path.resolve('.test-cache/ui-responsiveness');await mkdir(output,{recursive:true});
const models=Array.from({length:132},(_,index)=>({id:'opencode-go/model-'+index,label:'Model '+index,efforts:[],isDefault:index===0}));
const engine=new Engine(data,()=>{},()=>{},id=>({probe:async()=>({id,name:id,path:process.execPath,available:true,auth:'account',detail:'fixture',modelOptions:id==='acp-catalogopencode'?models:[],capabilities:{steer:false,cancel:'native',streaming:true,write:false,history:true}}),start:async()=>assert.fail('No model request allowed'),stop:async()=>{}}));
engine.store.put('executors','acp-catalogopencode',{...catalogCandidate('opencode',process.execPath),secretKeys:['OPENCODE_API_KEY']});await engine.probe();
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],calls=[];
let holdList=true,releaseList,pendingPolls=0,maxPendingPolls=0,pollCount=0;
const listGate=new Promise(resolve=>releaseList=()=>{holdList=false;resolve();});
page.on('pageerror',error=>errors.push(error.message));
await page.exposeFunction('rpc',async(method,params)=>{calls.push(method);
  if(['window.attention','window.show','renderer.error'].includes(method))return {};
  if(method==='catalog.list'&&holdList)await listGate;
  if(method==='executor.loginStatus'){pollCount++;pendingPolls++;maxPendingPolls=Math.max(maxPendingPolls,pendingPolls);try{await new Promise(resolve=>setTimeout(resolve,2100));if(pollCount===1)throw Error('读取登录状态未及时响应');return undefined;}finally{pendingPolls--;}}
  return engine.invoke(method,params);
});
await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:window.rpc,onEvent:fn=>{window.__listeners.push(fn);return()=>{};}};});
try{
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port);await page.getByRole('button',{name:'设置与连接',exact:true}).click();const dialog=page.getByRole('dialog',{name:'设置与成员连接'}),catalog=dialog.locator('.catalog-settings');
 const start=Date.now();if(!await catalog.getByRole('group',{name:'官方执行端清单'}).count())await catalog.getByRole('button',{name:'从清单添加',exact:true}).click();await expect(catalog.getByRole('group',{name:'官方执行端清单'}).getByRole('button')).toHaveCount(9);assert.ok(Date.now()-start<1500,'the catalog must render while its status request is still unresolved');await expect(catalog).toContainText('正在读取已安装版本');releaseList();await expect(catalog).not.toContainText('正在读取已安装版本');
 await catalog.getByRole('button',{name:/OpenCode/}).click();await expect(catalog.getByLabel('OpenCode 模型',{exact:true}).locator('option')).toHaveCount(134);await catalog.getByLabel('OpenCode 模型',{exact:true}).selectOption('opencode-go/model-131');
 const snapshots=calls.filter(method=>method==='snapshot').length;await expect(catalog).toContainText('登录状态暂未更新');await expect(page.locator('.toast.error')).toHaveCount(0);await page.waitForTimeout(3400);assert.equal(maxPendingPolls,1);assert.equal(calls.filter(method=>method==='snapshot').length,snapshots,'background status checks do not request full snapshots');
 await page.screenshot({path:path.join(output,'status-and-all-models.png')});const beforeSave=calls.filter(method=>method==='snapshot').length,saveStart=Date.now();await dialog.getByRole('button',{name:'保存设置',exact:true}).click();await expect(dialog).toHaveCount(0);assert.ok(Date.now()-saveStart<1500);assert.equal(calls.filter(method=>method==='snapshot').length,beforeSave,'save acknowledgement does not await another snapshot');assert.equal(engine.store.list('runs').length,0);assert.deepEqual(errors,[]);
 await writeFile(path.join(output,'result.json'),JSON.stringify({catalogRenderedBeforeReadCompleted:true,modelCount:models.length,maxConcurrentLoginStatus:1,backgroundTimeoutToast:false,saveDidNotReadSnapshot:true,modelRequests:0},null,2));console.log('Responsiveness UI passed: immediate catalog, all 132 provided models, serial status polls, local timeout notice and immediate settings acknowledgement. No model requests.');
}catch(error){await page.screenshot({path:path.join(output,'failure.png')});throw error;}finally{releaseList?.();await browser.close();await server.close();await engine.close();assert.equal(path.dirname(data),root);await rm(data,{recursive:true,force:true});}
