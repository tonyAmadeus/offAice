import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {DEFAULT_SETTINGS} from '../../src/shared/defaults.ts';
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});
await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage();
const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
try{
  await page.addInitScript(({settings})=>{
    const s={projects:[],sessions:[],runs:[],events:[],approvals:[],providers:[],collaborations:[],executors:[],members:[],removedMembers:[],profile:{name:'你'},settings,backendReady:true,dataDirectory:'C:\\fixture',deepseekKeyConfigured:false,room:{messages:[],state:{active:false,mode:'chat'},currentThreadId:'room-main',threads:[{id:'room-main',title:'当前话题',createdAt:new Date().toISOString()}],hasMore:false}};
    const listeners=[],states={};window.__calls=[];window.__snapshot=s;
    const publish=()=>listeners.forEach(listener=>listener({type:'snapshot',snapshot:structuredClone(s)}));
    window.airoom={onEvent:listener=>{listeners.push(listener);return()=>{};},invoke:async(method,params)=>{
      window.__calls.push({method,params});
      if(method==='snapshot')return structuredClone(s);
      if(method==='catalog.list')return {revision:'fixture',items:[],node:{available:true,version:'26.0.0',source:'bundled'}};
      if(method==='attention.list'||method==='provider.compatibility')return [];
      if(method==='settings.save'){s.settings={...s.settings,...params.settings};publish();return s.settings;}
      if(method==='team.save'){const card={...params.member,id:params.member.id||'m-added',builtIn:!!params.addTemplate};const index=s.members.findIndex(item=>item.id===card.id);if(index<0)s.members.push(card);else s.members[index]=card;publish();return card;}
      if(method==='provider.loginStatus')return states[params.provider];
      if(method==='provider.login'){states[params.provider]={phase:'waiting',message:'请在浏览器完成授权',url:'https://auth.openai.com/fixture'};return {detail:'正在准备登录'};}
      if(method==='provider.cancelLogin'){states[params.provider]={phase:'cancelled',message:'登录已取消，可以重新登录。'};return {cancelled:true};}
      if(method==='provider.openLogin')return {opened:true};
      if(method==='provider.logout'){delete states[params.provider];return {loggedOut:true};}
      if(method==='member.versions')return {member:params.provider,installed:[],baselineVersions:[],source:'bundled',selectedPath:null,connection:{state:'unchecked',detail:'fixture'}};
      if(method==='backup.list')return {items:[]};
      return {};
    }};
  },{settings:DEFAULT_SETTINGS});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await expect(page.locator('.stage-card')).toHaveCount(0);
  await page.getByRole('button',{name:'设置与连接',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'设置与成员连接'});
  await dialog.getByRole('button',{name:'连接与版本',exact:true}).click();
  await expect(dialog.locator('.provider-settings')).toHaveCount(0);
  await dialog.getByRole('combobox',{name:'手动配置本机执行端'}).selectOption('codex');
  await expect(dialog.locator('[data-provider="codex"]')).toHaveCount(1);
  await expect(dialog.locator('[data-provider="claude"],[data-provider="dsh"]')).toHaveCount(0);
  const account=dialog.getByLabel('codex 账号登录');
  await account.getByRole('button',{name:'登录',exact:true}).click();
  await expect(account.getByRole('button',{name:'打开官方授权页面'})).toBeVisible();
  await account.getByRole('button',{name:'打开官方授权页面'}).click();
  await account.getByRole('button',{name:'取消登录'}).click();
  await expect(account.getByRole('button',{name:'登录',exact:true})).toBeEnabled();
  await account.getByRole('button',{name:'登出',exact:true}).click();
  await dialog.getByRole('button',{name:'团队成员',exact:true}).click();
  await dialog.getByRole('button',{name:/添加成员/}).click();
  await dialog.getByRole('combobox',{name:'人物形象模板'}).selectOption('codex');
  await dialog.getByRole('radio',{name:'沿用已有的程序'}).click();
  await dialog.getByRole('combobox',{name:'使用的程序',exact:true}).selectOption('dsh');
  await expect(dialog.locator('.card-preview-portrait img')).toBeVisible();
  await dialog.getByRole('button',{name:'保存人物卡',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'编辑 Gptia 的人物卡'})).toBeVisible();
  assert.equal(await page.evaluate(()=>window.__snapshot.members.length),1);
  assert.equal(await page.evaluate(()=>window.__snapshot.members[0].executor),'dsh');
  await dialog.getByRole('button',{name:'编辑 Gptia 的人物卡'}).click();
  await dialog.getByRole('combobox',{name:'使用的程序',exact:true}).selectOption('codex');
  await dialog.getByRole('button',{name:'保存人物卡',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__snapshot.members[0].executor),'codex');
  assert.equal(await page.locator('input[placeholder*="阿潘"]').count(),0);
  assert.deepEqual(errors,[]);console.log('Release initial UI passed: empty team and controls, manual setup, login reopen/cancel/logout, optional template and independent executor rebinding.');
}finally{await browser.close();await server.close();}
