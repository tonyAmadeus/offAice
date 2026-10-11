import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from '../../scripts/ui-test-server.mjs';
import { writeFile, unlink, mkdir } from 'node:fs/promises';

const entry=new URL('./member-version-status-entry.js',import.meta.url),html=new URL('./member-version-status-test.html',import.meta.url);
await writeFile(entry,`import React from 'react';import {createRoot} from 'react-dom/client';import {VersionPanel} from '/src/renderer/settings.tsx';import '/src/renderer/styles.css';
const root=createRoot(document.getElementById('root'));window.calls=[];window.selected=[];window.sequence=0;window.key=0;
window.state={member:'codex',packageName:'fixture',current:'0.160.1',baselineVersions:['0.160.0'],source:'airoom',activeVersion:'0.160.1',selectedPath:'C:/managed/codex.js',installed:['0.160.0','0.160.1'],connection:{state:'connected',detail:'connected'}};
const invoke=async(method,params)=>{window.calls.push({method,params});if(method==='member.installation')return structuredClone(window.state.installation);if(method==='member.versions'){const result=structuredClone(window.state);if(params.checkLatest)result.latest='0.161.0';if(window.holdNext){window.holdNext=false;return new Promise(resolve=>{window.release=()=>resolve(result);});}return result;}if(method==='member.install'){window.state={...window.state,current:params.version,activeVersion:params.version,installed:[...window.state.installed,params.version]};return structuredClone(window.state);}return structuredClone(window.state);};
window.render=(available=true)=>root.render(React.createElement(VersionPanel,{key:window.key,provider:'codex',info:{checkedAt:String(++window.sequence)},available,invoke,onInstall:()=>{},onSelectedPath:path=>window.selected.push(path)}));window.render(false);`);
await writeFile(html,'<div id="root" style="max-width:780px;padding:20px"></div><script type="module" src="./member-version-status-entry.js"></script>');
const server=await createServer({configFile:false,esbuild:{jsx:'automatic'},root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1000,height:700}}),errors=[];page.on('pageerror',error=>errors.push(error.message));let dialogs=0;page.on('dialog',async dialog=>{dialogs++;await dialog.dismiss();});
try{
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/ui/member-version-status-test.html`);await page.waitForFunction(()=>!!window.render);assert.equal(await page.evaluate(()=>window.calls.length),0,'startup must wait for the backend');
  await page.evaluate(()=>window.render());await page.getByText('连接检查通过',{exact:true}).waitFor();assert.equal(await page.getByText(/未验收|已验收/).count(),0);assert.equal(await page.getByText('本版本已成功使用',{exact:true}).count(),0);
  await page.getByRole('button',{name:'检查更新'}).click();await page.getByRole('button',{name:'更新到 0.161.0'}).click();await page.waitForFunction(()=>window.calls.some(c=>c.method==='member.install'));assert.equal(dialogs,0,'the update button already authorizes a candidate check');assert.equal(await page.evaluate(()=>window.selected.length),1);await page.getByText('连接检查通过',{exact:true}).waitFor();
  await page.evaluate(()=>{window.state.successfulUse={provider:'codex',identity:{path:'C:/managed/codex.js',digest:'fixture',version:'0.161.0',adapterVersion:'airoom.executor/2',protocol:'codex-app-server'},runId:'observed-run',completedAt:'2026-10-08T00:00:00Z',requestedConfig:{model:'observed',effort:'low',capturedAt:'2026-10-08T00:00:00Z',modelSource:'executor',effortSource:'executor'},effectiveConfig:{model:'observed',effort:'low',modelStatus:'reported',effortStatus:'reported',source:'native',at:'2026-10-08T00:00:00Z'}};window.render();});
  await page.getByText('本版本已成功使用',{exact:true}).waitFor();await page.getByText('版本诊断与使用记录',{exact:true}).click();await page.getByText(/兼容基线：0.160.0/).waitFor();await page.getByText(/实际：observed · low/).waitFor();
  await page.evaluate(()=>{window.state.lastRun={outcome:'failed',completedAt:'2026-10-08T01:00:00Z',error:'native rejection'};window.render();});await page.getByText('最近运行失败',{exact:true}).waitFor();await page.getByText('最近运行：native rejection',{exact:true}).waitFor();
  await page.evaluate(()=>{window.state.connection.checkedAt='2026-10-08T02:00:00Z';window.render();});await page.getByText('最近运行失败',{exact:true}).waitFor();await page.getByText('最近运行：native rejection',{exact:true}).waitFor();
  await page.evaluate(()=>{window.state.lastRun=undefined;window.render();});await page.getByText('本版本已成功使用',{exact:true}).waitFor();
  // A slow older request must not overwrite the newer failure shown in the same open modal.
  await page.evaluate(()=>{window.holdNext=true;window.render();});await page.waitForFunction(()=>!!window.release);
  await page.evaluate(()=>{window.state.connection={state:'failed',detail:'workspace routing discovery timed out'};window.render();});await page.getByText('连接检查未通过',{exact:true}).waitFor();await page.evaluate(()=>window.release());
  await page.getByText('workspace routing discovery timed out',{exact:true}).waitFor();assert.equal(await page.getByText('本版本已成功使用',{exact:true}).count(),0);await page.getByText(/本版本最近成功使用/).waitFor();
  await mkdir('.test-cache/ui-member-version-status',{recursive:true});await page.screenshot({path:'.test-cache/ui-member-version-status/failure-with-history.png'});
  await page.evaluate(()=>{window.state={...window.state,current:'0.162.0',connection:{state:'unchecked',detail:'等待检查'},successfulUse:undefined};window.render();});await page.getByText('待检查连接',{exact:true}).waitFor();assert.equal(await page.getByText(/本版本最近成功使用/).count(),0);
  // Reopening the settings reads the backend operation, even without a local install promise.
  await page.evaluate(()=>{const startedAt=new Date(Date.now()-120000).toISOString();window.state.installation={version:'0.163.0',phase:'installing',startedAt,phaseStartedAt:startedAt,writtenBytes:178*1024*1024,lastProgressAt:startedAt};window.key++;window.render();});
  await page.getByRole('status').filter({hasText:'已展开 178.0 MB'}).waitFor();await page.getByText(/文件暂时没有增长/).waitFor();assert.equal(await page.getByRole('button',{name:'检查更新'}).isDisabled(),true);
  await page.screenshot({path:'.test-cache/ui-member-version-status/installation-progress.png'});
  await page.evaluate(()=>{window.state.installation.phase='connection';});await page.getByRole('status').filter({hasText:'检查账号与连接'}).waitFor();assert.equal(await page.getByText(/已展开 178.0 MB/).count(),0);
  await page.evaluate(()=>{window.state.installation=undefined;window.state.connection={state:'failed',detail:'download disconnected'};});await page.waitForFunction(()=>!document.querySelector('.install-progress'));await page.getByText('download disconnected',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'检查更新'}).isEnabled(),true);
  const count=await page.evaluate(()=>window.calls.length);await page.evaluate(()=>window.render(false));await page.waitForFunction(()=>document.querySelector('.version-panel button').disabled);assert.equal(await page.evaluate(()=>window.calls.length),count);assert.equal(await page.getByText(/未验收|已验收/).count(),0);assert.deepEqual(errors,[]);
  console.log('成员版本状态 UI：更新免固定名单确认、自动刷新、具体失败、历史隔离、旧请求防覆盖、服务就绪、重开安装进度与结束解锁通过。');
}finally{await browser.close();await server.close();await unlink(entry);await unlink(html);}
