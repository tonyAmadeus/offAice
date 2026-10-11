import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {DEFAULT_SETTINGS,DEFAULT_PROFILE} from '../../src/shared/defaults.ts';

const server=process.env.AIROOM_UI_TEST_URL?undefined:await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});
await server?.listen();const url=process.env.AIROOM_UI_TEST_URL??`http://127.0.0.1:${server.httpServer.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1100,height:850}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
const snapshot={projects:[{id:'saved-project',name:'已有验收项目',directory:'C:/fixture/work',createdAt:'2026-10-07T15:26:10Z',memberIds:['codex']}],sessions:[],runs:[],events:[],approvals:[],collaborations:[],members:[],profile:DEFAULT_PROFILE,settings:DEFAULT_SETTINGS,providers:[{id:'codex',name:'Codex',available:true,auth:'subscription',stale:true,detail:'上次确认',capabilities:{steer:true,cancel:'native',streaming:true,write:true,history:true}}],backendReady:false,dataDirectory:'C:/fixture/data',deepseekKeyConfigured:false};
try{
  await page.addInitScript(snapshot=>{
    window.__snapshot=snapshot;window.__calls=[];window.__listeners=[];
    window.airoom={onEvent:listener=>{window.__listeners.push(listener);return()=>{};},invoke:async(method,params)=>{
      window.__calls.push({method,params});if(method==='snapshot')return structuredClone(window.__snapshot);
      if(!window.__snapshot.backendReady)throw new Error("Error invoking remote method 'airoom:invoke': Error: 执行服务尚未就绪，请稍候或重新打开应用");
      if(method==='projectFlow.memberReports')return {members:[{id:'codex',name:'Gptia',historical:false,count:0}],items:[],total:0,hasMore:false,scope:'project'};
      return {};
    }};
    window.__push=(type,ready)=>{window.__snapshot.backendReady=ready;window.__listeners.forEach(listener=>listener(type==='backend'?{type,ready}:{type,snapshot:structuredClone(window.__snapshot)}));};
  },snapshot);
  await page.goto(url);await page.getByRole('button',{name:'已有验收项目',exact:true}).waitFor();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal((await page.evaluate(()=>window.__calls.filter(call=>call.method==='projectFlow.memberReports'))).length,0,'initial saved-project reads wait for the backend');
  assert.equal(await page.locator('.toast.error').count(),0);
  await page.evaluate(()=>window.__push('backend',true));
  await page.waitForFunction(()=>window.__calls.some(call=>call.method==='projectFlow.memberReports'));
  // Member reports are listed in the project room, not the sidebar.
  await page.getByRole('button',{name:'已有验收项目',exact:true}).click();
  await page.getByRole('button',{name:'Gptia 的项目汇报',exact:true}).waitFor();assert.equal(await page.locator('.toast.error').count(),0);
  const before=await page.evaluate(()=>window.__calls.filter(call=>call.method==='projectFlow.memberReports').length);
  await page.evaluate(()=>{window.__snapshot.runs=[{id:'history',projectId:'saved-project',sessionId:'s',provider:'codex',status:'ended',updatedAt:'2026-10-07T15:26:12Z'}];window.__push('snapshot',false);});
  await page.getByRole('button',{name:'重新连接',exact:true}).waitFor();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call.method==='projectFlow.memberReports').length),before,'restart and saved-history changes do not launch reads against an unready worker');
  await page.evaluate(()=>window.__push('backend',true));
  await page.waitForFunction(before=>window.__calls.filter(call=>call.method==='projectFlow.memberReports').length>before,before);
  await page.getByRole('button',{name:'Gptia 的项目汇报',exact:true}).waitFor();assert.equal(await page.locator('.toast.error').count(),0);
  assert.equal(await page.getByText('设置改过了，需要重新检测',{exact:true}).count(),0,'startup revalidation does not claim settings changed');
  assert.deepEqual(errors,[]);console.log('Startup readiness UI passed: saved-project reads wait, ready automatically fetches, restart/history changes remain safe, and no false settings-change or 9-second error toast.');
}finally{await browser.close();await server?.close();}
