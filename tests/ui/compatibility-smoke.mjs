import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {writeFile,unlink} from 'node:fs/promises';

const failure={id:'failed',provider:'codex',trigger:'run',startedAt:'2026-10-07T13:26:43Z',completedAt:'2026-10-07T13:26:53Z',outcome:'failed',account:'unknown',delivery:'prepared',restore:'bound',identity:{path:'C:/agent/codex.js',version:'0.160.0',adapterVersion:'airoom.executor/2',protocol:'codex-app-server'},network:{mode:'tun',tunVerified:false},stages:[{stage:'initialize',method:'initialize',startedAt:'2026-10-07T13:26:43Z',durationMs:10000,timeoutMs:10000,outcome:'failed',error:'workspace routing discovery timed out'}],error:'workspace routing discovery timed out'};
const success={...failure,id:'passed',trigger:'probe',startedAt:'2026-10-07T13:27:24Z',outcome:'passed',account:'subscription',error:undefined,stages:[],delivery:undefined,restore:undefined};
const entry=new URL('./compatibility-entry.js',import.meta.url);
await writeFile(entry,`import React from 'react';import {createRoot} from 'react-dom/client';import {CompatibilityDetails} from '/src/renderer/compatibility.tsx';
const root=createRoot(document.getElementById('root'));window.calls=[];
const reports=${JSON.stringify([success,failure])};window.render=available=>root.render(React.createElement(CompatibilityDetails,{provider:'codex',info:{compatibility:reports[0],lastRunCompatibility:reports[1]},available,load:async provider=>{window.calls.push(provider);return reports;}}));window.render(true);`);
const server=await createServer({configFile:false,esbuild:{jsx:'automatic'},root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});
const html=new URL('./compatibility-test.html',import.meta.url);await writeFile(html,'<div id="root"></div><script type="module" src="./compatibility-entry.js"></script>');
await server.listen();const browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1100,height:860}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
try{
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/ui/compatibility-test.html`);
  await page.getByText(/最近实际运行：失败/).waitFor().catch(error=>{throw new Error(error.message+'; '+errors.join('; '));});await page.getByText('连接诊断与历史',{exact:true}).click();
  await page.getByRole('button',{name:'读取最近记录'}).click();
  await page.locator('summary').filter({hasText:/实际运行 · 失败/}).click();
  await page.getByText(/恢复：当时使用绑定版本/).waitFor();assert.ok(await page.getByText('workspace routing discovery timed out',{exact:true}).count());
  assert.equal(await page.getByText(/协议初始化.*10000 ms/).count(),1);
  assert.deepEqual(await page.evaluate(()=>window.calls),['codex']);
  await page.evaluate(()=>window.render(false));await page.waitForFunction(()=>document.querySelector('button')?.disabled);
  assert.deepEqual(errors,[]);console.log('Compatibility UI passed: successful probes preserve failed runs, native diagnostics and deadlines, bound restore, read-only history, offline controls at 1100px.');
}finally{await browser.close();await server.close();await unlink(entry);await unlink(html);}
