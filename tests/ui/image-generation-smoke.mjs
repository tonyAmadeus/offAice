import '../../scripts/test-bootstrap.mjs';
// Actual Engine + renderer; deterministic native-picture events, no account or image-service calls.
// node --import tsx tests/ui/image-generation-smoke.mjs
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../scripts/ui-test-server.mjs';
import { chromium, expect } from '@playwright/test';
import { Engine } from '../helpers/seeded-engine.ts'; // Scenarios opt into the built-in team; production starts empty.
import { attachmentPath } from '../../src/backend/attachments.ts';

const encoded='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6toAAAAAASUVORK5CYII=';
const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM image-ui-'));
const output=path.resolve('.test-cache/ui-image-generation');await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1360,height:900}});
const providers=['claude','codex','dsh'].map(id=>({id,name:id,available:true,auth:id==='dsh'?'account':'subscription',detail:'fixture',capabilities:{steer:false,cancel:'native',streaming:true,write:false,history:true,images:true,imageGeneration:id==='codex'}}));
const calls=[],rpc=[],errors=[],dialogs=[];let acceptDialogs=false,publish=Promise.resolve();
page.on('pageerror',error=>errors.push(error.message));page.on('dialog',async dialog=>{dialogs.push(dialog.message());await (acceptDialogs?dialog.accept():dialog.dismiss());});
const factory=id=>{let finish;return {probe:async()=>providers.find(info=>info.id===id)??{...providers[0],id,available:false},start:async(ctx,prompt)=>{
  const turn=`turn-${ctx.run.id}`;ctx.markDelivery('confirmed',turn);ctx.emit('tool','开始：生成图片',{type:'imageGeneration'});
  return new Promise(resolve=>{finish=resolve;calls.push({ctx,prompt,turn,finish:resolve});});
},stop:async()=>finish?.({stopped:true})};};
const engine=new Engine(directory,event=>{publish=publish.then(()=>page.evaluate(event=>window.__listeners?.forEach(listener=>listener(event)),event)).catch(()=>{});},()=>{},factory,{roomRuntimeReuse:false});
const wait=async check=>{const until=Date.now()+10000;while(!check()){if(Date.now()>until)assert.fail('Engine did not reach expected state');await new Promise(resolve=>setTimeout(resolve,10));}};
try{
  await engine.probe();
  // Fulfil exactly the same local asset URL used in Electron, from this test's own copied bytes.
  await page.route('airoom-asset://**',async route=>{
    const pathname=decodeURIComponent(new URL(route.request().url()).pathname),match=/^\/attachments\/([a-f0-9-]{36})\/([^/\\]+)$/.exec(pathname);
    if(!match){await route.fulfill({status:404});return;}
    const body=await readFile(attachmentPath(directory,{id:match[1],name:match[2]}));await route.fulfill({status:200,contentType:'image/png',body});
  });
  const reference=path.join(directory,'猫咪参考.png');await writeFile(reference,Buffer.from(encoded,'base64'));
  const attachments=await engine.invoke('attachment.import',{paths:[reference]});
  await page.exposeFunction('__invoke',async(method,params)=>{
    rpc.push({method,params});if(method==='attachment.pick')return attachments;if(method==='attachment.save')return {saved:true};if(method==='attachment.reveal')return {shown:true};return engine.invoke(method,params);
  });
  await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:(method,params)=>window.__invoke(method,params),onEvent:fn=>{window.__listeners.push(fn);return()=>{window.__listeners=window.__listeners.filter(item=>item!==fn);};}};});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);await page.locator('.room-entry').filter({hasText:'茶歇室'}).click();
  const entry=page.getByRole('button',{name:'生成图片',exact:true});await expect(entry).toBeEnabled();
  await page.getByRole('textbox',{name:'在聊天室里说话'}).fill('画一只坐在窗边的小猫');await entry.click();
  let modal=page.getByRole('dialog',{name:'生成图片',exact:true});await expect(modal.getByLabel('画面描述')).toHaveValue('画一只坐在窗边的小猫');await expect(modal).toContainText('使用 Codex 额度');
  await modal.getByRole('button',{name:'添加图片或文件',exact:true}).click();await expect(modal).toContainText('猫咪参考.png');await modal.getByRole('button',{name:'开始生成',exact:true}).click();await wait(()=>calls.length===1);await publish;
  assert.equal(calls[0].ctx.session.purpose,'room-image');assert.equal(calls[0].ctx.session.writeMode,false);assert.equal(calls[0].ctx.attachments.length,1);await expect(entry).toBeDisabled();await expect(page.getByText('正在生成图片，可以随时停止。')).toBeVisible();
  calls[0].ctx.emit('image','图片已生成。',{nativeItemId:'picture-1',nativeTurnId:calls[0].turn,result:encoded});calls[0].ctx.emit('message','画好了。',{source:'assistant'});calls[0].finish({});await wait(()=>!engine.store.roomState().active);await publish;
  const card=page.getByLabel('生成的图片'),picture=card.getByRole('img',{name:'生成的图片',exact:true});await expect(picture).toBeVisible();await expect(picture).toHaveJSProperty('naturalWidth',1);
  await card.getByRole('button',{name:'保存图片',exact:true}).click();await expect(card).toContainText('已保存');const saved=rpc.find(call=>call.method==='attachment.save');assert.ok(saved.params.id);assert.equal(saved.params.name,'AIROOM-图片.png');
  await card.getByRole('button',{name:'查看生成图片大图'}).click();const preview=page.getByRole('dialog',{name:'图片预览'});await expect(preview.getByRole('img',{name:'生成的图片大图'})).toHaveJSProperty('naturalWidth',1);await page.keyboard.press('Escape');await expect(preview).toHaveCount(0);
  await page.screenshot({path:path.join(output,'image-generation-1360.png'),animations:'disabled'});await page.setViewportSize({width:1100,height:750});await page.screenshot({path:path.join(output,'image-generation-1100.png'),animations:'disabled'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await card.getByRole('button',{name:'修改这张图'}).click();modal=page.getByRole('dialog',{name:'生成图片',exact:true});await expect(modal.getByLabel('待发送的附件')).toContainText('AIROOM-图片.png');await modal.getByLabel('画面描述').fill('把背景改成蓝色');await modal.getByRole('button',{name:'开始生成',exact:true}).click();await wait(()=>calls.length===2);assert.equal(calls[1].ctx.attachments[0].name,'AIROOM-图片.png');calls[1].finish({unknown:true});await wait(()=>!engine.store.roomState().active);await publish;
  await entry.click();modal=page.getByRole('dialog',{name:'生成图片',exact:true});await modal.getByLabel('画面描述').fill('一次新的绘图请求');await modal.getByRole('button',{name:'开始生成',exact:true}).click();assert.equal(calls.length,2,'dismissed unknown-delivery confirmation sends nothing');assert.equal(dialogs.length,1);
  acceptDialogs=true;await modal.getByRole('button',{name:'开始生成',exact:true}).click();await wait(()=>calls.length===3);assert.equal(rpc.filter(call=>call.method==='room.generateImage').at(-1).params.acknowledgeUnknown,true);calls[2].finish({failure:{kind:'rate_limited',message:'图片生成额度已用尽'}});await wait(()=>!engine.store.roomState().active);await publish;assert.equal(calls.length,3);assert.equal(engine.snapshot().room.messages.filter(message=>message.generatedImages?.length).length,1);
  await page.reload();await page.locator('.room-entry').filter({hasText:'茶歇室'}).click();await expect(page.getByRole('img',{name:'生成的图片',exact:true})).toHaveJSProperty('naturalWidth',1);assert.deepEqual(errors,[]);
  console.log('Image-generation UI passed: explicit Codex request, reference pictures, inline local image, preview, save routing, edits, unknown confirmation, quota failure, persistent history and 1100px layout.');
}finally{await engine.close();await publish;await browser.close();await server.close();assert.ok(path.basename(directory).startsWith('AIROOM image-ui-'));await rm(directory,{recursive:true,force:true});}
