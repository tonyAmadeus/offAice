import '../../scripts/test-bootstrap.mjs';
// Real Engine + renderer in an isolated directory; no production profiles, accounts or model calls.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {Engine} from '../../src/backend/engine.ts';

const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM card-lifecycle-ui-')),output=path.resolve('.test-cache/ui-member-card-lifecycle');await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1360,height:900}});
const errors=[],rpc=[],modelCalls=[];page.on('pageerror',error=>errors.push(error.message));
const factory=id=>({probe:async()=>({id,name:id,available:true,auth:'account',detail:'isolated fixture',capabilities:{streaming:true,write:false,history:true,cancel:'native',steer:false}}),start:async(ctx,prompt)=>{modelCalls.push({id,sessionId:ctx.session.id,prompt});ctx.markDelivery('confirmed');ctx.emit('delta','这是一份保留的成果。');return {};},stop:async()=>{}});
let publish=Promise.resolve();const push=event=>{publish=publish.then(()=>page.evaluate(event=>window.__listeners?.forEach(fn=>fn(event)),event)).catch(()=>{});};
let engine=new Engine(directory,push,()=>{},factory);
const wait=async check=>{for(let i=0;i<500;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('engine did not settle');};
const settings=()=>page.getByRole('dialog',{name:'设置与成员连接',exact:true});
const home=()=>page.locator('.brand').click();
const openSettings=async()=>{await page.getByRole('button',{name:'设置与连接',exact:true}).click();await expect(settings()).toBeVisible();await settings().getByRole('button',{name:'团队成员',exact:true}).click();};
const closeSettings=()=>settings().getByRole('button',{name:'关闭对话框',exact:true}).click();
const findHistory=async name=>{await page.keyboard.press('Control+k');const picker=page.getByRole('dialog',{name:'快速切换会话'});await picker.getByRole('textbox',{name:'搜索会话'}).fill(name);await picker.getByRole('option').first().click();await expect(page.getByRole('main',{name:'个人工位'})).toBeVisible();};
try{
  await engine.probe();const card=await engine.invoke('team.save',{member:{executor:'codex',name:'历史编辑',persona:'原有的人设'}});
  await engine.invoke('desk.open',{memberId:card.id});await engine.invoke('desk.topic',{memberId:card.id,title:'保留的个人话题'});const desk=await engine.invoke('desk.open',{memberId:card.id});
  const sent=await engine.invoke('room.send',{roomId:`desk:${card.id}`,text:'请留下成果'});await wait(()=>Boolean(engine.store.get('runs',sent.runId)?.completedAt));
  const resultFile=path.join(directory,'desks',card.id,'成果.txt');await writeFile(resultFile,'成果文件原样保留');
  await page.exposeFunction('__invoke',async(method,params)=>{rpc.push({method,params});if(method==='file.save')return {path:path.join(directory,'导出.md')};const result=await engine.invoke(method,params);await publish;return result;});
  await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:(method,params)=>window.__invoke(method,params),onEvent:fn=>{window.__listeners.push(fn);return()=>{window.__listeners=window.__listeners.filter(x=>x!==fn);};}};});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await expect(page.getByRole('list',{name:'团队成员'}).getByRole('listitem')).toHaveCount(4);
  // Thumbnail cards only offer conversation/connection; management lives in settings.
  for(const width of [1100,1360]){
    await page.setViewportSize({width,height:900});await page.getByRole('button',{name:'查看 Claudia 的人物卡片',exact:true}).click();const popup=page.getByRole('dialog',{name:'Claudia 的人物卡片'});
    for(const name of ['编辑人物卡','隐藏 Claudia 的人物卡','删除人物卡'])await expect(popup.getByRole('button',{name,exact:true})).toHaveCount(0);
    const bounds=await popup.boundingBox();assert.ok(bounds.y>=0&&bounds.y+bounds.height<=900);await page.screenshot({path:path.join(output,`card-actions-${width}.png`)});await popup.getByRole('button',{name:'关闭人物卡片'}).click();
  }
  await openSettings();await settings().getByRole('button',{name:'编辑 历史编辑 的人物卡'}).click();await settings().getByRole('button',{name:'隐藏 历史编辑 的人物卡',exact:true}).click();await closeSettings();
  await expect(page.locator(`.team-roster .roster-row.member-${card.id}`)).toHaveCount(0);await expect(page.locator(`.team-stage .stage-card.member-${card.id}`)).toHaveCount(0);assert.equal(engine.store.members().find(m=>m.id===card.id).cardHidden,true);
  // A hidden member still appears in existing conversations and can answer there.
  await findHistory('保留的个人话题');const input=page.getByRole('textbox',{name:'在工位里说话'});await input.fill('隐藏后继续这段对话');await page.getByRole('button',{name:'发送到工位',exact:true}).click();await wait(()=>modelCalls.length===2);await expect(page.locator('.room-messages')).toContainText('隐藏后继续这段对话');
  assert.equal(modelCalls[1].sessionId,desk.sessionId,'hiding preserves the original conversation');
  await openSettings();await expect(settings().getByRole('button',{name:'编辑 历史编辑 的人物卡'})).toContainText('人物卡已隐藏');await settings().getByRole('button',{name:'编辑 历史编辑 的人物卡'}).click();
  await expect(settings().getByRole('button',{name:'返回团队',exact:true})).toBeVisible();await publish;
  await settings().getByRole('button',{name:'显示 历史编辑 的人物卡',exact:true}).click();await wait(()=>engine.store.members().find(m=>m.id===card.id)?.cardHidden===false);await publish;await expect(settings().getByRole('button',{name:'隐藏 历史编辑 的人物卡',exact:true})).toBeEnabled();await expect(page.locator(`.team-roster .roster-row.member-${card.id}`)).toHaveCount(1);await closeSettings();await home();await expect(page.locator(`.team-stage .stage-card.member-${card.id}`)).toHaveCount(1);
  // Cancelling deletion does nothing; confirmation preserves real history and results.
  await openSettings();await settings().getByRole('button',{name:'编辑 历史编辑 的人物卡'}).click();await settings().getByRole('button',{name:'删除人物卡',exact:true}).click();let removal=page.getByRole('dialog',{name:'删除人物卡「历史编辑」？'});
  await expect(removal).toContainText('已有对话、汇报、成果和个人文件夹都会保留');await expect(removal.getByRole('radio')).toHaveCount(0);await removal.getByRole('button',{name:'取消',exact:true}).click();assert.ok(engine.store.members().some(m=>m.id===card.id));
  await settings().getByRole('button',{name:'删除人物卡',exact:true}).click();removal=page.getByRole('dialog',{name:'删除人物卡「历史编辑」？'});await removal.getByRole('button',{name:'确认删除人物卡',exact:true}).click();await expect(removal).toHaveCount(0);
  await closeSettings();assert.ok(!engine.store.members().some(m=>m.id===card.id));assert.ok(engine.store.get('sessions',desk.sessionId));assert.equal(await readFile(resultFile,'utf8'),'成果文件原样保留');
  await findHistory('保留的个人话题');await expect(page.locator('.room-messages')).toContainText('这是一份保留的成果。');await expect(page.getByRole('main',{name:'个人工位'})).toContainText('历史编辑');await expect(page.getByRole('button',{name:'发送到工位',exact:true})).toBeDisabled();await expect(page.getByRole('textbox',{name:'在工位里说话'})).toBeDisabled();
  await page.getByRole('button',{name:'话题操作'}).click();await page.getByRole('menuitem',{name:'导出当前话题'}).click();await wait(()=>rpc.some(call=>call.method==='file.save'));assert.match(rpc.find(call=>call.method==='file.save').params.content,/历史编辑/);
  await page.screenshot({path:path.join(output,'deleted-card-history.png')});
  // Hide every remaining member without removing its selectable identity or connection, then restore from settings.
  await home();await openSettings();
  for(const name of ['Claudia','Gptia','DS']){await settings().getByRole('button',{name:`编辑 ${name} 的人物卡`}).click();await settings().getByRole('button',{name:`隐藏 ${name} 的人物卡`,exact:true}).click();await settings().getByRole('button',{name:'返回团队',exact:true}).click();}
  await closeSettings();await expect(page.locator('.team-roster .roster-row')).toHaveCount(0);await expect(page.getByRole('list',{name:'团队成员'}).getByRole('listitem')).toHaveCount(0);await expect(page.getByRole('button',{name:'请大家一起来',exact:true})).toBeEnabled();await page.getByRole('button',{name:'管理人物卡',exact:true}).click();
  for(const name of ['Claudia','Gptia','DS']){await settings().getByRole('button',{name:`编辑 ${name} 的人物卡`}).click();await settings().getByRole('button',{name:'删除人物卡',exact:true}).click();await page.getByRole('dialog',{name:`删除人物卡「${name}」？`}).getByRole('button',{name:'确认删除人物卡',exact:true}).click();await expect(settings().getByRole('button',{name:`编辑 ${name} 的人物卡`})).toHaveCount(0);}
  await closeSettings();await home();assert.deepEqual(engine.snapshot().members,[]);await page.screenshot({path:path.join(output,'empty-team.png')});
  await engine.close();engine=new Engine(directory,push,()=>{},factory);await engine.probe();await page.reload();await expect(page.getByRole('list',{name:'团队成员'}).getByRole('listitem')).toHaveCount(0);await expect(page.locator('.team-roster .roster-row')).toHaveCount(0);
  await findHistory('保留的个人话题');await expect(page.locator('.room-messages')).toContainText('这是一份保留的成果。');await expect(page.getByRole('button',{name:'发送到工位',exact:true})).toBeDisabled();
  await openSettings();await settings().getByRole('button',{name:/添加成员/}).click();await settings().getByRole('textbox',{name:'名字',exact:true}).fill('重新加入的成员');await settings().getByRole('radio',{name:'沿用已有的程序'}).click();await settings().getByRole('button',{name:'保存人物卡',exact:true}).click();await expect(settings().getByRole('button',{name:'编辑 重新加入的成员 的人物卡'})).toBeVisible();
  assert.equal(engine.snapshot().members.length,1);assert.equal(errors.length,0,errors.join('\n'));
  console.log('Member card lifecycle smoke passed: thumbnail cards without management actions at 1100/1360 and settings management, hidden roster/home only, original conversation continues, restore, cancel/delete, preserved files/history/name/export, all hidden, all built-ins deleted, cold restart with no resurrection, empty-team rendering and adding a new card. No real model calls.');
}catch(error){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw error;}
finally{await engine.close();await browser.close();await server.close();await rm(directory,{recursive:true,force:true,maxRetries:5});}
