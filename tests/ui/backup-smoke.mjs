import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium, expect } from '@playwright/test';
import { createServer } from '../../scripts/ui-test-server.mjs';
import { Engine } from '../helpers/seeded-engine.ts'; // Scenarios opt into the built-in team; production starts empty.
import { BackupRestorer } from '../../src/backend/backup-restore.ts';
import { createBackup } from '../../src/backend/backup.ts';

const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM backup-ui-')),data=path.join(directory,'data'),projectDirectory=path.join(directory,'project'),output=path.resolve('.test-cache/ui-backup');await mkdir(projectDirectory);await mkdir(output,{recursive:true});await writeFile(path.join(projectDirectory,'file.txt'),'actual project');
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1360,height:900}}),errors=[],calls=[];
let acceptDelete=false;page.on('dialog',dialog=>acceptDelete?dialog.accept():dialog.dismiss());
page.on('pageerror',error=>errors.push(error.message));
let engine,dispatched=0;const push=event=>void page.evaluate(event=>window.__listeners?.forEach(listener=>listener(event)),event).catch(()=>{});
const factory=id=>({probe:async()=>({id,name:id,available:true,auth:'subscription',detail:'test only',capabilities:{steer:false,cancel:'native',streaming:true,write:true,history:true}}),start:async()=>{dispatched++;throw new Error('this smoke must not send native model requests');},stop:async()=>{}});
const createEngine=()=>new Engine(data,push,()=>{},factory,undefined,undefined,createBackup);
engine=createEngine();const restorer=new BackupRestorer(data);await engine.probe();
const project=await engine.invoke('project.create',{directory:projectDirectory,name:'备份验收项目'}),session=engine.createSession(project.id,'claude','需要保留的历史',true);
try{
  await page.exposeFunction('__rpc',async(method,params)=>{
    calls.push({method,params});
    if(method==='backup.prepare')return restorer.prepare(params.id);
    if(method==='backup.cancel')return restorer.cancel(params.token);
    if(method==='backup.restore'){
      assert.equal(params.confirm,true);await engine.invoke('internal.restore.begin');const before=await engine.invoke('internal.backup.beforeRestore');await engine.close();
      const result=await restorer.apply(params.token,before.id);engine=createEngine();push({type:'snapshot',snapshot:engine.snapshot()});return result;
    }
    try{return await engine.invoke(method,params??{});}catch(error){if(method.startsWith('backup.'))console.error('Backup fixture RPC failed:',method,error.message);throw error;}
  });
  await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:(method,params)=>window.__rpc(method,params),onEvent:fn=>{window.__listeners.push(fn);return()=>{window.__listeners=window.__listeners.filter(item=>item!==fn);};}};});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.getByRole('button',{name:'设置与连接',exact:true}).click();await page.getByRole('button',{name:'工作台',exact:true}).click();
  const section=page.getByRole('region',{name:'资料备份与恢复'});await section.getByRole('button',{name:'立即备份资料'}).click();await expect(section.getByRole('button',{name:'立即备份资料'})).toBeEnabled({timeout:30000});assert.equal(await section.getByRole('alert').count(),0,await section.innerText());await expect(section.getByRole('button',{name:'预览备份'})).toHaveCount(1);
  await section.getByRole('button',{name:/^删除备份 /}).click();await expect(section.getByRole('button',{name:'立即备份资料'})).toBeEnabled();assert.equal(calls.filter(call=>call.method==='backup.delete').length,0);
  acceptDelete=true;await section.getByRole('button',{name:/^删除备份 /}).click();await expect(section.getByRole('button',{name:'预览备份'})).toHaveCount(0);assert.ok(engine.store.get('sessions',session.id));assert.equal(calls.filter(call=>call.method==='backup.delete').length,1);
  await section.getByRole('button',{name:'立即备份资料'}).click();await expect(section.getByRole('button',{name:'立即备份资料'})).toBeEnabled({timeout:30000});assert.equal(await section.getByRole('alert').count(),0,await section.innerText());await expect(section.getByRole('button',{name:'预览备份'})).toHaveCount(1);
  const first=(await restorer.list())[0].id;await section.getByRole('button',{name:'立即备份资料'}).click();await expect(section.getByRole('button',{name:'立即备份资料'})).toBeEnabled();const latest=await restorer.list();assert.equal(latest.length,1);assert.notEqual(latest[0].id,first);
  await section.getByRole('button',{name:'预览备份'}).click();await expect(page.getByRole('group',{name:'备份内容预览'})).toContainText('内容校验通过');
  await section.getByRole('button',{name:'准备恢复这份备份'}).click();const confirm=page.getByRole('group',{name:'确认恢复资料'});await expect(confirm).toContainText('项目文件不会恢复到过去的状态');assert.equal(calls.filter(call=>call.method==='backup.restore').length,0);
  await confirm.getByRole('button',{name:'取消恢复'}).click();await expect(confirm).toHaveCount(0);assert.equal(calls.filter(call=>call.method==='backup.restore').length,0);
  await section.getByRole('button',{name:'准备恢复这份备份'}).click();await confirm.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'backup-restore-1360.png'),animations:'disabled'});
  await page.setViewportSize({width:1100,height:750});await confirm.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'backup-restore-1100.png'),animations:'disabled'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await confirm.getByRole('button',{name:'确认恢复并重启'}).click();await expect(page.getByRole('dialog',{name:'设置与成员连接'})).toHaveCount(0);
  assert.equal(engine.store.get('sessions',session.id).restoredHistoryOnly,true);assert.equal(engine.snapshot().automation.paused,true);assert.equal(dispatched,0);assert.equal(calls.filter(call=>call.method==='backup.restore').length,1);
  await page.getByRole('button',{name:'Claudia 的工位',exact:true}).click();await page.getByRole('button',{name:'切换工位文件夹'}).click();await page.getByRole('dialog',{name:'切换工位文件夹'}).getByRole('button',{name:'切换到 '+project.name,exact:true}).click();await expect(page.getByRole('textbox',{name:'在工位里说话'})).toBeDisabled();await expect(page.getByRole('main',{name:'个人工位'})).toContainText('这份话题只供阅读');
  assert.equal((await restorer.list()).length,1);assert.deepEqual(errors,[]);console.log('Backup smoke passed: real temporary SQLite, cancelled/confirmed deletion without changing current data, retain latest only, preview, cancellation, explicit restore after rotation, read-only history, 1100/1360 layout, zero model requests.');
}finally{await engine.close();await browser.close();await server.close();await rm(directory,{recursive:true,force:true});}
