import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium,expect} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {Engine} from '../helpers/seeded-engine.ts'; // Scenarios opt into the built-in team; production starts empty.
const root=await mkdtemp(path.join(os.tmpdir(),'airoom-host-ui-')),source=path.join(root,'source');await mkdir(source);await writeFile(path.join(source,'材料.txt'),'keep');
const output=path.resolve('.test-cache/ui-host-pick');await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1360,height:900}}),errors=[],rpc=[],calls=[],count=new Map();let publish=Promise.resolve(),slowHands=false;
page.on('pageerror',e=>errors.push(e.message));
const engine=new Engine(path.join(root,'data'),event=>{publish=publish.then(()=>page.evaluate(event=>window.__listeners?.forEach(fn=>fn(event)),event)).catch(()=>{});},()=>{},id=>{
  let finish,stopped=false;return {probe:async()=>({id,name:id,available:true,auth:id==='dsh'?'account':'subscription',detail:'fake',capabilities:{steer:false,cancel:'native',streaming:true,write:false,history:true}}),stop:async()=>{stopped=true;finish?.();},start:async(ctx,prompt)=>{
    const roomId=ctx.session.roomId??'global';ctx.markDelivery('confirmed');
    if(ctx.session.purpose==='room-hand'){calls.push({roomId,hand:true,id});if(slowHands&&id==='dsh')await new Promise(r=>finish=r);if(stopped)return {stopped:true};ctx.emit('delta',JSON.stringify({want:id==='claude'?3:id==='codex'?1:0,why:'我有一处需要补充说明'}));return {};}
    const input=JSON.parse(prompt.split('\nAIROOM_CONTEXT\n')[1]);calls.push({roomId,id});const n=(count.get(roomId)??0)+1;count.set(roomId,n);
    if(n>3)await new Promise(r=>finish=r);if(stopped)return {stopped:true};ctx.emit('delta',JSON.stringify({version:1,turn:input.turn,revision:input.revision,action:'speak',body:'本轮发言 '+id}));return {};
  }};
});
async function wait(check){for(let i=0;i<600;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('host UI did not settle');}
try{
  await engine.probe();const project=await engine.invoke('project.create',{name:'点名会议',directory:source}),projectRoom='project:'+project.id;await engine.invoke('project.update',{projectId:project.id,memberIds:['claude','codex','dsh']});
  await page.exposeFunction('__invoke',async(method,params)=>{rpc.push({method,params});return engine.invoke(method,params);});
  await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:(method,params)=>window.__invoke(method,params),onEvent:fn=>{window.__listeners.push(fn);return()=>{window.__listeners=window.__listeners.filter(x=>x!==fn);};}};});
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port);await page.locator('.room-entry').filter({hasText:'茶歇室'}).click();
  for(const roomId of ['global',projectRoom]){
    await engine.invoke('room.send',{roomId,mode:'discuss',style:'work',text:'本轮由我点名',memberIds:['claude','codex','dsh'],handRaise:true,maxCalls:0,maxMinutes:0});await wait(()=>engine.store.roomState(roomId).discussion?.phase==='awaiting-host'&&!engine.store.roomState(roomId).active);await publish;
    if(roomId!== 'global'){await page.getByRole('button',{name:project.name,exact:true}).click();const invite=page.getByRole('dialog',{name:'请大家一起来'});if(await invite.count())await invite.getByRole('button',{name:'进入会议室'}).click();}
    const status=page.getByRole('region',{name:'在场与讨论状态',exact:true});await expect(status).toContainText('等你点名');await expect(status).toContainText('我有一处需要补充说明');await expect(page.getByLabel('举手点名')).toBeVisible();await expect(status.getByRole('button',{name:'请 Gptia 发言',exact:true})).toBeEnabled();assert.equal(calls.filter(c=>c.roomId===roomId).length,6);await new Promise(r=>setTimeout(r,70));assert.equal(calls.filter(c=>c.roomId===roomId).length,6);
    await page.setViewportSize({width:1100,height:750});await page.screenshot({path:path.join(output,(roomId==='global'?'lounge':'project')+'-host-waiting-1100.png'),animations:'disabled'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.ok(await status.locator('.guest-chip-reason').evaluateAll(nodes=>nodes.every(node=>{const text=node.getBoundingClientRect(),button=node.closest('button').getBoundingClientRect();return text.top>=button.top&&text.bottom<=button.bottom+1;})),'hand reasons stay inside the clickable chip');
    await status.getByRole('button',{name:'请 Gptia 发言',exact:true}).click();await wait(()=>count.get(roomId)===4);assert.equal(calls.filter(c=>c.roomId===roomId).at(-1).id,'codex');assert.equal(rpc.filter(r=>r.method==='room.host').at(-1).params.roomId??'global',roomId);await engine.invoke('room.stop',{roomId});await wait(()=>!engine.store.roomState(roomId).active);await publish;await page.setViewportSize({width:1360,height:900});
  }
  await page.locator('.room-entry').filter({hasText:'茶歇室'}).click();slowHands=true;count.set('global',0);
  await engine.invoke('room.send',{roomId:'global',mode:'discuss',style:'work',text:'另一位仍在等待时先点名',memberIds:['claude','codex','dsh'],handRaise:true,maxCalls:0,maxMinutes:0});
  await wait(()=>engine.store.roomState().discussion?.phase==='raising'&&engine.store.roomState().discussion.handRound?.ballots.codex?.status==='done');await publish;
  const collecting=page.getByLabel('举手点名');await expect(collecting).toContainText('正在收集举手');await expect(collecting.getByRole('button',{name:'请 Gptia 发言 · 1/3',exact:true})).toBeEnabled();
  await page.setViewportSize({width:1100,height:750});await page.screenshot({path:path.join(output,'lounge-collecting-early-pick-1100.png'),animations:'disabled'});
  await collecting.getByRole('button',{name:'请 Gptia 发言 · 1/3',exact:true}).click();await wait(()=>count.get('global')===4);assert.equal(calls.at(-1).id,'codex');
  await engine.invoke('room.stop');await wait(()=>!engine.store.roomState().active);await publish;
  assert.equal(await readFile(path.join(source,'材料.txt'),'utf8'),'keep');assert.deepEqual(errors,[]);console.log('Host-pick UI passed: actual lounge and project meetings, default host selection, visible reasons, zero calls while waiting, lower-vote member selected, correct room routing, stop, and 1100px layout.');
}finally{await engine.close();await browser.close();await server.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
