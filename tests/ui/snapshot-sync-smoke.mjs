import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {Engine} from '../../src/backend/engine.ts';
import {SnapshotPublisher} from '../../src/shared/snapshot-sync.ts';
const root=path.resolve('.test-cache/snapshot-sync');await mkdir(root,{recursive:true});const directory=await mkdtemp(path.join(root,'run-'));
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1360,height:900}}),errors=[],events=[],tasks=new Set();page.on('pageerror',e=>errors.push(e.message));
const publisher=new SnapshotPublisher('ui-fixture');let snapshotReads=0;
const push=event=>{const next=event.type==='snapshot'?publisher.publish(event.snapshot):event;if(!next)return;events.push(next);const task=page.evaluate(event=>window.__listeners?.forEach(listener=>listener(event)),structuredClone(next)).catch(e=>errors.push(e.message));tasks.add(task);void task.finally(()=>tasks.delete(task));};
const engine=new Engine(path.join(directory,'data'),push,()=>{},id=>({probe:async()=>({id,name:id,available:false,auth:'none',detail:'fixture',capabilities:{steer:false,cancel:'native',streaming:false,write:false,history:false}}),start:async()=>assert.fail('snapshot tests cannot call models'),stop:async()=>{}}));
try{
  await page.exposeFunction('__invoke',async(method,params)=>{if(method==='snapshot'){snapshotReads++;push({type:'snapshot',snapshot:engine.snapshot()});return publisher.current;}const result=await engine.invoke(method,params);await new Promise(r=>setImmediate(r));await Promise.all([...tasks]);return result;});
  await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:(method,params)=>window.__invoke(method,params),onEvent:listener=>{window.__listeners.push(listener);return()=>window.__listeners=window.__listeners.filter(item=>item!==listener);}};});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);await page.getByRole('button',{name:'设置与连接'}).waitFor();
  const folder=path.join(directory,'project');await mkdir(folder);const project=await page.evaluate(directory=>window.airoom.invoke('project.create',{directory,name:'增量项目'}),folder);await page.getByText('增量项目',{exact:true}).first().waitFor();
  await page.evaluate(id=>window.airoom.invoke('project.update',{projectId:id,name:'已改名的项目'}),project.id);await page.getByText('已改名的项目',{exact:true}).first().waitFor();assert.equal(await page.getByText('增量项目',{exact:true}).count(),0);
  const before=snapshotReads;await page.evaluate(sync=>window.__listeners.forEach(listener=>listener({type:'snapshot-patch',sync:{...sync,revision:sync.revision+2},baseRevision:sync.revision+1,changes:{profile:{name:'不得应用的跳号消息'}},removed:[],rows:{}})),publisher.current.sync);
  // Wait for the actual RPC rather than assuming a delayed refresh has already completed.
  const until=Date.now()+3000;while(snapshotReads===before&&Date.now()<until)await new Promise(r=>setTimeout(r,10));assert.ok(snapshotReads>before,'a gap requests a canonical snapshot');
  await page.evaluate(id=>window.airoom.invoke('project.remove',{projectId:id}),project.id);await page.getByText('已改名的项目',{exact:true}).first().waitFor({state:'detached'});
  assert.equal(events.filter(event=>event.type==='snapshot').length,1);const patches=events.filter(event=>event.type==='snapshot-patch');assert.ok(patches.length>=3);assert.ok(patches.some(event=>event.rows.projects?.removed.includes(project.id)));assert.ok(patches.every(event=>event.changes.settings===undefined));assert.deepEqual(errors,[]);
  console.log('Snapshot sync UI passed: real Engine project create/rename/delete, changed-row publication, unchanged settings excluded, gap resync, no model requests.');
}finally{await engine.close();await Promise.all([...tasks]);await browser.close();await server.close();assert.equal(path.dirname(directory),root);await rm(directory,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
