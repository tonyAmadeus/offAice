import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm,readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {chromium,expect as baseExpect} from '@playwright/test';
// Cold Windows fixture initialization can exceed five seconds; still require each real UI state.
const expect=baseExpect.configure({timeout:15000});
import {createServer} from '../../scripts/ui-test-server.mjs';
import {Engine} from '../../src/backend/engine.ts';
import {catalogEntry} from '../../src/shared/executor-catalog.ts';
import {cursorPackage} from '../fixtures/cursor-package.ts';

const root=path.resolve('.test-cache/catalog-ui');await mkdir(root,{recursive:true});
const data=await mkdtemp(path.join(root,'run-')),output=path.resolve('.test-cache/ui-executor-catalog');await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
let release,hold=true,publish=Promise.resolve(),mockLogin,finishLogin,finishCursorLogin,failProgressReads=true;
const updateChecks=[],progressReads=[];
const authorized=new Set(),loginRequests=[];
async function program(id,version){
  const entry=catalogEntry(id),prefix=path.join(data,'members',id,version);
  if(id==='cursor')return cursorPackage(prefix,version);
  if(id==='qoder'||id==='qodercn'){const file=path.join(prefix,(id==='qodercn'?'qoderclicn.exe':'qodercli.exe')),contents=Buffer.from('fixture');await mkdir(prefix,{recursive:true});await writeFile(file,contents);await writeFile(path.join(prefix,'.airoom-install.json'),JSON.stringify({schema:1,member:id,version,entry:(id==='qodercn'?'qoderclicn.exe':'qodercli.exe'),entrySize:contents.length,entrySha256:createHash('sha256').update(contents).digest('hex')}));return {version,entry:file};}
  if(id==='zcode'){
    const relative='resources/glm/zcode.cjs',file=path.join(prefix,relative),contents=Buffer.from("console.log('fixture')");await mkdir(path.dirname(file),{recursive:true});await writeFile(file,contents);const provider=path.join(prefix,'resources/glm/provider/zcode-builtin.json');await mkdir(path.dirname(provider),{recursive:true});await writeFile(provider,'{}');await writeFile(path.join(prefix,'.airoom-install.json'),JSON.stringify({schema:3,member:id,version,entry:relative,entrySha256:createHash('sha256').update(contents).digest('hex'),files:[{path:relative,size:contents.length},{path:'resources/glm/provider/zcode-builtin.json',size:2,sha256:createHash('sha256').update('{}').digest('hex')}]}));return {version,entry:file};
  }
  const folder=path.join(prefix,'node_modules',...entry.packageName.split('/'));await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'package.json'),JSON.stringify({name:entry.packageName,version,bin:{[entry.bin]:'cli.cjs'}}));await writeFile(path.join(folder,'cli.cjs'),`console.log('${version}')`);await writeFile(path.join(prefix,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{['node_modules/'+entry.packageName]:{version,integrity:'sha512-Zml4dHVyZQ=='}}}));return {version,entry:path.join(folder,'cli.cjs')};
}
const factory=id=>({probe:async()=>({id,name:id,available:authorized.has(id),runtimeReady:id.startsWith('acp-'),auth:authorized.has(id)?'subscription':'none',detail:authorized.has(id)?'已连接，存在官方登录记录。':'程序已连接，需要登录。未发送模型任务。',capabilities:{streaming:id!=='acp-catalogzcode',write:true,history:false,cancel:'native',steer:false}}),start:async()=>assert.fail('UI acceptance must not dispatch a model'),stop:async()=>{}});
const engine=new Engine(data,event=>{publish=publish.then(()=>page.evaluate(event=>window.__listeners?.forEach(fn=>fn(event)),event)).catch(()=>{});},()=>{},factory,undefined,async(_data,id,version,_env,options)=>{options.progress({phase:'installing',writtenBytes:1024*1024,lastProgressAt:new Date().toISOString()});if(hold){hold=false;await new Promise(resolve=>release=resolve);}return program(id,version);});
try{
  await engine.probe();
  await page.exposeFunction('__invoke',async(method,params)=>{
    if(method==='catalog.installation'){if(failProgressReads)throw new Error('读取下载进度未及时响应');const value=await engine.invoke(method,params);progressReads.push(Date.now());return value;}
    if(method==='executor.authenticate'&&params.id==='acp-catalogcursor'){mockLogin={phase:'waiting',message:'请在 Cursor 官方网页完成授权',url:'https://cursor.com/loginDeepControl?fixture=1'};return new Promise(resolve=>finishCursorLogin=()=>{mockLogin={phase:'completed',message:'官方授权已完成，正在检查连接。'};resolve({detail:'登录已完成'});});}
    if(method==='executor.authenticate'){if(params.id==='acp-catalogzcode'){assert.equal(engine.store.executors().find(item=>item.id===params.id).authentication,params.methodId);loginRequests.push(params.methodId);authorized.add(params.id);await engine.probe(params.id);mockLogin={phase:'completed',message:'官方授权已完成，连接检查通过。'};return {detail:'登录已完成'};}mockLogin={phase:'waiting',message:'请在官方网页完成授权',url:'https://qoder.com/cli/login?fixture=1',code:'ABCD-1234'};return new Promise((resolve,reject)=>finishLogin=()=>reject(new Error('登录已取消')));}
    if(method==='executor.loginStatus'&&mockLogin)return mockLogin;
    if(method==='executor.cancelLogin'&&mockLogin){mockLogin={phase:'cancelled',message:'登录已取消。'};finishLogin();return {cancelled:true};}
    if(method==='catalog.latest'){updateChecks.push(params.id);return {version:params.id==='qoder'?'1.1.67':catalogEntry(params.id).recommendedVersion};}
    if(method==='catalog.credentials'){const auth=catalogEntry(params.id).authentication.find(item=>item.id===params.authentication);return engine.invoke(method,{...params,secrets:params.value?{[auth.secretKeys[0]]:params.value}:{}});}
    return engine.invoke(method,params);
  });
  await page.addInitScript(()=>{window.__listeners=[];window.airoom={invoke:(method,params)=>window.__invoke(method,params),onEvent:fn=>{window.__listeners.push(fn);return()=>{window.__listeners=window.__listeners.filter(item=>item!==fn);};}};});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.getByRole('button',{name:'选择并下载执行端',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'设置与成员连接'}),catalog=dialog.locator('.catalog-settings');
  await expect(dialog.getByLabel('Claude 长期令牌',{exact:true})).toHaveCount(0);
  await expect(catalog.getByRole('group',{name:'官方执行端清单'}).getByRole('button')).toHaveCount(9);
  await expect(catalog.getByRole('button',{name:/ZCode CLI/})).toBeVisible();
  await page.screenshot({path:path.join(output,'01-add-and-list.png')});
  await expect(catalog.getByRole('button',{name:/Gemini CLI|Qwen Code/})).toHaveCount(0);
  await catalog.getByRole('button',{name:/Qoder CLI/}).click();
  const download=catalog.getByRole('button',{name:'下载并自动配置',exact:true});await expect(download).toBeDisabled();
  await expect(catalog.getByRole('link',{name:'厂商条款'})).toHaveAttribute('href',/qoder.com/);
  await catalog.getByRole('checkbox',{name:'我已了解并同意该厂商条款'}).check();await expect(download).toBeEnabled();
  await page.screenshot({path:path.join(output,'02-terms.png')});await download.click();
  await expect(catalog.getByRole('status').filter({hasText:'下载与安装'})).toBeVisible();await expect(catalog).toContainText('下载可能仍在继续');await expect(page.locator('.toast.error')).toHaveCount(0);const recoveryStarted=Date.now();failProgressReads=false;await expect(catalog).not.toContainText('暂时无法读取进度',{timeout:15000});assert.ok(progressReads.length,'the warning must clear after an actual successful progress read');console.log('Progress read recovered in '+(Date.now()-recoveryStarted)+' ms.');
  await page.screenshot({path:path.join(output,'03-download-progress.png')});release();
  await expect(catalog.getByRole('heading',{name:'登录',exact:true})).toBeVisible();
  await catalog.locator('.catalog-login').getByLabel('登录方式',{exact:true}).selectOption('qoder-token');
  await catalog.locator('.catalog-login').getByLabel('Qoder CLI API Key',{exact:true}).fill('ui-key-sentinel-38561');
  await catalog.locator('.catalog-login').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(output,'04-login.png')});
  await catalog.getByRole('button',{name:'保存密钥并检查',exact:true}).click();
  await expect(catalog.getByLabel('Qoder CLI API Key',{exact:true})).toHaveValue('');
  assert.ok(!JSON.stringify(engine.snapshot()).includes('ui-key-sentinel-38561'));
  await catalog.locator('.catalog-login').getByLabel('登录方式',{exact:true}).selectOption('qoder');await catalog.getByRole('button',{name:'官方浏览器登录',exact:true}).click();await expect(catalog).toContainText('ABCD-1234');await expect(catalog.getByRole('button',{name:'打开官方授权页面',exact:true})).toBeVisible();await catalog.getByRole('button',{name:'取消登录',exact:true}).click();await expect(catalog).toContainText('登录已取消');mockLogin=undefined;
  await program('qoder','1.1.65');await catalog.getByRole('button',{name:'从清单添加',exact:true}).click();await catalog.getByRole('button',{name:'从清单添加',exact:true}).click();
  await expect(catalog.locator('.catalog-version')).toHaveCount(2);await page.screenshot({path:path.join(output,'05-versions.png')});
  await catalog.getByRole('button',{name:'用这个执行端创建人物卡',exact:true}).click();
  await expect(dialog.getByLabel('使用的程序',{exact:true})).toHaveValue('acp-catalogqoder');
  await dialog.getByRole('button',{name:'返回团队',exact:true}).click();
  await catalog.getByRole('button',{name:/Qoder CN CLI/}).click();await expect(catalog.getByLabel('执行端下载版本',{exact:true})).toHaveValue('1.1.67');await catalog.getByRole('checkbox',{name:'我已了解并同意该厂商条款'}).check();await catalog.getByRole('button',{name:'下载并自动配置',exact:true}).click();await expect(catalog.getByRole('button',{name:'官方浏览器登录',exact:true})).toBeVisible();await catalog.getByRole('button',{name:'用这个执行端创建人物卡',exact:true}).click();await expect(dialog.getByLabel('使用的程序',{exact:true})).toHaveValue('acp-catalogqodercn');await expect(dialog.getByLabel('使用的程序',{exact:true}).locator('option[value="acp-catalogqoder"]')).toHaveCount(1);await dialog.getByRole('button',{name:'返回团队',exact:true}).click();await page.screenshot({path:path.join(output,'09-qoder-cn.png')});
  await catalog.getByRole('button',{name:/ZCode CLI/}).click();await expect(catalog).toContainText('ZCode 官方 Windows 发行包');await expect(catalog.getByLabel('执行端下载版本',{exact:true})).toHaveValue('3.14.5');await catalog.getByRole('checkbox',{name:'我已了解并同意该厂商条款'}).check();await catalog.getByRole('button',{name:'下载并自动配置',exact:true}).click();await expect(catalog.getByRole('button',{name:'官方浏览器登录',exact:true})).toBeVisible();
  const zcodeChoices=catalog.locator('.catalog-login').getByLabel('登录方式',{exact:true});await expect(zcodeChoices.locator('option')).toHaveText(['BigModel 中国区官方账号登录','Z.ai 海外官方账号登录']);await expect(zcodeChoices).toHaveValue('bigmodel');await expect(catalog).toContainText('中国区智谱账号请选择此项');
  await catalog.getByRole('button',{name:'官方浏览器登录',exact:true}).click();await expect(catalog).toContainText('官方授权已完成，连接检查通过。');await expect(catalog).not.toContainText('正在检查连接');mockLogin=undefined;
  await zcodeChoices.selectOption('zai');await expect(catalog).toContainText('海外 Z.ai 账号使用此项');await catalog.getByRole('button',{name:'官方浏览器登录',exact:true}).click();await expect.poll(()=>[...loginRequests]).toEqual(['bigmodel','zai']);await expect(catalog.getByRole('button',{name:'官方浏览器登录',exact:true})).toBeEnabled();await expect(catalog).toContainText('官方授权已完成，连接检查通过。');mockLogin=undefined;
  await zcodeChoices.selectOption('bigmodel');await catalog.getByRole('button',{name:'官方浏览器登录',exact:true}).click();await expect.poll(()=>[...loginRequests]).toEqual(['bigmodel','zai','bigmodel']);await expect(catalog.getByRole('button',{name:'官方浏览器登录',exact:true})).toBeEnabled();await expect(catalog).toContainText('官方授权已完成，连接检查通过。');mockLogin=undefined;assert.equal(engine.store.executors().find(item=>item.catalogId==='zcode').authentication,'bigmodel');
  await catalog.locator('.catalog-login').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'11-zcode-bigmodel-login.png')});
  await catalog.getByRole('button',{name:'用这个执行端创建人物卡',exact:true}).click();
  await expect(dialog.getByLabel('使用的程序',{exact:true})).toHaveValue('acp-catalogzcode');
  await expect(dialog.getByLabel('使用的程序',{exact:true}).locator('option[value="acp-catalogqoder"]')).toHaveCount(1);
  await dialog.getByRole('textbox',{name:'名字',exact:true}).fill('GLM');
  await dialog.getByRole('button',{name:'保存人物卡',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'编辑 GLM 的人物卡',exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'关闭对话框',exact:true}).click();
  const check=page.locator('.setup-item').filter({has:page.getByText('GLM',{exact:true})});
  await expect(check).toContainText('已就绪 · 订阅登录');
  await expect(check.getByRole('button',{name:'去设置',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'查看 GLM 的人物卡片',exact:true}).click();
  const memberCard=page.getByRole('dialog',{name:'GLM 的人物卡片',exact:true});
  await expect(memberCard.getByRole('button',{name:'去设置连接',exact:true})).toHaveCount(0);
  await expect(memberCard.getByRole('button',{name:'去 GLM 的工位聊天',exact:true})).toBeEnabled();
  await page.screenshot({path:path.join(output,'07-zcode-official.png'),animations:'disabled'});
  await memberCard.getByRole('button',{name:'去 GLM 的工位聊天',exact:true}).click();
  await expect(page.getByRole('main',{name:'个人工位',exact:true})).toBeVisible();
  await page.getByRole('button',{name:/^圆桌/}).click();
  await page.getByRole('main',{name:'圆桌',exact:true}).locator(':scope > .room-top').getByRole('button',{name:'开新议题',exact:true}).click();
  const roundtable=page.getByRole('dialog',{name:'开圆桌议题',exact:true});
  await expect(roundtable.getByRole('checkbox',{name:'GLM 参加圆桌',exact:true})).toBeEnabled();
  await expect(roundtable.getByRole('checkbox',{name:'GLM 参加圆桌',exact:true})).toBeChecked();
  await expect(roundtable.getByRole('combobox',{name:'圆桌汇总成员',exact:true}).locator('option')).toHaveText(['GLM']);
  await roundtable.getByRole('button',{name:'关闭对话框',exact:true}).click();
  await page.locator('.brand').click();
  await page.getByRole('button',{name:'设置与连接',exact:true}).click();
  if(!await catalog.getByRole('button',{name:/OpenCode/}).isVisible())await catalog.getByRole('button',{name:'从清单添加',exact:true}).click();
  await catalog.getByRole('button',{name:/OpenCode/}).click();await catalog.getByRole('checkbox',{name:'我已了解并同意该厂商条款'}).check();await catalog.getByRole('button',{name:'下载并自动配置',exact:true}).click();
  const openLogin=catalog.locator('.catalog-login'),choices=openLogin.getByLabel('登录方式',{exact:true});await expect(choices.locator('option[value="opencode-go"]')).toHaveCount(1);await expect(openLogin).toContainText('消耗订阅额度');await openLogin.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'08-subscription-choices.png')});await choices.selectOption('kimi-code-plan-cn');await expect(openLogin).toContainText('会员编程额度');await choices.selectOption('opencode');await expect(openLogin).toContainText('按所选厂商 API 用量计费');
  await catalog.getByRole('button',{name:/Cursor CLI/}).click();await expect(catalog).toContainText('Cursor 官方 Windows 发行包');await expect(catalog).toContainText('官方包自带 Node.js');await catalog.getByRole('checkbox',{name:'我已了解并同意该厂商条款'}).check();await catalog.getByRole('button',{name:'下载并自动配置',exact:true}).click();await expect(catalog).toContainText('与 Cursor 编辑器共享');await expect(catalog.getByLabel('Cursor CLI API Key',{exact:true})).toHaveCount(0);await expect(catalog.getByRole('button',{name:'官方浏览器登录',exact:true})).toBeVisible();await catalog.getByRole('button',{name:'官方浏览器登录',exact:true}).click();await expect(catalog).toContainText('请在 Cursor 官方网页完成授权');await expect(catalog.getByRole('button',{name:'打开官方授权页面',exact:true})).toBeVisible();mockLogin={phase:'checking',message:'官方授权已确认，正在检查连接…'};await expect(catalog).toContainText('官方授权已确认');await expect(catalog.getByRole('button',{name:'打开官方授权页面',exact:true})).toHaveCount(0);await expect(catalog.getByRole('button',{name:'官方浏览器登录',exact:true})).toBeDisabled();finishCursorLogin();await expect(catalog).toContainText('官方授权已完成');await expect(catalog.getByRole('button',{name:'取消登录',exact:true})).toHaveCount(0);await expect(catalog.getByRole('button',{name:'官方浏览器登录',exact:true})).toBeEnabled();mockLogin=undefined;await catalog.getByRole('button',{name:'用这个执行端创建人物卡',exact:true}).click();await expect(dialog.getByLabel('使用的程序',{exact:true})).toHaveValue('acp-catalogcursor');await dialog.getByRole('button',{name:'返回团队',exact:true}).click();await page.screenshot({path:path.join(output,'10-cursor-official.png')});
  await catalog.getByRole('button',{name:/Kimi Code CLI/}).click();await catalog.getByRole('checkbox',{name:'我已了解并同意该厂商条款'}).check();await catalog.getByRole('button',{name:'下载并自动配置',exact:true}).click();await expect(catalog.getByRole('button',{name:'官方浏览器登录',exact:true})).toBeVisible();
  for(const id of ['qoder','qodercn','zcode','opencode','cursor','kimi']){
    const name=catalogEntry(id).name,panel=dialog.locator(`.version-panel[aria-label="${name} 版本管理"]`);
    await panel.getByRole('button',{name:`${name} 检查新版本`,exact:true}).click();await expect(panel).toContainText(id==='qoder'?'1.1.67':catalogEntry(id).recommendedVersion);
  }
  assert.deepEqual(updateChecks,['qoder','qodercn','zcode','opencode','cursor','kimi']);
  const versionPanel=dialog.locator('.version-panel[aria-label="Qoder CLI 版本管理"]');
  await versionPanel.getByRole('button',{name:'更新到 1.1.67',exact:true}).click();await expect(versionPanel).toContainText('新版已安装并检查');
  await expect(versionPanel.locator('strong')).toHaveText('1.1.67');
  const oldPath=path.join(data,'members','qoder','1.1.65','qodercli.exe'),projectId=(await engine.invoke('project.create',{directory:await mkdtemp(path.join(data,'ui-history-project-'))})).id;
  engine.store.put('sessions','ui-old-qoder-history',{id:'ui-old-qoder-history',projectId,provider:'acp-catalogqoder',title:'保留旧版聊天',nativeId:'ui-native-history',executorIdentity:{path:oldPath},revision:1,writeMode:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  const profile=path.join(data,'native','acp','acp-catalogqoder');await mkdir(profile,{recursive:true});await writeFile(path.join(profile,'keep-login-fixture'),'keep');
  await versionPanel.locator('summary').click();await versionPanel.getByRole('button',{name:'Qoder CLI 删除版本 1.1.65',exact:true}).click();await expect(versionPanel).toContainText('旧版本程序目录已删除');
  await assert.rejects(lstat(path.dirname(oldPath)),/ENOENT/);assert.equal(engine.store.get('sessions','ui-old-qoder-history').nativeId,'ui-native-history');assert.equal(await readFile(path.join(profile,'keep-login-fixture'),'utf8'),'keep');
  await expect(versionPanel.getByRole('button',{name:'Qoder CLI 删除版本 1.1.67',exact:true})).toBeDisabled();await page.screenshot({path:path.join(output,'12-executor-version-management.png')});
  await catalog.getByRole('button',{name:'手动添加',exact:true}).click();await expect(catalog.getByLabel('程序名称',{exact:true})).toBeVisible();
  await page.screenshot({path:path.join(output,'06-manual.png')});
  assert.deepEqual(errors,[]);assert.equal(engine.store.list('runs').length,0);
  console.log('Executor catalog UI passed: catalog, consent, progress, credentials field clearing, versions, official subscription readiness in home/card/desk/roundtable, optional card binding, manual entry. Screenshots: '+output);
}catch(error){await page.screenshot({path:path.join(output,'failure.png')});console.error('Catalog failure state:',JSON.stringify({catalog:await page.locator('.catalog-settings').innerText().catch(()=>''),executors:engine.store.executors().map(item=>({id:item.id,command:item.command})),items:(await engine.invoke('catalog.list')).items.map(item=>({id:item.entry.id,configured:item.configured,selectedVersion:item.selectedVersion}))}));throw error;
}finally{release?.();await publish;await engine.close();await browser.close();await server.close();assert.equal(path.dirname(data),root);await rm(data,{recursive:true,force:true});}
