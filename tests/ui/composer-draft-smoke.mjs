import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {Engine} from '../helpers/seeded-engine.ts'; // Scenarios opt into the built-in team; production starts empty.

// Actual persistence and renderer navigation, with adapters that never use an account.
const directory=path.join(process.env.AIROOM_TEST_PROFILE,'composer-ui-'+randomUUID());
await mkdir(directory,{recursive:true});
const otherFolder=path.join(directory,'another-folder');await mkdir(otherFolder);
const source=path.join(directory,'draft-notes.txt');await writeFile(source,'只供隔离验证的材料');
const output=path.resolve('.test-cache/composer-draft-ui');await mkdir(output,{recursive:true});
const calls=[],errors=[],events=[];let heldSend,holdSend=false,rejectSend=false;
const engine=new Engine(path.join(directory,'data'),event=>events.push(event),()=>{},id=>({
  probe:async()=>({id,name:id,available:true,auth:'subscription',detail:'isolated draft fixture',capabilities:{streaming:true,history:true,write:true,cancel:'native',steer:false}}),
  stop:async()=>{},start:async(ctx,prompt)=>{calls.push({id,prompt,runId:ctx.run.id});ctx.markDelivery('confirmed');ctx.emit('delta','隔离回复，等待下一条要求。');return {};},
}));
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1360,height:900}});
page.on('pageerror',error=>errors.push(error.message));
await page.exposeFunction('rpc',async(method,params)=>{
  if(['window.attention','window.show','renderer.error'].includes(method))return {};
  if(method==='attachment.pick')return engine.invoke('attachment.import',{paths:[source]});
  if(method==='workspace.open')return {opened:true};
  if(method==='room.send'&&rejectSend)throw new Error('隔离测试：发送前连接暂不可用');
  if(method==='room.send'&&holdSend)await new Promise(resolve=>{heldSend=resolve;});
  return engine.invoke(method,params);
});
await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:window.rpc,onEvent:fn=>{window.__listeners.push(fn);return()=>{window.__listeners=window.__listeners.filter(item=>item!==fn);};}};});
let publishing=true;
const publish=(async()=>{while(publishing){if(!events.length){await new Promise(resolve=>setTimeout(resolve,15));continue;}const event=events.shift();try{await page.evaluate(event=>window.__listeners?.forEach(fn=>fn(event)),event);}catch{}}})();
const desk=page.getByRole('main',{name:'个人工位'}),composer=desk.getByRole('textbox',{name:'在工位里说话'});
const openDesk=async(name='Claudia')=>{await page.getByRole('button',{name:name+' 的工位',exact:true}).click();await expect(desk.getByRole('heading',{name:name+' 的工位',exact:true})).toBeVisible();await expect(composer).toBeEnabled();};
const scope=room=>({roomId:room.roomId,threadId:room.currentThreadId});
try{
  await engine.probe();
  for(const memberId of ['claude','codex']){await engine.invoke('desk.open',{memberId});await engine.invoke('desk.topic',{memberId});}
  let room=await engine.invoke('desk.open',{memberId:'claude'});const originalScope=scope(room),originalFolder=room.directory;
  await engine.invoke('room.send',{roomId:room.roomId,text:'供回复的原消息'});
  await expect.poll(()=>engine.store.list('runs').filter(run=>run.status==='running').length).toBe(0);
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port);await openDesk();
  await expect(desk).toContainText('直接读写：');await desk.getByRole('button',{name:'工位文件夹操作'}).click();await expect(page.getByRole('menuitem',{name:'打开当前工作位置'})).toBeEnabled();await page.keyboard.press('Escape');
  await desk.getByRole('button',{name:'回复 Claudia 的消息',exact:true}).click();
  await composer.fill('未发送的草稿，保留回复对象和附件');await desk.getByRole('button',{name:'添加图片或文件'}).click();
  await expect(desk.getByLabel('待发送的附件')).toContainText('draft-notes.txt');
  await expect.poll(async()=>(await engine.invoke('composer.draft.get',originalScope))?.text).toBe('未发送的草稿，保留回复对象和附件');
  const before=calls.length;
  await openDesk('Gptia');await expect(composer).toHaveValue('');await composer.fill('另一个成员的草稿');
  await openDesk();await expect(composer).toHaveValue('未发送的草稿，保留回复对象和附件');await expect(desk.locator('.room-reply-note')).toContainText('隔离回复，等待下一条要求。');
  await page.reload();await openDesk();await expect(composer).toHaveValue('未发送的草稿，保留回复对象和附件');await expect(desk.getByLabel('待发送的附件')).toContainText('draft-notes.txt');
  assert.equal(calls.length,before,'opening, switching and reloading drafts must not send a member task');
  rejectSend=true;await desk.getByRole('button',{name:'发送到工位'}).click();await expect(desk.getByRole('button',{name:'发送到工位'})).toBeEnabled();rejectSend=false;
  await expect(composer).toHaveValue('未发送的草稿，保留回复对象和附件');await expect(desk.getByLabel('待发送的附件')).toContainText('draft-notes.txt');assert.equal(calls.length,before);

  // Different folders keep independent topics, even for the same member.
  await engine.invoke('desk.switchFolder',{memberId:'claude',directory:otherFolder});await engine.invoke('desk.topic',{memberId:'claude'});
  room=await engine.invoke('desk.open',{memberId:'claude'});const otherScope=scope(room);
  await expect(composer).toHaveValue('');await expect(desk).toContainText('待创建任务副本：');await composer.fill('其他文件夹的草稿');
  await expect.poll(async()=>(await engine.invoke('composer.draft.get',otherScope))?.text).toBe('其他文件夹的草稿');
  await engine.invoke('desk.switchFolder',{memberId:'claude',directory:originalFolder});
  await expect(composer).toHaveValue('未发送的草稿，保留回复对象和附件');await expect(desk.getByLabel('待发送的附件')).toContainText('draft-notes.txt');
  assert.equal(calls.length,before);
  await page.screenshot({path:path.join(output,'restored-1360.png'),animations:'disabled'});

  // Typing while the send RPC waits must survive its later success response.
  holdSend=true;await desk.getByRole('button',{name:'发送到工位'}).click();await expect.poll(()=>Boolean(heldSend)).toBe(true);
  await composer.press('End');await page.keyboard.insertText('补充');holdSend=false;heldSend();heldSend=undefined;
  await expect.poll(()=>calls.length).toBe(before+1);await expect(composer).toHaveValue('补充');await expect(desk.getByLabel('待发送的附件')).toHaveCount(0);await expect(desk.locator('.room-reply-note')).toHaveCount(0);
  await expect.poll(async()=>{const draft=await engine.invoke('composer.draft.get',originalScope);return {text:draft?.text,attachments:draft?.attachments.length,replyTo:draft?.replyTo};}).toEqual({text:'补充',attachments:0,replyTo:undefined});
  await expect(desk.getByRole('button',{name:'发送到工位'})).toBeEnabled();
  await expect.poll(()=>engine.store.list('runs').filter(run=>run.status==='running').length).toBe(0);
  await desk.getByRole('button',{name:'发送到工位'}).click();await expect(composer).toHaveValue('');
  await expect.poll(()=>engine.invoke('composer.draft.get',originalScope)).toBe(null);
  assert.equal(await page.evaluate(scope=>Object.keys(localStorage).some(key=>{if(!key.startsWith('airoom.composer.draft:'))return false;const parts=JSON.parse(key.slice('airoom.composer.draft:'.length));return parts[2]===JSON.stringify([scope.roomId,scope.threadId]);}),originalScope),false,'cleared drafts leave no localStorage key');
  await page.reload();await openDesk();await expect(composer).toHaveValue('');assert.equal(calls.length,before+2);
  assert.equal((await engine.invoke('composer.draft.get',otherScope)).text,'其他文件夹的草稿');
  await openDesk('Gptia');await expect(composer).toHaveValue('另一个成员的草稿');
  const codexScope=scope(await engine.invoke('desk.open',{memberId:'codex'}));
  await expect.poll(async()=>(await engine.invoke('composer.draft.get',codexScope))?.text).toBe('另一个成员的草稿');
  await engine.invoke('composer.draft.save',{...codexScope,value:{text:'备份中的草稿',attachments:[]}});
  engine.store.put('restore_info','main',{at:new Date().toISOString(),backupId:'fixture'});engine.broadcast();
  await expect(composer).toHaveValue('备份中的草稿');await page.reload();await openDesk('Gptia');await expect(composer).toHaveValue('备份中的草稿');
  await page.setViewportSize({width:1100,height:750});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(output,'independent-1100.png'),animations:'disabled'});
  assert.deepEqual(errors,[]);
  console.log('Draft UI passed: text, attachment and reply survive navigation/reload; member/folder scopes remain separate; opening never sends; pending-send append keeps only the supplement and removes sent attachments/reply; empty localStorage entries are removed; successful send stays cleared.');
}finally{heldSend?.();publishing=false;await publish;await engine.close();await browser.close();await server.close();}
