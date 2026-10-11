import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {roundtableHarness} from '../helpers/roundtable-harness.ts';

const output=path.resolve('.test-cache/roundtable-streaming-20261009');await mkdir(output,{recursive:true});
const pending=[],errors=[],readGates=[],pushEvents=[];let heldMessage;
const h=await roundtableHarness({onEvent:event=>pushEvents.push(structuredClone(event)),handler:async call=>{
  if(call.kind||!call.material.turn||call.ctx.session.purpose==='room-hand')return;
  return new Promise(resolve=>{
    const prefix=JSON.stringify({version:1,turn:call.material.turn,revision:call.material.revision,action:'speak'}).slice(0,-1)+',"body":"';
    let emitted='';
    const append=text=>{assert.ok(text.startsWith(emitted));call.ctx.emit('delta',text.slice(emitted.length));emitted=text;};
    pending.push({call,stream:body=>append(prefix+JSON.stringify(body).slice(1,-1)),finish:body=>{append(prefix+JSON.stringify(body).slice(1));append(emitted+'}');resolve({nativeResult:{}});},abort:result=>resolve({nativeResult:result})});
    call.release=()=>resolve({nativeResult:{stopped:true}});
  });
}});h.setClose(false);
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1360,height:900}});
page.on('pageerror',e=>errors.push(e.message));
await page.exposeFunction('rpc',async(method,params)=>{
  if(['window.attention','window.show','renderer.error'].includes(method))return {};
  const result=await h.engine.invoke(method,params);
  if(method==='room.get'&&heldMessage&&result.messages.some(m=>m.id===heldMessage&&m.status!=='speaking'))await new Promise(resolve=>readGates.push(resolve));
  return result;
});
await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:window.rpc,onEvent:fn=>{window.__listeners.push(fn);return()=>{window.__listeners=window.__listeners.filter(x=>x!==fn);};}};});
// Match the desktop's ordered event stream. Polling snapshots alone can skip the
// final deltas once the coordinator has persisted the completed room message.
let publishing=true;const publish=(async()=>{while(publishing){if(!pushEvents.length){await new Promise(r=>setTimeout(r,20));continue;}const event=pushEvents.shift();try{await page.evaluate(e=>window.__listeners?.forEach(fn=>fn(e)),event);}catch{}}})();
const wait=async check=>{for(let i=0;i<1500;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('roundtable streaming state timed out');};
const observe=async(message,marker)=>{
  const line=page.locator(`[data-message-id="${message.id}"]`);await expect(line).toContainText(marker);
  await line.locator('.markdown').evaluate(node=>{window.__streamBody=node;window.__streamFrames=[];window.__streamObserver=new MutationObserver(()=>window.__streamFrames.push({connected:node.isConnected,text:node.textContent}));window.__streamObserver.observe(document.querySelector('.room-messages'),{childList:true,subtree:true,characterData:true});});
  return async label=>{
    const result=await line.evaluate(node=>{window.__streamObserver.disconnect();return {sameBody:node.querySelector('.markdown')===window.__streamBody,frames:window.__streamFrames,finalText:node.textContent};});
    await writeFile(path.join(output,label+'.json'),JSON.stringify(result,null,2));
    assert.ok(result.frames.every(frame=>frame.connected&&frame.text.includes(marker)),`${label}: streamed body was removed or cleared`);
    assert.equal(result.sameBody,true,`${label}: final reply replaced its existing body`);
    assert.equal(result.finalText.split(marker).length-1,1,`${label}: duplicate body`);
    assert.equal(h.engine.store.list('room_messages').filter(m=>m.runId===message.runId).length,1);
  };
};
try{
  const opened=await h.open({memberIds:['codex','claude'],peerReview:false});
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port);await page.getByRole('button',{name:/^圆桌/}).click();
  await wait(()=>pending.length>0);const first=pending.shift(),marker='圆桌普通回复连续保留';first.stream(marker);
  const message=h.engine.store.list('room_messages').find(m=>m.runId===first.call.ctx.run.id),check=await observe(message,marker);
  heldMessage=message.id;first.finish(marker+'，完成后仍然在同一位置。');await wait(()=>readGates.length>0);
  // The RPC gate only proves a read started. Wait for the separate push stream
  // to reach the page before sampling its completed text, while the read stays held.
  await expect(page.locator(`[data-message-id="${message.id}"]`)).toContainText(marker+'，完成后仍然在同一位置。');
  const delayedText=await page.locator(`[data-message-id="${message.id}"]`).innerText();heldMessage=undefined;for(const release of readGates.splice(0))release();
  await expect(page.locator(`[data-message-id="${message.id}"]`)).toContainText('完成后仍然在同一位置');await check('ordinary');assert.ok(delayedText.includes(marker+'，完成后仍然在同一位置。'),'completed snapshot cleared or rolled back the body while room.get was delayed');
  await wait(()=>pending.length>0);pending.shift().finish('另一位成员的独立补充，保留未核实事项。');
  await h.choose(opened.topic.id);await h.wait(opened.topic.id,d=>h.engine.store.roomState(d.topic.roomId).discussion?.phase==='waiting_user');
  const minutes=h.minutes(opened.topic.id);await wait(()=>pending.length>0);const summary=pending.shift(),summaryMarker='圆桌结论正文连续保留';assert.equal(summary.call.ctx.session.purpose,'room-minutes');summary.stream(summaryMarker);
  const summaryMessage=h.engine.store.list('room_messages').find(m=>m.runId===summary.call.ctx.run.id),checkSummary=await observe(summaryMessage,summaryMarker);
  summary.finish(summaryMarker+'。\n\n## 共识\n保留候选。\n## 分歧与各方理由\n措辞仍有不同。\n## 少数意见\n保留原意见。\n## 未核实事项\n读者偏好。\n## 建议\n确认后续方案。');await minutes;
  const conclusion=page.getByRole('article',{name:'圆桌结论',exact:true});await expect(conclusion).toContainText('未核实事项');await expect(conclusion.getByRole('button',{name:'确认结论',exact:true})).toBeVisible();await checkSummary('conclusion');
  assert.equal(h.calls.filter(c=>c.ctx.session.purpose==='room-minutes').length,1);await page.screenshot({path:path.join(output,'roundtable-streaming-1360.png')});

  await h.act(opened.topic.id,'discuss');
  for(let i=0;i<2;i++){await wait(()=>pending.length>0);pending.shift().finish('重新审议的成员发言 '+i+'，等待用户决定。');}
  await h.wait(opened.topic.id,d=>h.engine.store.roomState(d.topic.roomId).discussion?.phase==='waiting_user');
  const startMinutes=async()=>{const discussion=h.engine.store.roomState(opened.topic.roomId).discussion;await h.engine.invoke('room.minutes',{roomId:opened.topic.roomId,discussionId:discussion.id,revision:discussion.revision});await wait(()=>pending.length>0);const turn=pending.shift();assert.equal(turn.call.ctx.session.purpose,'room-minutes');return turn;};
  for(const outcome of ['stopped','unknown']){
    const turn=await startMinutes(),provisional='这段未完成结论必须撤下 '+outcome;turn.stream(provisional);
    const saved=h.engine.store.list('room_messages').find(m=>m.runId===turn.call.ctx.run.id),line=page.locator(`[data-message-id="${saved.id}"]`);await expect(line).toContainText(provisional);assert.equal(await line.getByRole('button',{name:'确认结论',exact:true}).count(),0);
    heldMessage=saved.id;const count=h.calls.length;
    if(outcome==='stopped')await h.engine.invoke('room.stop',{roomId:opened.topic.roomId});else turn.abort({unknown:true});
    await wait(()=>readGates.length>0);await expect(line).not.toContainText(provisional);
    heldMessage=undefined;for(const release of readGates.splice(0))release();
    await wait(()=>h.engine.store.get('room_messages',saved.id)?.status!=='speaking');await expect(line).not.toContainText(provisional);assert.equal(await line.getByRole('button',{name:'确认结论',exact:true}).count(),0);assert.equal(h.engine.store.get('room_messages',saved.id).text,'');assert.equal(h.calls.length,count,'stopped or unknown minutes must not resend automatically');
    await writeFile(path.join(output,outcome+'.json'),JSON.stringify({run:h.engine.store.get('runs',turn.call.ctx.run.id).status,message:h.engine.store.get('room_messages',saved.id).status,bodyHidden:true,noConfirm:true,noResend:true},null,2));
  }
  assert.deepEqual(errors,[]);
  console.log('Roundtable streaming passed: delayed room reads retain the same ordinary body; streamed minutes keep the same body when published; stopped and unknown minutes hide provisional text, offer no confirmation and never resend.');
}finally{heldMessage=undefined;for(const release of readGates)release();publishing=false;await publish;await browser.close();await server.close();await h.dispose();}
