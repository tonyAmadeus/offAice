import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {meetingHarness,until} from '../helpers/meeting-controls-harness.ts';

const output=path.resolve('.test-cache/ui-meeting-minutes');await mkdir(output,{recursive:true});
let summaries=0;const h=await meetingHarness(async c=>{if(c.ctx.session.purpose==='room-minutes'&&++summaries<=2)await new Promise(r=>c.release=r);});
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1100,height:850}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.exposeFunction('rpc',async(method,params)=>['window.attention','window.show','renderer.error'].includes(method)?{}:h.engine.invoke(method,params));
await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:window.rpc,onEvent:fn=>{window.__listeners.push(fn);return()=>{};}};});
let publishing=true;const publish=(async()=>{while(publishing){await new Promise(r=>setTimeout(r,80));try{await page.evaluate(s=>window.__listeners?.forEach(fn=>fn({type:'snapshot',snapshot:s})),h.engine.snapshot());}catch{}}})();
try{
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port);await page.locator('.room-entry').filter({hasText:'茶歇室'}).click();const room=page.locator('main.room');
  const minutes=room.getByRole('button',{name:'整理会议纪要',exact:true});await expect(minutes).toHaveCount(0);await room.getByRole('radio',{name:'开会',exact:true}).click();await expect(minutes).toBeDisabled();
  await h.start();await until(()=>h.engine.store.roomState().discussion?.phase==='awaiting-host');await expect(minutes).toBeEnabled();
  await minutes.click();const dialog=page.getByRole('dialog',{name:'整理会议纪要',exact:true});await expect(dialog.getByRole('combobox',{name:'纪要成员'})).toHaveValue('claude');await expect(dialog).toContainText('预计 1 次调用');const before=h.calls.length;await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(h.calls.length,before);
  await minutes.click();await dialog.getByRole('combobox',{name:'纪要成员'}).selectOption('dsh');await page.screenshot({path:path.join(output,'choose-minutes-member-1100.png'),animations:'disabled'});await dialog.getByRole('button',{name:'确认整理',exact:true}).click();await until(()=>summaries===1);await expect(dialog).toHaveCount(0);
  const first=h.calls.find(c=>c.ctx.session.purpose==='room-minutes');assert.equal(first.ctx.session.memberId??first.ctx.session.provider,'dsh');const oldMessage=h.engine.store.roomState().discussion.meetingMinutes.messageId;
  await room.getByRole('textbox',{name:'在聊天室里说话'}).fill('新要求：重新讨论目标读者');await room.getByRole('button',{name:'发送到聊天室',exact:true}).click();first.release();await until(()=>h.engine.store.roomState().discussion?.phase==='awaiting-host');assert.equal(h.engine.store.get('room_messages',oldMessage).discussionStale,true);
  await minutes.click();await dialog.getByRole('button',{name:'确认整理',exact:true}).click();await until(()=>summaries===2);await expect(dialog).toHaveCount(0);await room.getByRole('button',{name:'中止当前对话',exact:true}).click();await until(()=>!h.engine.store.roomState().active&&h.engine.store.roomState().discussion?.phase==='paused');await expect(minutes).toBeEnabled();
  await minutes.click();await dialog.getByRole('button',{name:'确认整理',exact:true}).click();await until(()=>h.engine.store.roomState().discussion?.phase==='idle');await expect(room).toContainText('结论和分歧依实际记录保留');assert.equal(summaries,3);assert.equal(h.engine.store.roomState().discussion.endedBy,'user');await room.locator('.room-messages').evaluate(el=>el.scrollTop=el.scrollHeight);await expect(room.getByText('结论和分歧依实际记录保留。',{exact:true}).last()).toBeInViewport();await page.screenshot({path:path.join(output,'minutes-rewritten-and-ended-1100.png'),animations:'disabled'});
  await room.getByRole('radio',{name:'闲聊',exact:true}).click();await expect(minutes).toHaveCount(0);
  const project=await h.engine.invoke('project.create',{directory:h.directory,name:'纪要项目'});await h.engine.invoke('project.update',{projectId:project.id,memberIds:['claude','codex','dsh']});await h.engine.invoke('projectFlow.start',{requestId:'minutes-ui-plan',projectId:project.id,leadMemberId:'dsh',memberIds:['claude','codex','dsh'],topic:'活动方案'});await until(()=>h.engine.store.list('flow_plans').at(-1)?.status==='awaiting_confirmation');await h.start('project:'+project.id);await until(()=>h.engine.store.roomState('project:'+project.id).discussion?.phase==='awaiting-host');
  await page.getByRole('button',{name:project.name,exact:true}).click();const projectRoom=page.getByRole('main',{name:project.name+' 的项目会议室'});await projectRoom.getByRole('button',{name:'整理会议纪要',exact:true}).click();await expect(dialog.getByRole('combobox',{name:'纪要成员'})).toHaveValue('dsh');await page.screenshot({path:path.join(output,'project-lead-default-1100.png'),animations:'disabled'});await dialog.getByRole('button',{name:'确认整理',exact:true}).click();await until(()=>h.engine.store.roomState('project:'+project.id).discussion?.phase==='idle');assert.equal(h.engine.store.roomState('project:'+project.id).discussion.meetingMinutes.memberId,'dsh');assert.deepEqual(errors,[]);
  console.log('Explicit minutes UI passed: work-only entry, empty meeting disabled, default seat and project lead, one-call confirmation, cancellation without dispatch, new input invalidates, stop allows rewrite, and user-ended saved minutes at 1100px.');
}finally{publishing=false;for(const c of h.calls)c.release();await publish;await browser.close();await server.close();await h.dispose();}

