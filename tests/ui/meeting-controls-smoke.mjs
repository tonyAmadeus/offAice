import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {meetingHarness,until} from '../helpers/meeting-controls-harness.ts';

const output=path.resolve('.test-cache/ui-meeting-controls');await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[],rpc=[];let publish=Promise.resolve();
page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());
const h=await meetingHarness(async c=>{if(c.kind==='submission'||c.ctx.session.purpose==='room-summary'||c.ctx.cwd.includes(path.join('data','desks')))await new Promise(r=>c.release=r);},snapshot=>{publish=publish.then(()=>page.evaluate(snapshot=>window.__listeners?.forEach(fn=>fn({type:'snapshot',snapshot})),snapshot)).catch(()=>{});});
try{
  await page.exposeFunction('__invoke',async(method,params)=>{rpc.push({method,params});return h.engine.invoke(method,params);});
  await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:(method,params)=>window.__invoke(method,params),onEvent:fn=>{window.__listeners.push(fn);return()=>{window.__listeners=window.__listeners.filter(x=>x!==fn);};}};});
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port);await page.locator('.room-entry').filter({hasText:'茶歇室'}).click();
  await h.start();await until(()=>h.engine.store.roomState().discussion?.phase==='awaiting-host'&&!h.engine.store.roomState().active);await publish;
  const status=page.getByRole('region',{name:'在场与讨论状态',exact:true}),stop=page.getByRole('button',{name:'中止当前对话',exact:true});
  assert.deepEqual(await status.locator('.guest-chip-name').allTextContents(),['Claudia','Gptia','DS']);
  assert.deepEqual(h.speech().map(c=>c.input.you),['claude','codex','dsh']);await expect(stop).toBeEnabled();await page.screenshot({path:path.join(output,'ordered-meeting-host-wait-1100.png'),animations:'disabled'});
  const before=h.calls.length;await stop.click();await until(()=>h.engine.store.roomState().discussion?.phase==='paused');await publish;assert.equal(h.calls.length,before);await expect(stop).toHaveCount(0);
  await page.getByRole('textbox',{name:'在聊天室里说话'}).fill('@DS @Gptia 只回答这次要求');await page.getByRole('button',{name:'发送到聊天室',exact:true}).click();await until(()=>h.engine.store.roomState().discussion?.phase==='waiting_user'&&!h.engine.store.roomState().active);await publish;
  assert.deepEqual(h.speech().slice(3).map(c=>c.input.you),['codex','dsh']);assert.equal(h.calls.length,before+2);await expect(stop).toHaveCount(0);await page.screenshot({path:path.join(output,'mentioned-members-wait-1100.png'),animations:'disabled'});
  const summary=h.engine.store.currentRoomThread().summary;await page.getByRole('button',{name:'话题操作'}).click();await page.getByRole('menuitem',{name:'压缩上下文'}).click();await until(()=>h.calls.some(c=>c.ctx.session.purpose==='room-summary'));await publish;await expect(stop).toBeEnabled();await page.screenshot({path:path.join(output,'compression-can-stop-1100.png'),animations:'disabled'});await stop.click();await until(()=>!h.engine.store.roomState().compressing);assert.ok(h.calls.find(c=>c.ctx.session.purpose==='room-summary').stopped);assert.deepEqual(h.engine.store.currentRoomThread().summary,summary);
  const project=await h.engine.invoke('project.create',{directory:h.directory,name:'成员中止范围'});await h.engine.invoke('projectFlow.start',{requestId:'ui-stop-flow',projectId:project.id,topic:'改文件',leadMemberId:'codex',memberIds:['codex','claude','dsh']});let flow;await until(()=>{flow=h.engine.projectFlow.snapshot(project.id);return Boolean(flow.plan);});await h.engine.invoke('projectFlow.plan.confirm',{requestId:'ui-stop-confirm',planId:flow.plan.id,expectedRevision:flow.plan.revision});await until(()=>h.calls.some(c=>c.kind==='submission'));
  for(const member of ['claude','dsh']){await h.engine.invoke('room.archive',{roomId:'desk:'+member,title:'中止范围示例'});await h.engine.invoke('room.send',{roomId:'desk:'+member,text:'当前工位任务'});}await until(()=>h.calls.filter(c=>c.ctx.cwd.includes(path.join('data','desks'))).length===2);await publish;
  // C-02: retained discussion states from deleted projects must not block the sidebar stop button.
  h.engine.store.put('room_states','project:deleted',{...h.engine.store.roomState(),roomId:'project:deleted'});
  const stoppedBeforeMemberDialog=h.calls.filter(c=>c.stopped).length,memberStop=page.getByRole('button',{name:'中止 Claudia',exact:true});await expect(memberStop).toBeEnabled();await memberStop.click();let dialog=page.getByRole('dialog',{name:'中止 Claudia',exact:true});await expect(dialog).toContainText('将停止 2 项当前运行');await expect(dialog).toContainText('个人工位');await expect(dialog).toContainText('项目工作');await page.screenshot({path:path.join(output,'member-stop-confirm-locations-1100.png'),animations:'disabled'});
  await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(h.calls.filter(c=>c.stopped).length,stoppedBeforeMemberDialog);assert.equal(rpc.filter(r=>r.method==='member.stop').length,0);
  await memberStop.click();dialog=page.getByRole('dialog',{name:'中止 Claudia',exact:true});await dialog.getByRole('button',{name:'确认中止这位成员',exact:true}).click();await expect(dialog).toHaveCount(0);await publish;await expect(memberStop).toHaveCount(0);await expect(page.getByRole('button',{name:'中止 DS',exact:true})).toBeEnabled();
  assert.ok(h.calls.filter(c=>(c.ctx.session.memberId??c.ctx.session.provider)==='claude'&&(c.kind==='submission'||c.ctx.cwd.includes(path.join('data','desks')))).every(c=>c.stopped));assert.equal(h.calls.find(c=>c.ctx.cwd.includes(path.join('data','desks'))&&(c.ctx.session.memberId??c.ctx.session.provider)==='dsh').stopped,false);assert.equal(await page.getByRole('button',{name:/全部停止/}).count(),0);assert.equal(await status.getByRole('button',{name:'暂停接话',exact:true}).count(),0);assert.equal(await status.getByRole('button',{name:'结束讨论',exact:true}).count(),0);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,'member-stop-complete-peers-preserved-1100.png'),animations:'disabled'});assert.deepEqual(errors,[]);
  console.log('Meeting controls UI passed: actual seating order, mention-only replies, composer stop at host wait, input resumes, exact member confirmation list, cancel does nothing, desk and task stopped together, peers continue, obsolete global controls removed and 1100px layout.');
}finally{await h.dispose();await publish;await browser.close();await server.close();}
