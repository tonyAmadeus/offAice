import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {Engine} from '../../src/backend/engine.ts';

const parent=path.resolve('.test-cache/builtin-ui');await mkdir(parent,{recursive:true});
const data=await mkdtemp(path.join(parent,'run-')),output=path.resolve('.test-cache/ui-builtin-connections');await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
let publish=Promise.resolve();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
const engine=new Engine(data,event=>{publish=publish.then(()=>page.evaluate(event=>window.__listeners?.forEach(fn=>fn(event)),event)).catch(()=>{});},()=>{},id=>({probe:async()=>({id,name:id,available:true,auth:'subscription',runtimeReady:true,detail:'隔离连接夹具',capabilities:{streaming:true,write:true,history:true,cancel:'native',steer:false}}),start:async()=>assert.fail('no model calls'),stop:async()=>{}}));
try{
  await engine.invoke('settings.save',{settings:{...engine.settings,paths:{claude:process.execPath,codex:process.execPath,dsh:process.execPath}}});await engine.probe();
  await page.exposeFunction('__invoke',async(method,params)=>{
    if(method==='provider.loginStatus'||method==='app.version')return undefined;
    if(method==='catalog.latest')return {version:'fixture'};
    return engine.invoke(method,params);
  });
  await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:(method,params)=>window.__invoke(method,params),onEvent:fn=>{window.__listeners.push(fn);return()=>{window.__listeners=window.__listeners.filter(item=>item!==fn);};}};});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.getByRole('button',{name:'设置与连接',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'设置与成员连接'});
  await dialog.getByRole('button',{name:'连接与版本',exact:true}).click();
  for(const name of ['Codex','Claude','DeepSeek Harness'])await expect(dialog.getByRole('button',{name:`${name} 删除连接`,exact:true})).toBeEnabled();
  for(const id of ['codex','claude','dsh'])await dialog.locator(`[data-provider="${id}"] .provider-settings-heading`).screenshot({path:path.join(output,`01-${id}-delete-button.png`)});
  for(const [id,name] of [['codex','Codex'],['claude','Claude'],['dsh','DeepSeek Harness']]){
    await dialog.getByRole('button',{name:`${name} 删除连接`,exact:true}).click();
    await expect(dialog.locator(`[data-provider="${id}"]`)).toHaveCount(0);
  }
  assert.deepEqual(engine.snapshot().removedProviders.sort(),['claude','codex','dsh']);
  await page.screenshot({path:path.join(output,'02-connections-removed.png')});
  await dialog.getByRole('combobox',{name:'手动配置本机执行端'}).selectOption('codex');
  await expect(dialog.locator('[data-provider="codex"]')).toHaveCount(1);
  await expect(dialog.getByRole('button',{name:'Codex 删除连接',exact:true})).toBeEnabled();
  await engine.invoke('team.save',{member:{name:'仍在使用 Codex',executor:'codex'}});await publish;
  await expect(dialog.getByRole('button',{name:'Codex 删除连接',exact:true})).toBeDisabled();
  await expect(dialog.getByRole('button',{name:'Codex 删除连接',exact:true})).toHaveAttribute('title',/先让使用它的人物/);
  await page.screenshot({path:path.join(output,'03-restored-and-in-use.png')});
  assert.deepEqual(errors,[]);
  console.log('Built-in connection UI passed: three delete controls, removal, re-add, and in-use guard. No model calls.');
}finally{await engine.close();await browser.close();await server.close();assert.equal(path.dirname(data),parent);await rm(data,{recursive:true,force:true});}
