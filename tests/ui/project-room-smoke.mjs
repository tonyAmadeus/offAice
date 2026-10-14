import '../../scripts/test-bootstrap.mjs';
// Real Engine + renderer: one round of the project flow driven entirely from the meeting room, with members that answer the protocol.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium, expect } from '@playwright/test';
import { createServer } from '../../scripts/ui-test-server.mjs';
import { Engine } from '../helpers/seeded-engine.ts'; // Scenarios opt into the built-in team; production starts empty.

const directory=await mkdtemp(path.join(os.tmpdir(),'AIROOM project-room-ui-')),source=path.join(directory,'project');await mkdir(source);
await writeFile(path.join(source,'a.txt'),'old-a');await writeFile(path.join(source,'b.txt'),'old-b');
const output=path.resolve('.test-cache/ui-project-room');await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1360,height:900}});
const errors=[],rpcCalls=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>void dialog.accept());
const envelope=(kind,payload)=>JSON.stringify({protocol:'airoom.project-flow',version:1,kind,payload});
const evidence=[{kind:'inspection',description:'读取文件',result:'文件已检查',eventIds:[],source:'reported'}];
const pass=criteria=>({verdict:'pass',verificationComplete:true,criteriaResults:criteria.map(criterion=>({criterion,verified:true,evidence:'实际读取'})),findings:[],evidence});
const materials=new Map();
const plan={objective:'给两个文件写上新内容',scope:'只改 a.txt 和 b.txt',deliverables:['新的 a.txt','新的 b.txt'],acceptanceCriteria:['两个文件都是新内容'],
  rounds:[{key:'r1',title:'改两个文件',goal:'Claudia 和 DS 各改一个文件',requiresUserAcceptance:true}],
  tasks:[{key:'a',roundKey:'r1',title:'改 A',memberId:'claude',goal:'把 a.txt 写成新内容',inputs:[],completionCriteria:['A 正确'],dependencies:[],allowedPaths:['a.txt']},
    {key:'b',roundKey:'r1',title:'改 B',memberId:'dsh',goal:'把 b.txt 写成新内容',inputs:[],completionCriteria:['B 正确'],dependencies:[],allowedPaths:['b.txt']}]};
