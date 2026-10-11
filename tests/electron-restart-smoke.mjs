import '../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { _electron } from '@playwright/test';
const parent=path.resolve('.test-cache/normal-exit'); await mkdir(parent,{recursive:true}); const directory=await mkdtemp(path.join(parent,'run-'));
const data=path.join(directory,'data'), user=path.join(directory,'user'), state=path.join(directory,'agent'); await mkdir(user); await mkdir(state); await writeFile(path.join(state,'signed-in'),'fixture');
const env={...process.env,USERPROFILE:user,AIROOM_DATA_DIR:data,AIROOM_NODE_EXE:process.execPath}; delete env.ELECTRON_RUN_AS_NODE;
const executablePath=process.env.AIROOM_ELECTRON_EXE??path.resolve('node_modules/electron/dist/electron.exe');
const args=process.env.AIROOM_ELECTRON_EXE&&process.env.AIROOM_SMOKE_DEV!=='1'?[]:[process.env.AIROOM_SMOKE_APP_ROOT??process.cwd()];
let app,page;
const rpc=(method,params)=>page.evaluate(({method,params})=>window.airoom.invoke(method,params),{method,params});
async function wait(read,description){const end=Date.now()+20000;while(Date.now()<end){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,30));}throw Error('Timeout: '+description);}
async function launch(){app=await _electron.launch({executablePath,args,env});page=await app.firstWindow();await page.waitForFunction(()=>Boolean(window.airoom));await wait(async()=>{try{return (await rpc('snapshot')).backendReady;}catch{return false;}},'backend ready');}
async function quitNormally(){
  const child=app.process(); const exited=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Normal app.quit did not exit; no forced termination used.')),20000);child.once('exit',(code,signal)=>{clearTimeout(timer);code===0&&!signal?resolve():reject(Error('Abnormal exit '+code+' '+signal));});});
  await app.evaluate(({app})=>{app.quit();}).catch(error=>{if(!/closed|Target|disconnect/i.test(error.message))throw error;}); await exited;app=undefined;
}
async function log(){const file=path.join(state,'log.jsonl');return existsSync(file)?(await readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];}
const prompts=async()=> (await log()).filter(entry=>entry.method==='session/prompt');
try{
  await launch();await rpc('settings.save',{networkMode:'tun',maxParallel:4});
  const executor=await rpc('executor.save',{executor:{name:'隔离重启验收',command:path.resolve('tests/fixtures/fake-acp-agent.mjs'),env:{FAKE_ACP_STATE:state,FAKE_ACP_FLOW:'1'}}});
  await rpc('provider.probe');await wait(async()=> (await rpc('snapshot')).providers.find(info=>info.id===executor.id&&info.available),'fixture executor');
  const members=[];for(const name of ['测试负责人','测试执行者'])members.push(await rpc('team.save',{member:{executor:executor.id,name}}));
  const source=path.join(directory,'project');await mkdir(source);await writeFile(path.join(source,'result.txt'),'before');
  const project=await rpc('project.create',{directory:source,name:'隔离正常退出验收'});
  await rpc('projectFlow.start',{requestId:'start',projectId:project.id,leadMemberId:members[0].id,memberIds:members.map(member=>member.id),topic:'写测试文件',reviewLevel:'low'});
  const draft=await wait(async()=>{const view=await rpc('projectFlow.get',{projectId:project.id});return view.plan?.status==='awaiting_confirmation'&&view;},'plan');
  await rpc('projectFlow.plan.confirm',{requestId:'confirm',planId:draft.plan.id,expectedRevision:draft.plan.revision});
  const running=await wait(async()=>{const snapshot=await rpc('snapshot');return snapshot.runs.find(run=>run.flowOperationId&&run.status==='running'&&run.delivery==='confirmed');},'active project task');
  await page.locator('.project-item .list-row-main',{hasText:'隔离正常退出验收'}).click();
  await page.getByRole('region',{name:'项目阶段 · 测试执行者运行进度'}).waitFor();
  await rpc('desk.open',{memberId:members[0].id});await rpc('desk.topic',{memberId:members[0].id,title:'保留的工位话题'});const desk=await rpc('desk.open',{memberId:members[0].id});
  await rpc('room.send',{roomId:`desk:${members[0].id}`,text:'SLOW 保留工位工作'});
  const deskSession=await wait(async()=>{const snapshot=await rpc('snapshot');return snapshot.runs.some(run=>run.sessionId===desk.sessionId&&run.status==='running'&&run.delivery==='confirmed')&&snapshot.sessions.find(session=>session.id===desk.sessionId&&session.nativeId);},'active desk');
  const unknownSession=await rpc('session.create',{projectId:project.id,provider:executor.id,writeMode:false,title:'未知投递验收'});
  await rpc('session.send',{sessionId:unknownSession.id,text:'DISCONNECT_UNKNOWN'});
  await wait(async()=> (await rpc('snapshot')).runs.find(run=>run.sessionId===unknownSession.id&&run.delivery==='unknown'),'real fixture transport disconnect');
  const before=(await prompts()).length;await quitNormally();await launch();
  const recovered=await rpc('snapshot');assert.equal(recovered.runs.find(run=>run.id===running.id).status,'stopped');assert.equal(recovered.sessions.find(session=>session.id===desk.sessionId).nativeId,deskSession.nativeId);
  assert.equal(recovered.runs.find(run=>run.sessionId===unknownSession.id).delivery,'unknown');
  await rpc('provider.probe');await new Promise(resolve=>setTimeout(resolve,500));assert.equal((await prompts()).length,before,'restart and probe do not replay stopped or unknown work');
  const flow=await rpc('projectFlow.get',{projectId:project.id});assert.equal(flow.flow.dispatchMode,'paused');const operation=flow.blockedOperations.find(op=>op.id===running.flowOperationId);assert.equal(operation.state,'blocked');
  await writeFile(path.join(state,'release-flow'),'explicit continue');
  await rpc('projectFlow.unknown.resolve',{requestId:'continue-known-stop',operationId:operation.id,expectedRevision:operation.revision,choice:'continue',evidence:''});
  const refreshed=await rpc('projectFlow.get',{projectId:project.id});await rpc('projectFlow.resume',{requestId:'resume',flowId:refreshed.flow.id,expectedRevision:refreshed.flow.revision});
  await wait(async()=>{const view=await rpc('projectFlow.get',{projectId:project.id});return view.tasks.some(task=>['review_skipped','integrated'].includes(task.status));},'explicit project continuation');
  await rpc('room.send',{roomId:`desk:${members[0].id}`,text:'继续完成工位话题'});
  await wait(async()=> (await rpc('snapshot')).runs.some(run=>run.sessionId===desk.sessionId&&run.status==='ended'),'explicit desk continuation');
  assert.ok((await log()).some(entry=>entry.method==='session/load'&&entry.params.sessionId===deskSession.nativeId),'same native desk context is loaded');
  assert.equal((await prompts()).filter(entry=>entry.params.prompt.some(block=>block.text?.includes('DISCONNECT_UNKNOWN'))).length,1,'unknown delivery was never retried');
  await quitNormally();
  console.log('Active desktop restart passed: real app.quit/before-quit normal exit during project and desk work; both continued only on explicit user RPC; same native desk context; genuine fixture transport disconnect stays unknown and is never replayed. Isolated data and synthetic ACP, no real accounts. Native tray keyboard is unavailable.');
}finally{
  if(app)await quitNormally();assert.equal(path.dirname(directory),parent);await rm(directory,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
