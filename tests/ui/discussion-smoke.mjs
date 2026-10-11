import '../../scripts/test-bootstrap.mjs';
// Actual Engine + renderer, with deterministic member responses; no account/model calls.
// node --import tsx tests/ui/discussion-smoke.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium, expect } from '@playwright/test';
import { createServer } from '../../scripts/ui-test-server.mjs';
import { Engine } from '../../src/backend/engine.ts';

const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM discussion-ui-'));
const output=path.resolve('.test-cache/ui-discussion');await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1360,height:900}});
const errors=[],calls=[],pending=[],rpc=[],hands=[],pendingHands=[];let autoHands=false;
let acceptDialogs=true;const dialogs=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('dialog',async dialog=>{dialogs.push(dialog.message());await (acceptDialogs?dialog.accept():dialog.dismiss());});
const providers=['claude','codex','dsh'].map(id=>({id,name:id,available:true,auth:id==='dsh'?'account':'subscription',detail:'test fixture',capabilities:{steer:false,cancel:'native',streaming:true,write:false,history:true,images:true}}));
// The adapter streams an envelope prefix, then its remainder when the test releases the turn.
const streamedFactory=id=>{
  let finish;
  return {probe:async()=>providers.find(p=>p.id===id)??{id,name:id,available:false,auth:'none',detail:'not used',capabilities:{steer:false,cancel:'native',streaming:true,write:false,history:false}},start:async(ctx,prompt)=>{
    if(ctx.session.purpose==='room-hand'){
      const input=JSON.parse(prompt.split('\nAIROOM_HAND_CONTEXT\n')[1]);hands.push(input);ctx.markDelivery('confirmed');
      const vote=()=>ctx.emit('delta',JSON.stringify({want:id==='dsh'?3:1,why:id==='dsh'?'有雨天方案的关键补充':'可以补充细节'}));
      if(autoHands){vote();return {};}
      return new Promise(resolve=>{finish=resolve;pendingHands.push(()=>{vote();resolve({});});});
    }
    const input=JSON.parse(prompt.split('\nAIROOM_CONTEXT\n')[1]);ctx.markDelivery('confirmed');
    if(ctx.session.purpose==='room-minutes'){ctx.emit('delta',JSON.stringify({version:1,turn:input.turn,revision:input.revision,action:'speak',body:'结论：周末安排已确认。\n分歧：保留。\n下一步：未约定。'}));return {};}
    calls.push(input);
    const prefix=JSON.stringify({version:1,turn:input.turn,revision:input.revision}).slice(0,-1)+',';
    ctx.emit('delta',prefix);
    let emitted=prefix;
    const append=text=>{assert.ok(text.startsWith(emitted));ctx.emit('delta',text.slice(emitted.length));emitted=text;};
    return new Promise(resolve=>{finish=resolve;pending.push({input,ctx,stream:body=>append(prefix+JSON.stringify({action:'speak',body}).slice(1,-2)),finish:reply=>{
      if(reply.unknown){resolve({unknown:true});return;}
      if(reply.malformed){ctx.emit('delta','格式错误');resolve({});return;}
      append(prefix+JSON.stringify({action:'speak',body:'',...reply}).slice(1));resolve({});
    }});}).finally(()=>{const index=pending.findIndex(item=>item.ctx===ctx);if(index>=0)pending.splice(index,1);});
  },stop:async()=>finish?.({stopped:true})};
};
let publish=Promise.resolve();
const engine=new Engine(directory,event=>{
  if(event.type==='snapshot')event.snapshot.providers=providers;
  publish=publish.then(()=>page.evaluate(event=>window.__listeners?.forEach(fn=>fn(event)),event)).catch(()=>{});
},()=>{},streamedFactory);
const wait=async check=>{for(let i=0;i<500;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('engine did not reach expected state');};
const release=async reply=>{await wait(()=>pending.length>0);const next=pending.shift();next.finish(typeof reply==='function'?reply(next.input):reply);return next.input;};
const snapshot=()=>({...engine.snapshot(),providers});
try{
  await engine.probe();
  const image=path.join(directory,'周末计划.png');await writeFile(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6toAAAAAASUVORK5CYII=','base64'));const attachments=await engine.invoke('attachment.import',{paths:[image]});
  await page.exposeFunction('__invoke',async(method,params)=>{rpc.push({method,params});return method==='snapshot'?snapshot():method==='attachment.pick'?attachments:engine.invoke(method,params);});
  await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:(method,params)=>window.__invoke(method,params),onEvent:fn=>{window.__listeners.push(fn);return()=>{window.__listeners=window.__listeners.filter(x=>x!==fn);};}};});
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port);await page.locator('.room-entry').filter({hasText:'茶歇室'}).click();await page.getByRole('radio',{name:'开会',exact:true}).click();
  const handOption=page.getByRole('checkbox',{name:'举手模式',exact:true});await handOption.check();await expect(page.getByRole('checkbox',{name:'举手后由我点名',exact:true})).toBeChecked();
  const input=page.getByRole('textbox',{name:'在聊天室里说话'}),send=page.getByRole('button',{name:/^(发送到聊天室|开始会议)$/}),stop=page.getByRole('button',{name:'中止当前对话',exact:true}),status=page.getByRole('region',{name:'在场与讨论状态',exact:true}),chip=name=>status.locator('.guest-chip',{hasText:name});
  await expect(stop).toHaveCount(0);await page.getByRole('button',{name:'添加图片或文件',exact:true}).click();await input.fill('@Claudia 讨论周末计划');await send.click();await wait(()=>calls.length===1);await publish;assert.deepEqual(pending[0].ctx.attachments.map(a=>a.name),['周末计划.png']);await expect(chip('Claudia')).toHaveClass(/speaking/);await expect(stop).toBeEnabled();assert.equal(await status.getByRole('button',{name:'结束讨论',exact:true}).count(),0);assert.equal(await status.getByRole('button',{name:'暂停接话',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:/全部停止/}).count(),0);
  pending[0].stream('先安排户外');await publish;await expect(page.locator('.room-messages')).toContainText('先安排户外');assert.ok(!(await page.locator('.room-messages').innerText()).includes(calls[0].turn));await page.screenshot({path:path.join(output,'discussion-body-streaming-1360.png')});
  const streamedRun=pending[0].ctx.run.id,streamedMessage=engine.store.roomMessages().find(m=>m.runId===streamedRun),streamedBubble=page.locator(`[data-message-id="${streamedMessage.id}"] .room-bubble`);
  await streamedBubble.evaluate(node=>{window.__streamNode=node;window.__streamFrames=[node.textContent];window.__streamObserver=new MutationObserver(()=>window.__streamFrames.push(node.textContent));window.__streamObserver.observe(node,{childList:true,subtree:true,characterData:true});});
  await input.fill('@DS 请说雨天备选');await send.click();await release({body:'先安排户外，晴天可以去公园。'});await wait(()=>calls.length===2);await publish;
  await expect(streamedBubble).toHaveText('先安排户外，晴天可以去公园。');
  const continuity=await streamedBubble.evaluate(node=>{window.__streamObserver.disconnect();return {sameNode:node===window.__streamNode,frames:window.__streamFrames};});
  assert.ok(continuity.sameNode,'the completed reply must keep its original bubble');
  assert.ok(continuity.frames.every(text=>text.startsWith('先安排户外')),`streamed text disappeared before completion: ${JSON.stringify(continuity.frames)}`);
  assert.equal(await page.locator(`[data-message-id="${streamedMessage.id}"]`).count(),1);assert.equal(engine.store.roomMessages().filter(m=>m.runId===streamedRun).length,1);
  assert.equal(calls[1].you,'dsh');await stop.click();await wait(()=>!engine.store.roomState().active&&engine.store.roomState().discussion.phase==='paused');await publish;assert.equal(calls.length,2);await status.getByRole('button',{name:'继续讨论',exact:true}).click();await wait(()=>calls.length===3);await release({body:'雨天可以去博物馆。'});await wait(()=>engine.store.roomState().discussion.phase==='waiting_user'&&!engine.store.roomState().active);assert.equal(hands.length,0);assert.equal(calls.length,3);
  await page.getByRole('button',{name:'回复 Claudia 的消息',exact:true}).click();await input.fill('所有人回答预算和交通要求');await send.click();await wait(()=>calls.length===4);assert.equal(calls[3].you,'claude');await release({body:'预算按要求限制。'});await release({body:'补充公共交通。'});await release({body:'核对雨天备选。'});await wait(()=>pendingHands.length===3);await publish;await expect(status).toContainText('大家正在举手');await expect(stop).toBeEnabled();await page.screenshot({path:path.join(output,'hand-collecting-1360.png')});
  autoHands=true;pendingHands.splice(0).forEach(fn=>fn());await wait(()=>engine.store.roomState().discussion.phase==='awaiting-host'&&!engine.store.roomState().active);await publish;await page.screenshot({path:path.join(output,'host-pick-waiting-1360.png')});await status.getByRole('button',{name:'请 DS 发言',exact:true}).click();await wait(()=>pending.length>0);assert.equal(pending[0].input.canPropose,false);await page.setViewportSize({width:1100,height:750});await expect(stop).toBeVisible();await page.screenshot({path:path.join(output,'statusbar-active-1100.png')});await release({action:'propose',body:'预算和交通均已回答，保留各方意见，可以结束。'});await wait(()=>engine.store.roomState().discussion.phase==='awaiting-host'&&!engine.store.roomState().active);const d=engine.store.roomState().discussion;await engine.invoke('room.minutes',{discussionId:d.id,revision:d.revision});await wait(()=>engine.store.roomState().discussion.phase==='idle'&&!engine.store.roomState().active);await publish;assert.equal(engine.store.roomState().discussion.phase,'idle');await expect(page.locator('.room-messages')).toContainText('结论：周末安排已确认');await expect(stop).toHaveCount(0);await page.screenshot({path:path.join(output,'free-discussion-1100.png')});
  await handOption.uncheck();await input.fill('核对未知投递');await send.click();await wait(()=>pending.length>0);pending[0].stream('尚未确认的部分');await publish;const failedMember=pending[0].input.you;await release({unknown:true});await release({body:'其他成员正常回复。'});await release({body:'我也正常回复。'});await wait(()=>!engine.store.roomState().active);await publish;await expect(page.locator('.room-messages')).not.toContainText('尚未确认的部分');await expect(status).toContainText('已跳过');assert.ok(engine.store.roomState().discussion.skippedMembers[failedMember]);
  const nextRound=calls.length;await input.fill('下一轮继续跳过异常成员');await send.click();await release({body:'下一轮继续回答。'});await release({body:'下一轮我也回答。'});await wait(()=>!engine.store.roomState().active);assert.equal(calls.length,nextRound+2);assert.ok(calls.slice(nextRound).every(c=>c.you!==failedMember));await publish;
  acceptDialogs=false;const before=calls.length;await status.getByRole('button',{name:'核对后重新加入异常成员',exact:true}).click();assert.equal(calls.length,before);assert.equal(engine.store.roomState().discussion.phase,'waiting_user');acceptDialogs=true;await status.getByRole('button',{name:'核对后重新加入异常成员',exact:true}).click();
  const closeCurrent=async()=>{for(;;){await wait(()=>pending.length>0||engine.store.roomState().discussion.phase==='waiting_user');if(engine.store.roomState().discussion.phase==='waiting_user')break;await release({body:'按顺序回答本轮要求。'});}await wait(()=>!engine.store.roomState().active);const d=engine.store.roomState().discussion;await engine.invoke('room.minutes',{discussionId:d.id,revision:d.revision});await wait(()=>engine.store.roomState().discussion.phase==='idle'&&!engine.store.roomState().active);};
  await closeCurrent();assert.equal(engine.store.roomState().discussion.phase,'idle');assert.ok(dialogs.some(s=>s.includes('结果未知')));
  await input.fill('验证格式补正');await send.click();await wait(()=>pending.length>0);const malformed=pending[0],cost=engine.store.roomState().discussion.calls;await release({malformed:true});await wait(()=>pending.length>0&&pending[0].input.turn===malformed.input.turn);assert.notEqual(pending[0].ctx.run.id,malformed.ctx.run.id);assert.equal(engine.store.roomState().discussion.calls,cost+1);pending[0].stream('格式已补正');await publish;await expect(page.locator('.room-messages')).toContainText('格式已补正');await release({body:'格式已补正。'});await closeCurrent();await publish;assert.equal(engine.store.roomState().discussion.phase,'idle');assert.ok(!(await page.locator('.room-messages').innerText()).includes('"revision"'));
  await engine.invoke('room.send',{mode:'discuss',style:'work',text:'有限预算兼容',memberIds:['claude','codex','dsh'],maxCalls:2,maxMinutes:3});await wait(()=>pending.length>0);await publish;await expect(status.getByLabel('讨论剩余轮次')).toContainText('剩余 1 次调用');await release({body:'第一位回答'});await release({body:'第二位回答'});await wait(()=>engine.store.roomState().discussion.phase==='budget'&&!engine.store.roomState().active);assert.ok(rpc.some(c=>c.method==='room.send'&&c.params.replyTo));assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await engine.invoke('room.send',{mode:'discuss',style:'chat',text:'闲聊中人类不回答也继续',memberIds:['claude','codex','dsh'],maxCalls:4});await release({action:'ask_user',body:'你想去哪里？',questions:[{to:'user',text:'你想去哪里？'}]});await wait(()=>pending.length>0);await publish;await expect(status).toContainText('这些问题可以稍后回答');await expect(status).toContainText('正在闲聊');await release({body:'我继续聊自己的想法。'});await release({action:'pass',body:''});await release({action:'pass',body:''});await wait(()=>!engine.store.roomState().active);assert.equal(engine.store.roomState().discussion.phase,'budget');assert.equal(engine.store.roomState().discussion.questions[0].answeredBy,undefined);assert.deepEqual(errors,[]);
  console.log('Discussion UI passed: private streaming, images, ordered response rounds, mention-only waiting, composer stop/resume, default host choice, human-requested minutes, one format repair, unknown acknowledgment without replay, finite-budget compatibility and 1100px layout.');
}catch(error){console.error(JSON.stringify({rpc,state:engine.store.roomState(),ui:await page.locator('body').innerText()},null,2));throw error;}
finally{await engine.close();await publish;await browser.close();await server.close();await rm(directory,{recursive:true,force:true});}
