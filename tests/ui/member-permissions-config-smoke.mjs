import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createServer } from '../../scripts/ui-test-server.mjs';
import { Engine } from '../../src/backend/engine.ts';
import { catalogCandidate } from '../../src/backend/executor-catalog.ts';

const root=path.resolve('.test-cache/member-permissions-ui');await mkdir(root,{recursive:true});
const data=await mkdtemp(path.join(root,'run-')),output=path.resolve('.test-cache/ui-member-permissions-config');await mkdir(output,{recursive:true});
const factory=id=>({probe:async settings=>{
  const current=settings.models[id]||'fast';
  return {id,name:id,path:process.execPath,available:true,runtimeReady:true,auth:id==='dsh'||id.startsWith('acp-')?'account':'subscription',detail:'fixture',configuration:{model:id!=='acp-catalogzcode',effort:id==='acp-catalogzcode'?'unsupported':'reported'},modelOptions:id==='acp-catalogzcode'?[]:['fast','deep'].map(model=>({id:model,label:model,efforts:model===current?(model==='fast'?['low']:['high','ultra']):[],effortSource:model===current?'reported':'unreported',isDefault:model===current})),capabilities:{steer:false,cancel:'native',streaming:true,write:true,history:true}};
},start:async()=>assert.fail('No model task is permitted'),stop:async()=>{}});
const engine=new Engine(data,()=>{},()=>{},factory);
const executor=await engine.invoke('executor.save',{executor:{name:'新增终端',command:process.execPath,model:'fast'}});
const person=await engine.invoke('team.save',{member:{name:'新增人物',executor:executor.id}});
await engine.invoke('team.visibility',{id:person.id,hidden:true});
engine.store.put('executors','acp-catalogzcode',catalogCandidate('zcode',process.execPath));
await engine.invoke('settings.save',{settings:{models:{'acp-catalogzcode':'old-unsupported'}}});
await engine.probe();
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
let release,holdDeep=true,failConfig=false;const staleGate=new Promise(resolve=>release=resolve);
page.on('pageerror',error=>errors.push(error.message));
await page.exposeFunction('rpc',async(method,params)=>{
  if(['window.attention','window.show','renderer.error'].includes(method))return {};
  if(failConfig&&method==='provider.config'&&params.provider===executor.id)throw new Error('模拟能力读取失败');
  const value=await engine.invoke(method,params??{});
  if(method==='provider.config'&&params.provider===executor.id&&params.model==='deep'&&holdDeep){holdDeep=false;await staleGate;}
  if(method!=='snapshot'&&method!=='provider.config')await page.evaluate(snapshot=>window.__listeners?.forEach(listener=>listener({type:'snapshot',snapshot})),engine.snapshot());
  return value;
});
await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:window.rpc,onEvent:listener=>{window.__listeners.push(listener);return()=>{};}};});
try{
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port);
  const open=()=>page.getByRole('button',{name:'设置与连接',exact:true}).click();await open();
  const dialog=page.getByRole('dialog',{name:'设置与成员连接'});
  await dialog.getByRole('button',{name:'权限',exact:true}).click();
  const defaults=dialog.getByRole('region',{name:'新增终端 默认权限'}),individual=dialog.getByRole('region',{name:'新增人物 单独权限'});
  await expect(individual).toContainText('已隐藏');
  await defaults.getByRole('radiogroup',{name:'新增终端 文件范围'}).getByRole('radio',{name:'不限制',exact:true}).click();
  await individual.getByLabel('新增人物 单独执行命令').selectOption('deny');
  await individual.getByLabel('新增人物 单独联网').selectOption('false');
  await expect(individual).toContainText('当前生效：禁止 · 文件范围不限制 · 禁止联网');
  await page.screenshot({animations:'disabled',path:path.join(output,'individual-permissions.png')});
  await dialog.getByRole('button',{name:'保存设置',exact:true}).click();await expect(dialog).toHaveCount(0);
  assert.deepEqual(engine.settings.memberPermissions[person.id],{commands:'deny',network:false});assert.equal(engine.settings.permissions[executor.id].fileScope,'any');
  await open();await dialog.getByRole('button',{name:'权限',exact:true}).click();await expect(individual.getByLabel('新增人物 单独联网')).toHaveValue('false');
  await individual.getByLabel('新增人物 单独联网').selectOption('inherit');await dialog.getByRole('button',{name:'保存设置',exact:true}).click();assert.deepEqual(engine.settings.memberPermissions[person.id],{commands:'deny'});
  await open();
  await expect(dialog.locator('[data-provider="codex"]')).toContainText('内置适配 · Codex App Server');
  await expect(dialog.locator('[data-provider="acp-catalogzcode"]')).toContainText('外接适配 · ZCode 原生 CLI JSON · 官方清单管理');
  await dialog.locator('[data-provider="acp-catalogzcode"]').getByRole('button',{name:'使用官方默认',exact:true}).click();
  const connection=dialog.locator(`[data-provider="${executor.id}"]`),model=connection.getByLabel('模型',{exact:true}),effort=connection.getByLabel('思考程度',{exact:true});
  await expect(model).toHaveValue('fast');
  await expect(effort.locator('option[value="low"]')).toHaveCount(1);
  await model.selectOption('deep');await expect(effort).toBeDisabled();await model.selectOption('fast');release();await expect(effort.locator('option[value="low"]')).toHaveCount(1);await expect(effort.locator('option[value="high"]')).toHaveCount(0);
  await model.selectOption('deep');await expect(effort.locator('option[value="high"]')).toHaveCount(1);await expect(effort.locator('option[value="low"]')).toHaveCount(0);await effort.selectOption('high');
  await dialog.getByRole('button',{name:'保存设置',exact:true}).click();assert.equal(engine.settings.models[executor.id],'deep');assert.equal(engine.settings.efforts[executor.id],'high');assert.equal(engine.settings.models['acp-catalogzcode'],'');
  await open();await model.selectOption('');await dialog.getByRole('button',{name:'保存设置',exact:true}).click();assert.equal(engine.settings.models[executor.id],'','selecting the program default clears the old connection model');
  await open();failConfig=true;await model.selectOption('deep');await expect(connection).toContainText('模拟能力读取失败');await expect(effort).toBeEnabled();await expect(page.locator('.toast').filter({hasText:'模拟能力读取失败'})).toHaveCount(0);await dialog.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(engine.store.list('runs').length,0);assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'result.json'),JSON.stringify({newAndHiddenPeople:true,individualOverridesPersist:true,inheritRestored:true,accurateProtocols:true,modelDependentEfforts:true,staleResponsesIgnored:true,modelRequests:0},null,2));
  console.log('Member permissions/configuration UI passed: new and hidden people, independent overrides, inheritance, actual protocols, per-model options, stale-response protection. No model requests.');
}catch(error){await page.screenshot({animations:'disabled',path:path.join(output,'failure.png')});throw error;}
finally{release();await browser.close();await server.close();await engine.close();assert.equal(path.dirname(data),root);await rm(data,{recursive:true,force:true,maxRetries:5});}
