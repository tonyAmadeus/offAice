import '../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron,expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import {desktopScreenshot} from './helpers/desktop-screenshot.mjs';

// This smoke test never starts a login or sends a model task.
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const executable=process.env.AIROOM_ELECTRON_EXE||path.join(root,'node_modules','electron','dist','electron.exe');
// A copied development runtime can live outside a project carrying a low-integrity label.
const appArgs=process.env.AIROOM_ELECTRON_EXE&&process.env.AIROOM_SMOKE_DEV!=='1'?[]:[process.env.AIROOM_SMOKE_APP_ROOT||root];
if(!existsSync(executable))throw new Error('Electron 尚未下载完成，真实桌面冒烟测试未执行。');
if(!existsSync(path.join(root,'dist','main.mjs')))throw new Error('请先构建 AIROOM，再运行桌面冒烟测试。');
const testingRoot=path.join(root,'.airoom-smoke');await mkdir(testingRoot,{recursive:true});
const directory=await mkdtemp(path.join(testingRoot,'run-'));
const dataDirectory=path.join(directory,'data'),projectDirectory=path.join(directory,'project');await mkdir(projectDirectory);
// Exercise the production lock path with a fresh user profile, without waking the daily app.
const testUserProfile=path.join(directory,'test-user');await mkdir(testUserProfile);
const env={...process.env,USERPROFILE:testUserProfile,AIROOM_DATA_DIR:dataDirectory};delete env.ELECTRON_RUN_AS_NODE;
let application;
// Images are framed on the editor preview: a real mouse drag moves, the wheel zooms.
async function frame(page,name,{dx=0,dy=0,wheel=0}) {
  const group=page.getByRole('group',{name}),box=await group.boundingBox();const x=box.x+box.width/2,y=box.y+box.height/2;
  await page.mouse.move(x,y);
  if(wheel){
    const zoom=()=>group.locator('.avatar,.card-preview-portrait').evaluate(node=>node.style.getPropertyValue(node.classList.contains('avatar')?'--zoom':'--portrait-scale'));
    const before=await zoom();await page.mouse.wheel(0,wheel);await expect.poll(zoom).not.toBe(before);
  }
  if(dx||dy){await page.mouse.down();await page.mouse.move(x+dx,y+dy,{steps:5});await page.mouse.up();}
}
async function reopenFromExecutable(launchEnv=env,launchExecutable=executable) {
  await new Promise((resolve,reject)=>{
    const args=[...(process.env.AIROOM_SMOKE_NO_SANDBOX==='1'?['--no-sandbox']:[]),...appArgs];
    const child=spawn(launchExecutable,args,{cwd:root,env:launchEnv,windowsHide:true,stdio:'ignore'});
    const timer=setTimeout(()=>{child.kill();reject(new Error('second launch did not return'));},10000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`second launch exited ${code}`));});
  });
  for(let attempt=0;attempt<50;attempt++){
    if(await application.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return w.isVisible()&&!w.isMinimized();}))return;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('relaunch must restore the existing visible window');
}
async function probeProviders(page,filename) {
  const providers=await page.evaluate(()=>window.airoom.invoke('provider.probe'));
  const summary=providers.map(({id,path,version,detail,auth,available,runtimeReady,installationRequired})=>({id,path,version,detail,auth,available,runtimeReady,installationRequired}));
  await writeFile(path.join(directory,filename),JSON.stringify(summary,null,2),'utf8');
  console.log('Provider status (no model request): '+JSON.stringify(summary));
  assert.deepEqual(summary.map(item=>item.id).sort(),['claude','codex','dsh'],'the retired API stand-in is not probed');
  assert.ok(providers.every(info=>info.auth==='none'||info.installationRequired),'fresh distribution offers download for missing programs or login for installed signed-out programs, never a native initialization failure');
  assert.equal(providers.find(info=>info.id==='codex').capabilities.images,true,'Codex exposes native local picture input');
  assert.equal(providers.find(info=>info.id==='dsh').capabilities.images,false,'a signed-out DSH cannot claim an unverified model image capability');
  for(const info of providers)if(info.authDirectory)assert.equal(path.resolve(info.authDirectory),path.join(dataDirectory,'native',info.id,...(info.id==='codex'?['home']:[])),'each probe uses its independent account directory');
}
try {
  const diagnosticArgs=process.env.AIROOM_SMOKE_NO_SANDBOX==='1'?['--no-sandbox']:[];
  application=await _electron.launch({executablePath:executable,args:[...diagnosticArgs,...appArgs],cwd:root,env,timeout:45000});
  const page=await application.firstWindow();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  if(process.env.AIROOM_SMOKE_CHECK_BUILD==='1') {
    const packagedRoot=await application.evaluate(({app})=>app.getAppPath());
    const checked=[];
    for(const file of ['main.mjs','worker.mjs','preload.cjs']) {
      const expected=createHash('sha256').update(await readFile(path.join(root,'dist',file))).digest('hex');
      const actual=createHash('sha256').update(await readFile(path.join(packagedRoot,'dist',file))).digest('hex');
      assert.equal(actual,expected,`packaged ${file} must match the current build`);checked.push({file,sha256:actual});
    }
    await writeFile(path.join(directory,'packaged-build-check.json'),JSON.stringify({appRoot:packagedRoot,files:checked},null,2),'utf8');
    console.log('Extracted packaged main, worker and preload hashes match the current build.');
  }
  const preferences=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(preferences.contextIsolation,true);assert.equal(preferences.nodeIntegration,false);assert.equal(preferences.sandbox,true);
  assert.equal(await application.evaluate(({app})=>app.getPath('userData')),path.join(testUserProfile,'.airoom','data','electron'),'all entries share the same user-profile instance lock');
  assert.equal(await application.evaluate(({app})=>app.getPath('sessionData')),path.join(dataDirectory,'electron','session'),'browser session storage stays with the selected data directory');
  await page.waitForFunction(()=>typeof window.airoom?.invoke==='function');
  const snapshot=await page.evaluate(()=>window.airoom.invoke('snapshot'));
  assert.ok(snapshot?.backendReady,'utility worker + MessagePort RPC did not become ready');
  if(process.platform==='win32'){
    const windowState=await application.evaluate(({BrowserWindow,app})=>({handle:BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString(),icon:app.getAppPath()+'\\dist\\airoom.ico',exe:process.execPath}));
    const state=JSON.parse(execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(root,'tests/helpers/windows-window-state.ps1'),'-Handle',windowState.handle,'-IconOutput',path.join(directory,'windows-taskbar-icon.png')],{windowsHide:true,encoding:'utf8',timeout:30000}).trim());
    await writeFile(path.join(directory,'windows-window-state.json'),JSON.stringify(state,null,2));
    assert.equal(state.appId,'local.airoom.desktop');assert.equal(state.relaunchName,'AIROOM');
    assert.ok(state.relaunchCommand.includes(windowState.exe),'taskbar relaunch targets the running executable');
    assert.ok(state.relaunchIcon.includes(windowState.icon),'taskbar icon targets this actual application directory');
    assert.equal(state.hasWindowIcon,true,'the native window has a real icon');
    console.log('Native Windows window icon and taskbar relaunch properties verified.');
  }
  assert.deepEqual(snapshot.members,[],'first launch has no pre-created character cards');
  assert.deepEqual(snapshot.executors,[],'first launch has no pre-created connections');
  assert.deepEqual(await page.evaluate(()=>window.airoom.invoke('provider.probe')),[],'first launch does not discover unconfigured programs');
  // The rest of this scenario explicitly adds its team through the same user action.
  for(const [id,name] of [['claude','Claudia'],['codex','Gptia'],['dsh','DS']])await page.evaluate(({id,name})=>window.airoom.invoke('team.save',{addTemplate:true,member:{id,executor:id,name,templateId:id}}),{id,name});
  await assert.rejects(page.evaluate(()=>window.airoom.invoke('provider.tokenLogin',{provider:'claude'})),/官方 Claude Code/,'fresh installations do not collect subscription tokens');
  await assert.rejects(page.evaluate(()=>window.airoom.invoke('secret.set',{provider:'claude',value:'sk-ant-fixture-new-token'})),/官方 Claude Code/,'the main process also refuses a fresh subscription-token write');
  assert.equal(snapshot.dataDirectory,dataDirectory);assert.equal(snapshot.projects.length,0);
  const draftScope={roomId:'global',threadId:snapshot.room.currentThreadId};
  await page.evaluate(scope=>window.airoom.invoke('composer.draft.save',{...scope,value:{text:'桌面 IPC 草稿，仅隔离保存',attachments:[]}}),draftScope);
  assert.equal((await page.evaluate(scope=>window.airoom.invoke('composer.draft.get',scope),draftScope)).text,'桌面 IPC 草稿，仅隔离保存');
  assert.equal((await page.evaluate(()=>window.airoom.invoke('snapshot'))).runs.length,snapshot.runs.length,'native draft persistence does not start any run');
  await page.evaluate(scope=>window.airoom.invoke('composer.draft.save',{...scope,value:{text:'',attachments:[]}}),draftScope);
  assert.equal(await page.evaluate(scope=>window.airoom.invoke('composer.draft.get',scope),draftScope),null);
  const automatic=await page.evaluate(()=>window.airoom.invoke('automation.list'));assert.ok(automatic.usage.every(item=>!item.enabled&&item.used===0),'automatic native calls stay closed in a fresh profile');
  const timer=await page.evaluate(at=>window.airoom.invoke('automation.save',{name:'桌面定时测试',schedule:{kind:'once',at},action:{kind:'notice',text:'仅用于定时接口验证'}}),new Date(Date.now()+3_600_000).toISOString());assert.equal(timer.enabled,false);
  await page.evaluate(()=>window.airoom.invoke('automation.policy.save',{policies:{'scheduled-message':{enabled:false,dailyLimit:2}}}));
  await page.evaluate(()=>window.airoom.invoke('automation.pause'));assert.equal((await page.evaluate(()=>window.airoom.invoke('automation.list'))).paused,true);
  await page.evaluate(()=>window.airoom.invoke('automation.resume'));assert.equal((await page.evaluate(()=>window.airoom.invoke('automation.list'))).paused,false);
  await assert.rejects(page.evaluate(()=>window.airoom.invoke('room.end',{discussionId:'stale-discussion'})),/讨论已切换/,'the end RPC is exposed but never acts on a stale discussion');
  await assert.rejects(page.evaluate(()=>window.airoom.invoke('room.generateImage',{memberId:'codex',text:'绘图接口检查，不发送模型请求'})),/连接|登录/,'the image RPC reaches the backend and refuses a signed-out account before delivery');
  await probeProviders(page,'providers.json');
  const balance=await page.evaluate(()=>window.airoom.invoke('provider.balance',{provider:'dsh'}));
  assert.equal(balance.balance.status,'unavailable','an isolated signed-out account cannot invent a balance');assert.deepEqual(balance.windows,[]);
  const quota=await page.evaluate(()=>window.airoom.invoke('provider.quota',{provider:'claude'}));
  assert.equal(quota.queryStatus,'unavailable','signed-out Claude reports unavailable instead of waiting forever');assert.deepEqual(quota.windows,[]);
  const attention=await page.evaluate(()=>window.airoom.invoke('attention.list'));
  const checkedProviders=(await page.evaluate(()=>window.airoom.invoke('snapshot'))).providers;
  const needsLogin=checkedProviders.filter(provider=>provider.auth==='none'&&!provider.available&&!provider.stale&&provider.runtimeReady!==false);
  const login=attention.items.find(item=>item.kind==='login');
  if(needsLogin.length){
    assert.ok(login,'an installed signed-out program offers a login reminder');
    const ignored=await page.evaluate(item=>window.airoom.invoke('attention.dismiss',{id:item.id,fingerprint:item.fingerprint}),login);
    assert.ok(!ignored.items.some(item=>item.id===login.id),'the real preload/main/worker route can ignore a reminder');
  }else{
    assert.equal(login,undefined,'uninstalled or unready programs must not offer a misleading login reminder');
    await assert.rejects(page.evaluate(()=>window.airoom.invoke('attention.dismiss',{id:'login:missing-fixture',fingerprint:'missing-fixture'})),/刷新|不存在|变化|无效|找不到/,'the real route rejects a reminder that does not exist');
    if(checkedProviders.some(provider=>provider.installationRequired))await page.getByRole('button',{name:'选择并下载执行端',exact:true}).waitFor({state:'visible'});
  }
  assert.ok((await page.evaluate(()=>window.airoom.invoke('snapshot'))).providers.every(provider=>provider.auth==='none'||provider.auth==='unknown'),'ignoring never signs a program in');
  await assert.rejects(page.evaluate(()=>window.airoom.invoke('internal.room.opened',{visible:true})),/不支持|不可用|不能|未注册|允许|未知/,'the renderer cannot fabricate a first opening');
  const life=await page.evaluate(()=>window.airoom.invoke('settings.save',{dailyLife:{memberChatMinutes:5}}));assert.equal(life.dailyLife.memberChatMinutes,5);
  const created=await page.evaluate(directory=>window.airoom.invoke('project.create',{directory,name:'桌面测试项目'}),projectDirectory);
  assert.equal(created.directory,projectDirectory);
  const invalid=await page.evaluate(async()=>{try{await window.airoom.invoke('internal.key',{value:'blocked-test'});return false;}catch{return true;}});
  assert.equal(invalid,true,'renderer should never reach private key RPC');
  const settings=await page.evaluate(()=>window.airoom.invoke('settings.save',{networkMode:'tun'}));assert.equal(settings.networkMode,'tun');
  // The DeepSeek API stand-in is retired; a read-only session stays read-only.
  const session=await page.evaluate(projectId=>window.airoom.invoke('session.create',{projectId,provider:'codex',writeMode:false}),created.id);
  assert.equal(session.writeMode,false);
  const artifacts=await page.evaluate(sessionId=>window.airoom.invoke('artifact.list',{sessionId}),session.id);assert.equal(artifacts.length,0);
  // Exercise native image import and protocol loading, not only a renderer fixture.
  const imageSource=path.join(root,'src','renderer','assets','members','claudia.webp');
  const sourceBytes=await readFile(imageSource);
  await application.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},imageSource);
  const imported=await page.evaluate(()=>window.airoom.invoke('asset.import'));
  assert.match(imported.file,/^[a-f0-9-]{36}\.webp$/);
  assert.deepEqual(await readFile(path.join(dataDirectory,'assets',imported.file)),sourceBytes);
  assert.deepEqual(await readFile(imageSource),sourceBytes,'image import never alters its source');
  const dimensions=await page.evaluate(file=>new Promise((resolve,reject)=>{
    const image=new Image();image.onload=()=>resolve([image.naturalWidth,image.naturalHeight]);image.onerror=()=>reject(new Error('imported avatar did not load'));image.src=`airoom-asset://local/${file}`;
  }),imported.file);
  assert.ok(dimensions.every(size=>size>0),'the imported image loads under the real packaged CSP');
  const [attachedImage]=await page.evaluate(file=>window.airoom.invoke('attachment.import',{paths:[file]}),imageSource);
  const attachedDimensions=await page.evaluate(file=>new Promise((resolve,reject)=>{
    const image=new Image();image.onload=()=>resolve([image.naturalWidth,image.naturalHeight]);image.onerror=()=>reject(new Error('stored picture did not load'));image.src=`airoom-asset://local/attachments/${file.id}/${encodeURIComponent(file.name)}`;
  }),attachedImage);
  assert.deepEqual(attachedDimensions,dimensions,'generated-picture URLs use the same real local protocol and CSP');
  const savedPicture=path.join(directory,'saved-picture.webp');
  await application.evaluate(({dialog},file)=>{global.__airoomSaveDialog=dialog.showSaveDialog;dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},savedPicture);
  const saved=await page.evaluate(file=>window.airoom.invoke('attachment.save',{id:file.id,name:file.name}),attachedImage);assert.equal(saved.saved,true);assert.deepEqual(await readFile(savedPicture),sourceBytes);
  await application.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>({canceled:true});});
  assert.equal((await page.evaluate(file=>window.airoom.invoke('attachment.save',{id:file.id,name:file.name}),attachedImage)).saved,false);
  await assert.rejects(page.evaluate(()=>window.airoom.invoke('attachment.save',{id:'../outside',name:'image.png'})),/图片无效/);
  await application.evaluate(({dialog})=>{dialog.showSaveDialog=global.__airoomSaveDialog;delete global.__airoomSaveDialog;});
  assert.deepEqual(await readFile(imageSource),sourceBytes,'saving a picture leaves its original intact');
  const oversized=path.join(directory,'oversized.webp');await writeFile(oversized,Buffer.alloc(8*1024*1024+1));
  await application.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},oversized);
  await assert.rejects(page.evaluate(()=>window.airoom.invoke('asset.import')),/8 MB/);
  const card=await page.evaluate(file=>window.airoom.invoke('team.save',{member:{executor:'codex',name:'桌面测试审稿人',userTitle:'测试官',persona:'简短回答',memory:'测试资料',portrait:file}}),imported.file);
  assert.equal(card.executor,'codex');assert.equal(card.portrait,imported.file);
  // Save actual editor controls through renderer -> IPC -> SQLite, including an uploaded portrait.
  // The home card remains a conversation entry; editing is available only in settings.
  await page.getByRole('button',{name:'查看 桌面测试审稿人 的人物卡片'}).click();
  const thumbnail=page.getByRole('dialog',{name:'桌面测试审稿人 的人物卡片'});await expect(thumbnail.getByRole('button',{name:'编辑人物卡'})).toHaveCount(0);await thumbnail.getByRole('button',{name:'关闭人物卡片'}).click();await page.getByRole('button',{name:'设置与连接',exact:true}).click();await page.getByRole('button',{name:'团队成员',exact:true}).click();await page.getByRole('button',{name:'编辑 桌面测试审稿人 的人物卡'}).click();
  const cardDialog=page.getByRole('dialog',{name:'设置与成员连接'});
  await frame(page,'调整头像',{dx:20,dy:10,wheel:-300});await frame(page,'调整立绘',{dx:24,dy:-16,wheel:300});
  const framed=await page.evaluate(()=>{const avatar=document.querySelector('.card-preview-avatar .avatar').style,portrait=document.querySelector('.card-preview-portrait').style;
    return {face:{x:Number(avatar.getPropertyValue('--fx')),y:Number(avatar.getPropertyValue('--fy')),zoom:Number(avatar.getPropertyValue('--zoom'))},portraitScale:Number(portrait.getPropertyValue('--portrait-scale')),portraitOffset:{x:Number(portrait.getPropertyValue('--px')),y:Number(portrait.getPropertyValue('--py'))}};});
  assert.ok(framed.portraitScale<1&&framed.portraitOffset.x>0&&framed.portraitOffset.y<0&&framed.face.zoom>3,'dragging and scrolling on the previews frames both images');
  // A native capture must explicitly restore a non-drawing window before waiting for paint.
  const captureWindow=await application.browserWindow(page);
  await captureWindow.evaluate(w=>w.minimize());
  await expect.poll(()=>captureWindow.evaluate(w=>w.isMinimized())).toBe(true);
  await desktopScreenshot(application,page,path.join(directory,'image-controls.png'));
  assert.equal(await captureWindow.evaluate(w=>w.isVisible()&&!w.isMinimized()),true);
  await page.getByRole('button',{name:'保存人物卡',exact:true}).click();
  await cardDialog.getByRole('button',{name:'编辑 桌面测试审稿人 的人物卡'}).waitFor();
  const imageCard=(await page.evaluate(()=>window.airoom.invoke('snapshot'))).members.find(member=>member.id===card.id);
  assert.deepEqual(imageCard.face,framed.face);assert.equal(imageCard.portraitScale,framed.portraitScale);assert.deepEqual(imageCard.portraitOffset,framed.portraitOffset);assert.equal(imageCard.portrait,imported.file);
  await cardDialog.getByRole('button',{name:'编辑 Claudia 的人物卡'}).click();
  // Switching from a different-shaped upload back to built-in art must discard the old measured aspect.
  const landscapeSource=path.join(root,'tests','fixtures','landscape-upload.png');
  await application.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},landscapeSource);
  await page.getByRole('button',{name:'上传立绘',exact:true}).click();
  await page.waitForFunction(()=>{
    const avatar=document.querySelector('.card-preview-avatar .avatar'),image=avatar?.querySelector('img');
    return image?.naturalWidth&&Math.abs(Number(avatar.style.getPropertyValue('--aspect'))-image.naturalHeight/image.naturalWidth)<0.0001;
  });
  await page.getByRole('button',{name:'用回默认立绘',exact:true}).click();
  const restoredAspect=await page.locator('.card-preview-avatar .avatar').evaluate(avatar=>Number(avatar.style.getPropertyValue('--aspect')));
  assert.ok(Math.abs(restoredAspect-1720/960)<0.0001,'restoring built-in art restores its own crop aspect');
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('button',{name:'关闭对话框'}).click();
  const profile=await page.evaluate(file=>window.airoom.invoke('profile.save',{profile:{name:'桌面测试用户',avatar:file}}),imported.file);
  // The public visibility RPC crosses the real renderer/main/worker boundary without changing the card configuration.
  await page.evaluate(id=>window.airoom.invoke('team.visibility',{id,hidden:true}),card.id);
  await page.locator(`.team-roster .roster-row.member-${card.id}`).waitFor({state:'detached'});
  assert.equal((await page.evaluate(()=>window.airoom.invoke('snapshot'))).members.find(member=>member.id===card.id)?.cardHidden,true);
  await assert.rejects(page.evaluate(id=>window.airoom.invoke('team.visibility',{id,hidden:'false'}),card.id),/显示或隐藏/);
  assert.equal(profile.avatar,imported.file);
  await page.evaluate(()=>window.airoom.invoke('room.clear'));
  // Seed only this fresh fixture database: the real account data is never opened.
  const roomBefore=await page.evaluate(()=>window.airoom.invoke('snapshot'));
  const topicId=roomBefore.room.currentThreadId;
  const fixtureDatabase=new DatabaseSync(path.join(dataDirectory,'airoom.sqlite'));
  try{
    fixtureDatabase.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    const insert=fixtureDatabase.prepare('INSERT INTO entities(entity,id,value) VALUES(?,?,?)');
    for(let index=0;index<303;index++){
      const message={id:'desktop-history-'+index,threadId:topicId,author:index===302?'codex':'user',authorName:index===302?'桌面主持人':'桌面测试用户',text:'桌面历史 '+index,at:'2026-10-04T02:00:00Z',status:'done',kind:index===302?'summary':undefined};
      insert.run('room_messages',message.id,JSON.stringify(message));
    }
    fixtureDatabase.exec('COMMIT');
  }finally{fixtureDatabase.close();}
  const firstPage=await page.evaluate(threadId=>window.airoom.invoke('room.history',{threadId,limit:100}),topicId);
  assert.equal(firstPage.messages.length,100);assert.equal(firstPage.hasMore,true);
  const secondPage=await page.evaluate(params=>window.airoom.invoke('room.history',params),{threadId:topicId,before:firstPage.before,limit:100});
  assert.equal(secondPage.messages[0].id,'desktop-history-103');
  const fullExport=await page.evaluate(threadId=>window.airoom.invoke('room.export',{threadId}),topicId);
  assert.equal(fullExport.count,303);assert.ok(fullExport.content.includes('桌面历史 0')&&fullExport.content.includes('桌面历史 302')&&fullExport.content.includes('会议总结'));
  await assert.rejects(page.evaluate(()=>window.airoom.invoke('room.send',{text:'@不存在',mode:'discuss',style:'chat',memberIds:['codex']})),/找不到/);
  await page.evaluate(()=>window.airoom.invoke('room.archive'));
  const afterArchive=await page.evaluate(()=>window.airoom.invoke('snapshot'));
  assert.notEqual(afterArchive.room.currentThreadId,topicId);assert.equal(afterArchive.room.messages.length,0);
  assert.equal((await page.evaluate(threadId=>window.airoom.invoke('room.history',{threadId}),topicId)).messages.length,100);
  const archivedExport=await page.evaluate(threadId=>window.airoom.invoke('room.export',{threadId}),topicId);
  await page.locator('.room-entry').filter({hasText:'茶歇室'}).click();
  await page.getByRole('combobox',{name:'话题记录'}).selectOption(topicId);
  await page.getByText('桌面历史 302',{exact:true}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'在聊天室里说话'}).count(),0);
  const roomExportFile=path.join(directory,'room-export.md');
  await application.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},roomExportFile);
  await page.getByRole('button',{name:'话题操作'}).click();await page.getByRole('menuitem',{name:'导出聊天室'}).click();
  // Export runs from the topic menu; wait for the file the save dialog was pointed at.
  let roomExport='';for(let attempt=0;attempt<150&&!roomExport;attempt++){try{roomExport=await readFile(roomExportFile,'utf8');}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
  assert.equal(roomExport,archivedExport.content,'the actual desktop save dialog writes the complete archive');
  await page.getByRole('button',{name:'回到当前话题'}).click();
  await page.evaluate(()=>window.airoom.invoke('room.clear'));
  assert.equal((await page.evaluate(threadId=>window.airoom.invoke('room.export',{threadId}),topicId)).count,303,'clearing current history preserves archives');
  await page.evaluate(threadId=>window.airoom.invoke('room.delete',{threadId}),topicId);
  assert.equal((await page.evaluate(()=>window.airoom.invoke('snapshot'))).room.threads.length,1);
  await writeFile(path.join(directory,'room-history-check.json'),JSON.stringify({ipcMethods:true,paged:100,total:303,completeMarkdownExport:true,summaryLabel:true,archiveReadOnly:true,clearPreservesArchive:true,deleteArchive:true,noModelCalls:true},null,2));
  await desktopScreenshot(application,page,path.join(directory,'desktop.png'));
  await application.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.close();return window.isVisible();}).then(value=>assert.equal(value,false,'close should keep the app in tray'));
  await reopenFromExecutable();
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].minimize());
  await reopenFromExecutable();
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({x:-30000,y:-30000,width:1100,height:750}));
  await reopenFromExecutable();
  assert.equal(await application.evaluate(({BrowserWindow,screen})=>{const b=BrowserWindow.getAllWindows()[0].getBounds(),a=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;return b.x>=a.x&&b.y>=a.y&&b.x+b.width<=a.x+a.width&&b.y+b.height<=a.y+a.height;}),true,'relaunch must bring an off-screen window into the current display');
  // All launch entries must find the same window even when their data paths / executable copies differ.
  const identity=await application.evaluate(({BrowserWindow})=>({pid:process.pid,windowId:BrowserWindow.getAllWindows()[0].id}));
  const alternateData=path.join(directory,'alternate-data');
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].hide());
  await reopenFromExecutable({...env,AIROOM_DATA_DIR:alternateData});
  if(process.env.AIROOM_ELECTRON_ALTERNATE_EXE){
    await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].minimize());
    await reopenFromExecutable({...env,AIROOM_DATA_DIR:path.join(directory,'other-entry-data')},process.env.AIROOM_ELECTRON_ALTERNATE_EXE);
  }
  const afterReopen=await application.evaluate(({BrowserWindow,app})=>({pid:process.pid,windowId:BrowserWindow.getAllWindows()[0].id,windowCount:BrowserWindow.getAllWindows().length,workers:app.getAppMetrics().filter(item=>item.type==='Utility'&&(item.name==='AIROOM 执行服务'||item.serviceName==='AIROOM 执行服务')).length}));
  assert.equal(afterReopen.pid,identity.pid);assert.equal(afterReopen.windowId,identity.windowId);assert.equal(afterReopen.windowCount,1);assert.equal(afterReopen.workers,1);
  assert.equal((await page.evaluate(()=>window.airoom.invoke('snapshot'))).dataDirectory,dataDirectory,'relaunch preserves the existing instance data and tasks');
  assert.equal(existsSync(path.join(alternateData,'airoom.sqlite')),false,'the second entry never starts another backend');
  assert.equal(existsSync(path.join(directory,'other-entry-data','airoom.sqlite')),false);
  await writeFile(path.join(directory,'single-instance-check.json'),JSON.stringify({sameWindow:true,mainProcessUnchanged:true,windowCount:1,workerCount:1,crossDataDirectory:true,crossExecutable:!!process.env.AIROOM_ELECTRON_ALTERNATE_EXE,trayRestore:true,minimizedRestore:true,offscreenRestore:true},null,2),'utf8');
  // An opaque fixture tests DPAPI storage, never authentication or a model request.
  const fixtureKey=randomBytes(24).toString('base64url');
  assert.equal(fixtureKey.length,32);
  assert.equal(await application.evaluate(({safeStorage})=>safeStorage.isEncryptionAvailable()),true,'Windows credential encryption must be available before saving');
  const savedSecret=await page.evaluate(value=>window.airoom.invoke('secret.set',{provider:'deepseek',value}),fixtureKey);
  assert.equal(savedSecret.saved,true);
  const secretPath=path.join(dataDirectory,'deepseek.secret'),ciphertext=await readFile(secretPath);
  assert.ok(ciphertext.length>0);assert.equal(ciphertext.includes(Buffer.from(fixtureKey)),false,'credential file must not contain plaintext');
  const roundTrip=await application.evaluate(({safeStorage},fixture)=>safeStorage.decryptString(Buffer.from(fixture.encrypted,'base64'))===fixture.value,{encrypted:ciphertext.toString('base64'),value:fixtureKey});
  assert.equal(roundTrip,true,'the saved ciphertext must decrypt through Windows safeStorage');
  const configuredSnapshot=await page.evaluate(()=>window.airoom.invoke('snapshot'));
  assert.equal(configuredSnapshot.deepseekKeyConfigured,true);assert.equal(JSON.stringify(configuredSnapshot).includes(fixtureKey),false,'snapshot must expose configuration state only');
  const diagnostic=await page.evaluate(()=>window.airoom.invoke('diagnostics.export'));
  assert.ok(path.relative(dataDirectory,diagnostic.path).startsWith('diagnostics'+path.sep));
  assert.equal((await readFile(diagnostic.path,'utf8')).includes(fixtureKey),false,'diagnostics must never contain plaintext credentials');
  await page.evaluate(()=>window.airoom.invoke('all.stop'));
  // Hold this test worker's connect message until explicitly released. No production delay hook.
  await application.evaluate(({utilityProcess})=>{
    const original=utilityProcess.fork;
    utilityProcess.fork=function(...args){
      utilityProcess.fork=original;
      const child=original.apply(this,args),post=child.postMessage.bind(child);
      globalThis.__readinessWorker=child;
      child.postMessage=(...message)=>{
        if(message[0]?.type==='connect')globalThis.__releaseWorker=()=>post(...message);
        else post(...message);
      };
      return child;
    };
  });
  await page.evaluate(()=>window.airoom.invoke('backend.restart'));
  await assert.rejects(page.evaluate(()=>window.airoom.invoke('provider.login',{provider:'codex'})),/尚未就绪/,'login must not start or queue while the worker is starting');
  await assert.rejects(page.evaluate(()=>window.airoom.invoke('profile.save',{profile:{name:'must not be queued'}})),/尚未就绪/);
  await page.evaluate(()=>{window.__startupReadSettled=false;window.__startupRead=window.airoom.invoke('snapshot').finally(()=>{window.__startupReadSettled=true;});});
  assert.equal(await page.evaluate(()=>window.__startupReadSettled),false,'a state read waits for the same worker');
  await application.evaluate(async()=>{
    const deadline=Date.now()+5000;
    while(!globalThis.__releaseWorker&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    if(!globalThis.__releaseWorker)throw new Error('test worker did not spawn');
    globalThis.__releaseWorker();delete globalThis.__releaseWorker;
  });
  let restored=await page.evaluate(()=>window.__startupRead);
  assert.ok(restored?.backendReady,'backend restart did not reconnect');assert.ok(restored.projects.some(project=>project.id===created.id));assert.ok(restored.sessions.some(item=>item.id===session.id));assert.equal(restored.runs.length,0);
  assert.equal(restored.automation.paused,true,'all-stop preserves the automation pause through restart');assert.ok(restored.automation.jobs.some(job=>job.id===timer.id&&!job.enabled));assert.equal(restored.automation.policies['scheduled-message'].dailyLimit,2);
  assert.equal(restored.settings.dailyLife.memberChatMinutes,5,'daily-life settings survive a real worker restart');
  assert.ok(restored.automation.usage.every(item=>item.used===0&&!item.enabled),'opening and worker restart never enable or dispatch automatic speech');
  assert.equal(restored.members.find(member=>member.id===card.id)?.persona,'简短回答','character cards persist through backend restart');
  assert.equal(restored.members.find(member=>member.id===card.id)?.cardHidden,true,'visibility survives the actual SQLite/worker restart');
  await page.evaluate(id=>window.airoom.invoke('team.visibility',{id,hidden:false}),card.id);
  await page.locator(`.team-roster .roster-row.member-${card.id}`).waitFor({state:'visible'});
  assert.deepEqual(restored.members.find(member=>member.id===card.id)?.face,framed.face);
  assert.equal(restored.members.find(member=>member.id===card.id)?.portraitScale,framed.portraitScale,'editor image framing survives the real SQLite/backend restart');
  assert.deepEqual(restored.members.find(member=>member.id===card.id)?.portraitOffset,framed.portraitOffset);
  assert.deepEqual(await readFile(imageSource),sourceBytes,'image adjustment never changes the original artwork');
  await writeFile(path.join(directory,'image-controls-check.json'),JSON.stringify({savedThroughEditor:true,...framed,backendRestartPreserves:true,restoredBuiltInAspect:true,originalArtworkUnchanged:true},null,2),'utf8');
  assert.equal(restored.profile.avatar,imported.file);assert.equal(restored.profile.name,'桌面测试用户');
  const retired=await page.evaluate(()=>window.airoom.invoke('team.save',{member:{executor:'codex',name:'保留历史的桌面角色',persona:'删除这个活动配置'}}));
  const retiredSession=await page.evaluate(p=>window.airoom.invoke('session.create',p),{projectId:created.id,provider:'codex',memberId:retired.id,title:'保留的桌面对话',writeMode:false});
  const retainedResult=path.join(dataDirectory,'desks',retired.id,'kept.txt');await writeFile(retainedResult,'keep this result');
  await page.evaluate(id=>window.airoom.invoke('team.delete',{id}),retired.id);
  const afterCardDeletion=await page.evaluate(()=>window.airoom.invoke('snapshot'));
  assert.ok(!afterCardDeletion.members.some(member=>member.id===retired.id));assert.equal(afterCardDeletion.removedMembers.find(member=>member.id===retired.id)?.name,retired.name);assert.equal(afterCardDeletion.removedMembers.find(member=>member.id===retired.id)?.persona,undefined);
  assert.ok(afterCardDeletion.sessions.some(item=>item.id===retiredSession.id&&item.memberId===retired.id));assert.equal(await readFile(retainedResult,'utf8'),'keep this result');
  assert.equal(restored.room.state.active,false);assert.equal(restored.room.messages.length,0);
  assert.equal(restored.deepseekKeyConfigured,true,'backend restart must reload the encrypted credential');
  assert.equal(JSON.stringify(restored).includes(fixtureKey),false);
  // Claude's explicit API credential uses Windows encryption, even while subscription mode remains selected.
  const claudeApiFixture='claude-api-smoke-'+randomBytes(20).toString('hex');
  await page.evaluate(value=>window.airoom.invoke('claudeApiKey.set',{value}),claudeApiFixture);
  const claudeApiFile=path.join(dataDirectory,'secrets','claude-api.secret');
  assert.equal((await readFile(claudeApiFile)).includes(Buffer.from(claudeApiFixture)),false);
  assert.equal((await page.evaluate(()=>window.airoom.invoke('snapshot'))).claudeApiKeyConfigured,true);
  assert.equal(JSON.stringify(await page.evaluate(()=>window.airoom.invoke('snapshot'))).includes(claudeApiFixture),false);
  const apiDiagnostic=await page.evaluate(()=>window.airoom.invoke('diagnostics.export'));
  assert.equal((await readFile(apiDiagnostic.path,'utf8')).includes(claudeApiFixture),false);
  assert.equal((await readFile(path.join(dataDirectory,'airoom.sqlite'))).includes(Buffer.from(claudeApiFixture)),false);
  await page.evaluate(()=>window.airoom.invoke('claudeApiKey.set',{value:''}));assert.equal(existsSync(claudeApiFile),false);
  // A connected program's API key is split off in the main process and kept only in an encrypted file.
  const programSecret=`smk-${randomBytes(12).toString('hex')}`;
  const program=await page.evaluate(secret=>window.airoom.invoke('executor.save',{executor:{name:'密钥测试程序',command:'missing-acp-program',env:`SMOKE_API_KEY=${secret}\nPLAIN_SETTING=1`}}),programSecret);
  assert.deepEqual(program.secretKeys,['SMOKE_API_KEY']);assert.deepEqual(program.env,{PLAIN_SETTING:'1'});
  const programSecretFile=path.join(dataDirectory,'secrets',`${program.id}.secret`);
  assert.ok(existsSync(programSecretFile),'the program secret is stored encrypted');
  assert.equal((await readFile(programSecretFile)).includes(Buffer.from(programSecret)),false,'the stored file is not plaintext');
  assert.equal(JSON.stringify(await page.evaluate(()=>window.airoom.invoke('snapshot'))).includes(programSecret),false,'snapshots never carry the secret');
  const kept=await page.evaluate(()=>window.airoom.invoke('snapshot').then(snapshot=>snapshot.executors[0])).then(existing=>page.evaluate(existing=>window.airoom.invoke('executor.save',{executor:{...existing,env:'SMOKE_API_KEY=（已加密保存）\nPLAIN_SETTING=2'}}),existing));
  assert.deepEqual(kept.secretKeys,['SMOKE_API_KEY'],'saving the placeholder keeps the secret');assert.ok(existsSync(programSecretFile));
  await page.evaluate(id=>window.airoom.invoke('executor.delete',{id}),program.id);
  assert.equal(existsSync(programSecretFile),false,'deleting the program deletes its secret');
  await page.evaluate(()=>window.airoom.invoke('secret.set',{provider:'deepseek',value:''}));
  const cleared=await page.evaluate(()=>window.airoom.invoke('snapshot'));
  assert.equal(cleared.deepseekKeyConfigured,false,'clearing the fixture must remove configured state');
  assert.equal((await readFile(secretPath)).includes(Buffer.from(fixtureKey)),false);
  await writeFile(path.join(directory,'secret-storage-check.json'),JSON.stringify({encryptionAvailable:true,ciphertextContainsPlaintext:false,safeStorageRoundTrip:true,snapshotContainsPlaintext:false,diagnosticsContainsPlaintext:false,restartRestoresConfigured:true,clearRemovesConfigured:true},null,2),'utf8');
  await page.evaluate(()=>window.airoom.invoke('automation.resume'));
  const failedWorker=await application.evaluate(({app})=>{const metric=app.getAppMetrics().find(item=>item.type==='Utility'&&(item.name==='AIROOM 执行服务'||item.serviceName==='AIROOM 执行服务'));if(!metric)throw new Error('Own utility process missing: '+JSON.stringify(app.getAppMetrics().map(({pid,type,name,serviceName})=>({pid,type,name,serviceName}))));process.kill(metric.pid);return metric.pid;});
  await new Promise(resolve=>setTimeout(resolve,500));
  await page.evaluate(()=>window.airoom.invoke('all.stop'));assert.ok(existsSync(path.join(dataDirectory,'automation-paused.flag')),'a human stop is recorded even without a live worker');
  await page.evaluate(()=>window.airoom.invoke('backend.restart'));
  restored=await page.evaluate(()=>window.airoom.invoke('snapshot'));
  await application.evaluate(()=>{globalThis.__readinessWorker.emit('exit',0);delete globalThis.__readinessWorker;});
  assert.equal((await page.evaluate(()=>window.airoom.invoke('snapshot'))).backendReady,true,'a late exit from the old worker must not disconnect its replacement');
  assert.ok(restored?.backendReady,'crashed backend failed to recover');assert.ok(restored.projects.some(project=>project.id===created.id));assert.ok(restored.sessions.some(item=>item.id===session.id));assert.equal(restored.runs.length,0);
  assert.equal(restored.deepseekKeyConfigured,false,'cleared credential must remain cleared after another restart');
  assert.equal(restored.automation.paused,true,'the dead-worker stop marker prevents automatic restart after recovery');assert.ok(restored.automation.usage.every(item=>item.used===0));
  const newWorker=await application.evaluate(({app})=>app.getAppMetrics().find(item=>item.type==='Utility'&&(item.name==='AIROOM 执行服务'||item.serviceName==='AIROOM 执行服务'))?.pid);assert.ok(newWorker&&newWorker!==failedWorker);
  if(process.env.AIROOM_SMOKE_PROBE_ALL==='1')await probeProviders(page,'providers-recovered.json');
  // Once R1 is merged this exercises the real writer, main-process staging,
  // before-restore backup, worker exit, replacement, and new worker together.
  await page.evaluate(()=>window.airoom.invoke('provider.probe'));
  assert.deepEqual(await page.evaluate(()=>window.airoom.invoke('backup.list')),[]);
  await assert.rejects(page.evaluate(()=>window.airoom.invoke('backup.restore',{token:'unconfirmed',confirm:false})),/明确确认/);
  const runningRoot=await application.evaluate(({app})=>app.getAppPath()),writerPresent=existsSync(path.join(runningRoot,'dist','backup.mjs'));
  if(writerPresent){
    let backup=await page.evaluate(()=>window.airoom.invoke('backup.create'));
    await assert.rejects(page.evaluate(id=>window.airoom.invoke('backup.delete',{id,confirm:false}),backup.id),/确认删除/);
    await page.evaluate(id=>window.airoom.invoke('backup.delete',{id,confirm:true}),backup.id);assert.deepEqual(await page.evaluate(()=>window.airoom.invoke('backup.list')),[]);assert.equal((await page.evaluate(()=>window.airoom.invoke('snapshot'))).sessions.length,2,'deleting a backup preserves live sessions');
    backup=await page.evaluate(()=>window.airoom.invoke('backup.create'));const previousBackupId=backup.id;backup=await page.evaluate(()=>window.airoom.invoke('backup.create'));assert.notEqual(backup.id,previousBackupId);assert.deepEqual((await page.evaluate(()=>window.airoom.invoke('backup.list'))).map(entry=>entry.id),[backup.id]);
    const preview=await page.evaluate(id=>window.airoom.invoke('backup.preview',{id}),backup.id);assert.equal(preview.manifest.counts.sessions,2,'the original session and the deleted card\'s retained session are both backed up');
    const cancelled=await page.evaluate(id=>window.airoom.invoke('backup.prepare',{id}),backup.id);await page.evaluate(token=>window.airoom.invoke('backup.cancel',{token}),cancelled.token);
    await assert.rejects(page.evaluate(token=>window.airoom.invoke('backup.restore',{token,confirm:true}),cancelled.token),/预览已过期/);
    const prepared=await page.evaluate(id=>window.airoom.invoke('backup.prepare',{id}),backup.id);
    await assert.rejects(page.evaluate(id=>window.airoom.invoke('backup.delete',{id,confirm:true}),backup.id),/准备恢复/);
    await page.evaluate(()=>window.airoom.invoke('profile.save',{profile:{name:'恢复前的新资料'}}));
    const result=await page.evaluate(token=>window.airoom.invoke('backup.restore',{token,confirm:true}),prepared.token);assert.equal(result.restored,true);
    const recovered=await page.evaluate(()=>window.airoom.invoke('snapshot'));assert.equal(recovered.backendReady,true);assert.equal(recovered.profile.name,'桌面测试用户');assert.equal(recovered.automation.paused,true);assert.equal(recovered.sessions[0].restoredHistoryOnly,true);
    assert.ok(recovered.sessions.some(item=>item.id===retiredSession.id&&item.memberId===retired.id&&item.restoredHistoryOnly));assert.ok(!recovered.members.some(member=>member.id===retired.id));assert.equal(recovered.removedMembers.find(member=>member.id===retired.id)?.name,retired.name);
    await assert.rejects(page.evaluate(id=>window.airoom.invoke('session.send',{sessionId:id,text:'cannot replay restored work'}),session.id),/仅保留历史/);
    const backups=await page.evaluate(()=>window.airoom.invoke('backup.list'));assert.equal(backups.length,1);assert.ok(backups.some(entry=>entry.id===result.beforeBackupId&&entry.manifest?.reason==='before-restore'));
    console.log('Backup desktop integration passed: real writer, confirmed deletion preserving live data, latest-only rotation, protected prepared restore, staged cancellation, before-restore rotation, worker replacement, history-only sessions and paused automation.');
  }else{
    await assert.rejects(page.evaluate(()=>window.airoom.invoke('backup.create')),/备份写入组件尚未安装/);
    assert.equal((await page.evaluate(()=>window.airoom.invoke('snapshot'))).backendReady,true);
    await page.evaluate(()=>window.airoom.invoke('settings.save',{networkMode:'tun'}));
    console.log('Backup desktop RPC guard passed. Real backup/restore integration remains pending until Claudia R1 is merged; no test writer was installed in the app.');
  }
  await desktopScreenshot(application,page,path.join(directory,'desktop-recovered.png'));
  assert.deepEqual(errors,[]);
  await application.close();application=undefined;
  const database=path.join(dataDirectory,'airoom.sqlite');assert.ok(existsSync(database));
  assert.ok((await readFile(database)).length>0);
  console.log(`Desktop smoke passed: fresh launch, MessagePort RPC, private-method rejection, project/session persistence, read-only session, image import/protocol/size limit/source preservation, editor avatar crop/portrait size save and restart persistence, built-in aspect recovery, cards/profile/visibility persistence, presentation-only hide/show and deletion preserving history/files, room paging/full Markdown export/archive/read-only/clear/delete, single window across data directories/executable copies/tray/minimize/offscreen, encrypted fixture storage/redacted diagnostics/restart/clear, all-stop, requested backend restart, unexpected utility crash recovery and clean exit. No model calls or logins. Chromium test sandbox ${diagnosticArgs.length?'disabled for host compatibility':'enabled'}.`);
} finally {
  if(application)await application.close();
  const resolved=path.resolve(directory),relative=path.relative(path.resolve(testingRoot),resolved);
  assert.ok(relative.startsWith('run-')&&!relative.includes('..')&&!path.isAbsolute(relative));
  if(process.env.AIROOM_KEEP_SMOKE!=='1')await rm(resolved,{recursive:true,force:true});
  else console.log(`Smoke output preserved: ${resolved}`);
}