let publish=Promise.resolve(),badSubmissions=1,badReviews=1;const lastReply=new Map(),chatTurns=[];
let supplementScenario=false,holdSupplementAuthor=true,releaseSupplementAuthor;const supplementAuthorGate=new Promise(resolve=>releaseSupplementAuthor=resolve);
const ready=id=>({id,name:id,available:true,auth:id==='dsh'?'account':'subscription',detail:'fake',modelOptions:[{id:'fixture-fast',label:'Fast',efforts:['low'],isDefault:true},{id:'fixture-deep',label:'Deep',efforts:['low','high']}],capabilities:{steer:supplementScenario&&id==='codex',cancel:'native',streaming:true,write:true,history:true}});
const engine=new Engine(path.join(directory,'data'),event=>{publish=publish.then(()=>page.evaluate(event=>window.__listeners?.forEach(fn=>fn(event)),event)).catch(()=>{});},()=>{},id=>({
  probe:async()=>ready(id),stop:async()=>releaseSupplementAuthor(),steer:async()=>{throw new Error('fixture lost supplement receipt');},
  start:async(ctx,prompt)=>{
    if(prompt.includes('\nAIROOM_CONTEXT\n')){const input=JSON.parse(prompt.split('\nAIROOM_CONTEXT\n')[1]);ctx.markDelivery('confirmed');chatTurns.push({member:id,input});
      ctx.emit('delta',JSON.stringify({version:1,turn:input.turn,revision:input.revision,action:chatTurns.length===1?'speak':'pass',body:chatTurns.length===1?'收到，两个文件可以分给两个人各改一个。':''}));return {};}
    if(prompt.includes('仅补正上轮 JSON 格式')){ctx.markDelivery('confirmed');ctx.emit('delta',lastReply.get(ctx.session.id));return {};}
    ctx.markDelivery('confirmed');const kind=prompt.match(/"kind":"([^"]+)"/)?.[1]??'',input=prompt.includes('\n任务材料：')?JSON.parse(prompt.split('\n任务材料：')[1]):materials.get(ctx.session.id),material=()=>input;let payload;if(input)materials.set(ctx.session.id,input);
    ctx.emit('status',kind==='submission'?'正在改文件':'正在核对',{});
    if(kind==='plan')payload=plan;
    else if(kind==='submission'){if(supplementScenario&&material().task.title==='改 B'&&holdSupplementAuthor){holdSupplementAuthor=false;await supplementAuthorGate;}await new Promise(r=>setTimeout(r,150));const task=material().task,file=task.allowedPaths[0];await writeFile(path.join(ctx.cwd,file),'new-'+file);
      // Like the real run on 2026-10-06: Claudia's first reply and its format correction both use an invented evidence kind
      // ("tool" itself is now read as an inspection, so the scenario uses a kind no tolerance maps).
      const bad=ctx.session.provider==='claude'&&badSubmissions-->0;payload={summary:'改好了',evidence:bad?[{...evidence[0],kind:'tool-check'}]:evidence,completionResults:task.completionCriteria.map(criterion=>({criterion,verified:true,evidence:'读取'}))};}
    else if(kind==='review'){const task=material().task;payload=pass(task.completionCriteria);if(task.title==='改 B'&&badReviews-->0)payload.findings=[{kind:'verified',severity:'optional',title:'署名',detail:'可以加署名',evidence:'第 1 行'}];}
    else if(kind==='integration-check')payload=pass(material().criteria);
    else if(kind==='round-report')payload={summary:'两个文件都改好了，整合后检查通过。',completedTaskKeys:material().taskKeys,deliverables:['新的 a.txt','新的 b.txt'],validationSummary:'在整合副本里读取了两个文件',remainingIssues:[],nextRoundSummary:'',userDecisionNeeded:'请验收这一轮。'};
    lastReply.set(ctx.session.id,envelope(kind,payload));ctx.emit('delta',envelope(kind,payload));return {};
  },
}));
try{
  await engine.probe();const project=await engine.invoke('project.create',{directory:source,name:'两文件项目'});
  await page.exposeFunction('__rpc',async(method,params)=>{rpcCalls.push({method,params});if(['window.attention','window.show','renderer.error'].includes(method))return {};return engine.invoke(method,params);});
  // The desktop window has no prompt(); fail the same way here so no flow depends on it.
  await page.addInitScript(()=>{window.prompt=()=>{throw new Error('prompt() is not supported.');};window.__listeners=[];window.airoom={invoke:(method,params)=>window.__rpc(method,params),onEvent:fn=>{window.__listeners.push(fn);return ()=>{window.__listeners=window.__listeners.filter(item=>item!==fn);};}};});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  // Clicking the project opens its meeting room: first say what to do, then choose the lead, then the lead drafts the plan.
  await page.locator('.project-item .list-row-main',{hasText:'两文件项目'}).click();
  const invite=page.getByRole('dialog',{name:'请大家一起来'});await expect(invite).toBeVisible();
  await expect(invite.getByRole('radio',{name:/两文件项目/})).toHaveAttribute('aria-checked','true');
  await expect(invite.getByRole('checkbox',{name:'邀请 Claudia'})).toBeChecked();await expect(invite.getByRole('textbox')).toHaveCount(0);
  await invite.getByRole('combobox',{name:'Claudia 项目模型'}).selectOption('value:fixture-deep');
  await invite.getByRole('combobox',{name:'Claudia 项目思考程度'}).selectOption('value:high');
  await page.screenshot({path:path.join(output,'invite-1360.png'),animations:'disabled'});
  await invite.getByRole('button',{name:'进入会议室'}).click();await expect(invite).toHaveCount(0);
  const room=page.getByRole('main',{name:'两文件项目 的项目会议室'});await expect(room).toBeVisible();
  assert.deepEqual(engine.store.get('projects',project.id).memberConfigs.claude,{model:'fixture-deep',effort:'high'});
  await room.getByRole('button',{name:'Gptia',exact:true}).click();
  const config=page.getByRole('dialog',{name:'Gptia 的项目配置'});await expect(config).toBeVisible();
  await config.getByRole('combobox',{name:'Gptia 项目模型'}).selectOption('value:fixture-deep');
  await config.getByRole('combobox',{name:'Gptia 项目思考程度'}).selectOption('value:high');
  await page.screenshot({path:path.join(output,'project-config-1360.png'),animations:'disabled'});
  await config.getByRole('button',{name:'保存',exact:true}).click();await expect(config).toHaveCount(0);
  const step=()=>room.locator('.flow-steps [aria-current="step"]');await expect(step()).toContainText('讨论');
  // The discussion is the real meeting chat: members read it and answer, the same way as in 茶歇室.
  const chat=room.getByRole('region',{name:'会议聊天'}),say=chat.getByRole('textbox',{name:'在会议室里说话'});await say.fill('给两个文件写上新内容');await say.press('Enter');
  await expect(chat.locator('.room-line.mine')).toContainText('给两个文件写上新内容');await expect(chat).toContainText('两个文件可以分给两个人各改一个',{timeout:20000});
  assert.ok(rpcCalls.some(call=>call.method==='room.send'&&call.params.roomId==='project:'+project.id),'the meeting chat sends into the project room');
  assert.equal(engine.store.roomState().active,false,'the tea room is untouched');
  await room.getByRole('button',{name:'选负责人，起草方案'}).click();await expect(step()).toContainText('定负责人');
  const picker=room.getByRole('region',{name:'选负责人'});await expect(picker.getByRole('button',{name:'先选一位负责人'})).toBeDisabled();
  await picker.getByRole('button',{name:'Gptia 当负责人'}).click();
  await page.screenshot({path:path.join(output,'start-1360.png'),animations:'disabled'});
  await room.getByRole('combobox',{name:'项目复核程度'}).selectOption('high');await picker.getByRole('button',{name:'请 Gptia 起草方案'}).click();
  // The lead's plan waits above the composer; the chat shows it was posted. The last round is always the owner's to accept.
  assert.equal(rpcCalls.findLast(call=>call.method==='projectFlow.start').params.topic,undefined,'the lead drafts from the room discussion, not a typed goal');
  const planningRun=engine.store.list('runs').find(r=>r.flowOperationId&&engine.store.get('flow_operations',r.flowOperationId)?.kind==='plan');
  assert.equal(planningRun.requestedConfig.model,'fixture-deep');assert.equal(planningRun.requestedConfig.effort,'high');
  assert.deepEqual(engine.store.get('projects',project.id).memberIds,['claude','codex','dsh'],'the invited people are saved on the project');
  assert.match(JSON.stringify(engine.store.list('project_flows').at(-1).discussionContext),/给两个文件写上新内容/,'the discussion the plan is based on');
  const planCard=room.getByRole('article',{name:'方案第 1 版'});await expect(planCard).toContainText('给两个文件写上新内容');await expect(step()).toContainText('方案');
  const accept=planCard.getByRole('checkbox',{name:/需要我验收/});await expect(accept).toBeChecked();await expect(accept).toBeDisabled();
  await expect(planCard).toContainText('改 A');await expect(planCard).toContainText('改 B');
  await expect(chat.locator('.flow-message',{hasText:'方案 · 第 1 版'})).toContainText('待你确认',{timeout:20000});
  const board=room.getByRole('complementary',{name:'看板'});await expect(board).toContainText('方案确认后');
  await page.screenshot({path:path.join(output,'plan-1360.png'),animations:'disabled'});
  assert.equal(await readFile(path.join(source,'a.txt'),'utf8'),'old-a','nothing runs before the owner confirms');
  // The dock folds to one line over the chat, so the conversation can be read through, and opens again.
  const dockToggle=room.getByRole('button',{name:/会议待办/});await dockToggle.click();await expect(planCard).toHaveCount(0);
  await expect(room.locator('.flow-dock-summary')).toContainText('确认方案第 1 版');await page.screenshot({path:path.join(output,'dock-folded-1360.png'),animations:'disabled'});
  const beforeNext=engine.store.list('runs').length;
  await room.getByRole('group',{name:'项目下一步'}).getByRole('button',{name:'查看并确认方案'}).click();await expect(planCard).toBeVisible();
  assert.equal(engine.store.list('runs').length,beforeNext,'the highlighted next action opens the plan and waits for the actual confirmation');
  await planCard.getByRole('button',{name:'确认方案，开工'}).click();
  // Two attempts block, as in the real run: Claudia's task reply (twice an invented evidence kind) and the review of B (twice invented finding fields).
  const alert=room.locator('.meeting-alert');
  await expect(alert).toContainText('只能是 command、quote、inspection 或 source',{timeout:20000});await expect(alert).toContainText('不支持的字段：title、detail',{timeout:20000});
  await room.getByRole('group',{name:'项目下一步'}).getByRole('button',{name:'核对中断结果'}).click();await expect(alert).toBeVisible();
  // The task's own attempt is given up from the board ...
  await board.getByRole('region',{name:'需处理'}).getByRole('button',{name:'任务：改 A'}).click();
  const detailA=board.getByRole('article',{name:'任务详情：改 A'});await expect(detailA).toContainText('卡在做任务');
  await expect(detailA.locator('.task-workspace-location')).toContainText('任务副本');await expect(detailA.getByRole('button',{name:'打开任务工作位置'})).toBeVisible();
  await detailA.getByRole('button',{name:'放弃这次尝试，重新安排'}).click();
  const giveUp=detailA.getByRole('group',{name:'放弃这次尝试'});await expect(giveUp.getByRole('textbox',{name:'放弃的原因'})).toHaveValue('');await expect(giveUp.getByRole('button',{name:'确定放弃'})).toBeEnabled();
  await giveUp.getByRole('button',{name:'确定放弃'}).click();await expect(giveUp).toHaveCount(0);
  await detailA.getByRole('button',{name:'回到看板'}).click();
  // ... and the blocked review from the alert in the meeting area; 继续 is only possible once nothing blocks.
  await expect(room.getByRole('button',{name:'继续',exact:true})).toBeDisabled();
  const reviewItem=alert.locator('.meeting-alert-item',{hasText:'复核：改 B'});await reviewItem.getByRole('button',{name:'放弃这次尝试，重新安排'}).click();
  await reviewItem.getByRole('button',{name:'确定放弃'}).click();
  await expect(alert).toHaveCount(0);
  // Resolving a held operation no longer pauses an already running flow again.
  await expect(room.getByRole('button',{name:'继续',exact:true})).toHaveCount(0);
  // The board shows the round's tasks moving through the lanes; a card opens its details in place.
  await expect(board.getByRole('region',{name:'已完成'}).getByRole('button',{name:/任务：/})).toHaveCount(2,{timeout:20000});
  await board.getByRole('button',{name:'任务：改 A'}).click();const detail=board.getByRole('article',{name:'任务详情：改 A'});
  await expect(detail).toContainText('A 正确');await expect(detail).toContainText('复核：通过');await expect(detail.getByRole('button',{name:'看工作日志'})).toBeVisible();
  await page.screenshot({path:path.join(output,'board-detail-1360.png'),animations:'disabled'});
  await detail.getByRole('button',{name:'回到看板'}).click();
  // The round's product waits for the owner: 通过 or 驳回, no text needed.
  const result=room.getByRole('article',{name:'第 1 轮成品'});await expect(result).toContainText('两个文件都改好了',{timeout:20000});await expect(step()).toContainText('验收');
  await room.getByRole('group',{name:'项目下一步'}).getByRole('button',{name:'查看成品并验收'}).click();await expect(result).toBeVisible();
  await expect(page.getByRole('button',{name:/待你处理/})).toContainText('轮次成品待验收');
  await result.getByRole('button',{name:'查看这一轮的改动'}).click();await expect(result.locator('.round-diff')).toContainText('a.txt');await expect(result.locator('.round-diff')).toContainText('b.txt');
  await expect(result.getByRole('button',{name:'驳回'})).toBeEnabled();
  assert.equal(await readFile(path.join(source,'a.txt'),'utf8'),'old-a','the project folder is untouched until acceptance');
  await page.screenshot({path:path.join(output,'results-1360.png'),animations:'disabled'});
  await page.setViewportSize({width:1100,height:750});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal scroll at 1100px');
  await page.screenshot({path:path.join(output,'results-1100.png'),animations:'disabled'});await page.setViewportSize({width:1360,height:900});
  // 驳回 asks for an optional reason in the card itself; cancelling keeps the round waiting.
  await result.getByRole('button',{name:'驳回'}).click();await expect(result.getByRole('textbox',{name:'驳回理由（可选）'})).toBeVisible();await result.getByRole('button',{name:'取消'}).click();
  await result.getByRole('button',{name:'通过'}).click();
  // Wait for the accepted line itself: the verdict hint (通过后写回项目文件夹) contains the same words.
  await expect(room.locator('.flow-dock')).toContainText(/已验收 · .*写回项目/,{timeout:30000});
  const written=async()=>(await readFile(path.join(source,'a.txt'),'utf8'))==='new-a.txt'&&(await readFile(path.join(source,'b.txt'),'utf8'))==='new-b.txt';
  for(let i=0;i<200&&!await written();i++)await new Promise(r=>setTimeout(r,50));assert.ok(await written(),'acceptance writes both files into the project');
  await expect(step()).toHaveCount(0);await expect(room.getByRole('button',{name:'开始新的一段工作'})).toBeVisible({timeout:20000});
  assert.equal(await page.locator('.session-item').count(),0,'flow sessions stay in the meeting room, not the session list');
  // H2 uses the delivery operation, even when the original task run finished normally.
  supplementScenario=true;plan.rounds=plan.rounds.map(round=>({...round,reviewLevel:'medium'}));plan.tasks=plan.tasks.map((task,index)=>({...task,memberId:'codex',dependencies:index?['a']:[]}));await engine.probe('codex');
  await room.getByRole('button',{name:'开始新的一段工作'}).click();await say.fill('核对当前任务的补充要求');await say.press('Enter');await expect(chat.locator('.room-line.mine',{hasText:'核对当前任务的补充要求'})).toBeVisible();await room.getByRole('button',{name:'选负责人，起草方案'}).click();await picker.getByRole('button',{name:'Gptia 当负责人'}).click();await picker.getByRole('button',{name:'请 Gptia 起草方案'}).click();await planCard.getByRole('button',{name:'确认方案，开工'}).click();
  let taskData;for(let i=0;i<200;i++){taskData=await engine.invoke('projectFlow.get',{projectId:project.id});if(taskData.tasks.find(task=>task.title==='改 B')?.status==='running')break;await new Promise(r=>setTimeout(r,25));}
  const completed=taskData.tasks.find(task=>task.title==='改 A'),task=taskData.tasks.find(task=>task.title==='改 B');
  assert.equal(completed.status,'review_skipped');assert.equal(task.status,'running');assert.ok(taskData.tasks.indexOf(completed)<taskData.tasks.indexOf(task));
  // C-03: exercise the actual @ selector and purpose control with an earlier completed task by the same member.
  await say.fill('@');await chat.getByRole('option',{name:'Gptia'}).click();await say.fill('@Gptia 补充核对当前任务的标准');await chat.getByRole('combobox',{name:'点名用途'}).selectOption('supplement');await say.press('Enter');
  const supplementDialog=page.getByRole('dialog',{name:'补充要求 · Gptia'});await expect(supplementDialog).toBeVisible();await expect(page.getByRole('dialog',{name:'追加任务 · Gptia'})).toHaveCount(0);
  await expect(supplementDialog.getByText('补充到当前任务：改 B')).toBeVisible();
  // The running task advances while the dialog is open (real runs bump its revision); the confirm must not reuse the stale one.
  {const stored=engine.store.get('flow_tasks',task.id);engine.store.put('flow_tasks',task.id,{...stored,revision:stored.revision+1});}
  await page.screenshot({path:path.join(output,'supplement-current-task-1360.png'),animations:'disabled'});
  await supplementDialog.getByRole('button',{name:'确认补充要求',exact:true}).click();await expect(supplementDialog).toHaveCount(0);
  const supplementCall=rpcCalls.findLast(call=>call.method==='projectFlow.task.supplement');assert.equal(supplementCall.params.taskId,task.id);
  taskData=await engine.invoke('projectFlow.get',{projectId:project.id});const supplement=taskData.blockedOperations.find(op=>op.kind==='supplement-delivery');assert.ok(supplement);assert.equal(taskData.tasks.find(item=>item.id===task.id).supplements[0].status,'unknown');
  assert.equal(taskData.tasks.find(item=>item.id===completed.id).supplements?.length??0,0);
  releaseSupplementAuthor();for(let i=0;i<200;i++){const active=engine.store.list('runs').findLast(run=>run.sessionId===task.sessionId);if(active?.completedAt)break;await new Promise(r=>setTimeout(r,25));}
  await board.getByRole('button',{name:'任务：改 B'}).click();const supplementDetail=board.getByRole('article',{name:'任务详情：改 B'});await expect(supplementDetail.getByRole('button',{name:'放弃旧尝试',exact:true})).toBeVisible();await supplementDetail.getByRole('button',{name:'放弃旧尝试',exact:true}).click();
  const supplementGiveUp=supplementDetail.getByRole('group',{name:'放弃这次尝试'});await expect(supplementGiveUp).toContainText('本次补充是否送达尚未核对');await expect(supplementGiveUp.getByRole('textbox',{name:'放弃的原因'})).toHaveValue('');await expect(supplementGiveUp.getByRole('button',{name:'确定放弃'})).toBeEnabled();await supplementGiveUp.getByRole('button',{name:'确定放弃'}).click();
  await expect(supplementGiveUp).toHaveCount(0);await expect(supplementDetail.getByRole('button',{name:'放弃旧尝试',exact:true})).toHaveCount(0);assert.equal(rpcCalls.findLast(call=>call.method==='projectFlow.unknown.resolve').params.operationId,supplement.id);assert.equal(rpcCalls.findLast(call=>call.method==='projectFlow.unknown.resolve').params.evidence,'');
  const acknowledged=await engine.invoke('projectFlow.get',{projectId:project.id});assert.equal(acknowledged.flow.dispatchMode,'paused');assert.equal(acknowledged.tasks.find(item=>item.id===task.id).supplements[0].status,'pending');assert.equal((await engine.invoke('attention.list')).counts.unknown,0);
  await room.getByRole('button',{name:'继续',exact:true}).click();await expect(result).toBeVisible({timeout:20000});const resumed=await engine.invoke('projectFlow.get',{projectId:project.id});assert.equal(resumed.tasks.find(item=>item.id===task.id).supplements[0].status,'applied');assert.equal(resumed.tasks.find(item=>item.id===task.id).returnCount,0);
  await say.fill('@Gptia 已完成后不应自动追加');await chat.getByRole('combobox',{name:'点名用途'}).selectOption('supplement');await say.press('Enter');await expect(room).toContainText('该成员暂无可补充任务，请安排新任务。');await expect(page.getByRole('dialog',{name:'追加任务 · Gptia'})).toHaveCount(0);await expect(say).toHaveValue('@Gptia 已完成后不应自动追加');
  // The team home is still one click away.
  await page.getByTitle('回到团队主页').click();await page.getByText('今天想请谁来帮忙？').waitFor();
  assert.deepEqual(errors,[]);
  console.log('Project room UI passed: goal first, then lead, then plan; steps bar; forced final acceptance; board lanes and task details; inline recovery from invalid evidence without prompt(); report, diff and pass/reject without text; pending-items entry; acceptance writes the project; completion; H2 unknown supplement resolves its delivery operation and waits for resume; 1100px layout.');
}finally{releaseSupplementAuthor();await engine.close();await publish;await browser.close();await server.close();await rm(directory,{recursive:true,force:true});}
