import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {harness,plan,passing,failed,proof} from '../helpers/project-flow-harness.ts';

// Real controller + renderer, isolated files and fake adapters: no account or model requests.
const output=path.resolve('.test-cache/ui-project-flow-rules');await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1100,height:750}});
const errors=[],calls=[];let current,publish=Promise.resolve();page.on('pageerror',error=>errors.push(error.message));
await page.exposeFunction('__rpc',async(method,params)=>{calls.push({method,params});if(['window.attention','window.show','renderer.error'].includes(method))return {};return current.engine.invoke(method,params);});
await page.addInitScript(()=>{window.prompt=()=>{throw Error('desktop prompt is unavailable');};window.__listeners=[];window.airoom={invoke:(method,params)=>window.__rpc(method,params),onEvent:fn=>{window.__listeners.push(fn);return ()=>{window.__listeners=window.__listeners.filter(f=>f!==fn);};}};});
async function open(options){current=await harness(options);current.engine.push=event=>{publish=publish.then(()=>page.evaluate(e=>window.__listeners?.forEach(fn=>fn(e)),event)).catch(()=>{});};await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);await page.locator('.project-item .list-row-main').first().click();const room=page.getByRole('main',{name:`${current.project.name} 的项目会议室`});await expect(room).toBeVisible();return room;}
async function close(){await current?.dispose();await publish;current=undefined;}
async function capture(name){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow at 1100px');await page.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});}
try{
  const p=plan();p.rounds[0].requiresUserAcceptance=false;p.rounds.push({key:'r2',title:'继续 B',goal:'完成 B',requiresUserAcceptance:true,completionCriteria:['B 正确']});p.tasks[1].roundKey='r2';p.tasks[1].dependencies=['a'];
  let room=await open({plan:p,level:'medium',handler:async c=>{if(c.kind==='requested-check')return failed(c.material.criteria);if(c.kind==='next-round')return {mode:'adjusted',summary:'补充 B 的检查要求',taskAdjustments:[{taskId:c.material.tasks[0].id,goal:'按调整完成 B',completionCriteria:['B 的调整标准']}],completionCriteria:['B 的调整标准']};}});
  let card=room.getByRole('article',{name:'方案第 1 版'});await expect(room.getByRole('combobox',{name:'项目复核程度'})).toHaveValue('medium');
  await card.getByRole('combobox',{name:'第 1 轮复核程度'}).selectOption('low');await expect(card.getByRole('checkbox',{name:'需要我验收'}).first()).toBeChecked();await expect(card.getByRole('checkbox',{name:'需要我验收'}).first()).toBeDisabled();
  await card.getByRole('button',{name:'确认方案，开工'}).click();assert.equal(calls.findLast(c=>c.method==='projectFlow.plan.confirm').params.reviewLevelByRound.r1,'low');
  await current.wait(s=>s.decisions.some(d=>d.kind==='review-choice'&&d.status==='open'&&d.allowedActions?.some(a=>a.name==='projectFlow.decision.answer'&&a.enabled)));await publish;
  await room.getByRole('button',{name:'直接由我验收',exact:true}).click();let product=room.getByRole('article',{name:'第 1 轮成品'});await product.getByText('验证细节',{exact:true}).click();await expect(product.getByText('本轮 AI 复核尚未通过，由你查看成品后决定。',{exact:true})).toBeVisible();
  await product.getByRole('combobox',{name:'第 1 轮检查成员'}).selectOption('dsh');await product.getByRole('button',{name:'请人复核'}).click();await expect(product.locator('.requested-check')).toContainText('有问题需要修改',{timeout:20000});
  assert.equal((await current.state()).rounds[0].integrationFixCount,0);assert.equal(current.calls.some(c=>c.kind==='integration-check'),false);await expect(product.getByRole('button',{name:'通过',exact:true})).toBeEnabled();await expect(product.getByRole('button',{name:'驳回',exact:true})).toBeEnabled();await capture('lowest-requested-check-1100');
  await product.getByRole('button',{name:'通过',exact:true}).click();const next=room.getByRole('region',{name:'决策：下一轮确认 · 继续 B'});await expect(next).toContainText('按调整完成 B',{timeout:20000});await expect(next.getByRole('button',{name:'按原计划开始'})).toBeEnabled();await expect(next.getByRole('button',{name:'按调整开始'})).toBeEnabled();
  assert.equal(current.calls.filter(c=>c.kind==='submission').length,1);await expect(room.getByRole('button',{name:'任务：B'})).toContainText('本轮不单独复核');await capture('next-round-1100');await next.getByRole('button',{name:'按调整开始'}).click();await expect(room.getByRole('article',{name:'第 2 轮成品'})).toContainText('本轮汇总',{timeout:20000});assert.equal((await current.state()).tasks.find(t=>t.key==='b').goal,'按调整完成 B');await close();

  const single=plan();single.tasks=single.tasks.slice(0,1);room=await open({plan:single,level:'medium'});current.quota('claude',false);await room.getByRole('button',{name:'确认方案，开工'}).click();await expect(room.locator('.dock-row').filter({hasText:'额度恢复'})).toBeVisible();current.ageQuota();const quota=room.locator('.decision-card').filter({hasText:'等待额度已超过 10 分钟'});await expect(quota).toBeVisible();await expect(quota.getByRole('button',{name:'换人接手'})).toBeDisabled();await quota.getByRole('combobox').selectOption('dsh');await capture('quota-decision-1100');await quota.getByRole('button',{name:'换人接手'}).click();await expect(room.getByRole('article',{name:'第 1 轮成品'})).toContainText('本轮汇总',{timeout:20000});assert.equal((await current.state()).tasks[0].memberId,'dsh');assert.equal(current.calls.filter(c=>c.kind==='plan').length,1);await close();

  single.tasks[0].reviewerMemberId='codex';let reviews=0,submissions=0;room=await open({plan:single,handler:async c=>{
    if(c.kind==='review'&&++reviews<=3)return failed(c.material.task.completionCriteria);
    if(c.kind==='submission'&&++submissions%2===0){await writeFile(path.join(c.ctx.cwd,'a.txt'),'new-a');return {summary:'提交并提出异议',completionResults:passing(c.material.task.completionCriteria).criteriaResults,evidence:proof,disputes:[{findingId:c.material.fixes[0].id,reason:'标准已满足，复核意见需要重新判断'}]};}
  }});await room.getByRole('button',{name:'确认方案，开工'}).click();const dispute=room.getByRole('region',{name:'决策：作者的复核异议需要你裁定'});
  for(let i=1;i<=3;i++){
    await current.wait(s=>s.decisions.some(d=>d.kind==='review-dispute'&&d.status==='open'&&s.submissions.find(sub=>sub.id===d.submissionId)?.sequence===i*2));
    await expect(dispute).toContainText('本任务异议返还已用 '+Math.min(i,2)+'/2 次',{timeout:20000});
    await expect(dispute).toContainText(i<=2?'本次异议返还 1 次':'本次退回正常计数');await expect(dispute.getByRole('button',{name:'提交逐条裁定'})).toBeDisabled();
    await dispute.getByRole('combobox').selectOption(i<=2?'uphold-review':'uphold-author');
    if(i===1)await capture('dispute-ruling-1100');if(i===3)await capture('dispute-cap-1100');
    await dispute.getByRole('button',{name:'提交逐条裁定'}).click();
  }
  await expect(room.getByRole('article',{name:'第 1 轮成品'})).toContainText('本轮汇总',{timeout:20000});const disputedTask=(await current.state()).tasks[0];
  assert.equal(disputedTask.returnCount,1);assert.equal(disputedTask.disputeReturnWaiverCount,2);assert.equal(submissions,6);
  assert.equal(calls.findLast(c=>c.method==='projectFlow.decision.answer').params.rulings[0].verdict,'uphold-author');await close();
  const deepseekPlan=plan();deepseekPlan.tasks=deepseekPlan.tasks.slice(0,1);deepseekPlan.tasks[0].reviewerMemberId='dsh';
  room=await open({plan:deepseekPlan,handler:async c=>{
    if(c.kind!=='review')return;
    assert.equal(c.correction,false,'a role prefix and missing native exit code must not consume correction');
    const command='Select-String -Path a.txt -Pattern new-a';
    c.ctx.emit('delta','（尾鳍啪嗒啪嗒）本鲸来复核……\n',undefined,'native');
    c.ctx.emit('tool',command,{sessionUpdate:'tool_call',toolCallId:'review-select',status:'in_progress',rawInput:{command}},'native');
    c.ctx.emit('tool','查到内容',{sessionUpdate:'tool_call_update',toolCallId:'review-select',status:'completed',content:[{type:'content',content:{type:'text',text:'a.txt:1:new-a'}}]},'native');
    return {...passing(c.material.task.completionCriteria),evidence:[{kind:'command',description:'核对文件内容',command,exitCode:0,result:'查到对应内容',eventIds:[]}]};
  }});
  await room.getByRole('button',{name:'确认方案，开工'}).click();product=room.getByRole('article',{name:'第 1 轮成品'});
  await expect(product).toContainText('退出码未核实',{timeout:20000});await expect(product).toContainText('原生记录确认命令已完成，但未提供退出码');
  await room.getByRole('button',{name:'任务：A',exact:true}).click();const taskDetail=room.getByRole('article',{name:'任务详情：A'});
  await expect(taskDetail).toContainText('退出码未核实');await expect(taskDetail).toContainText('成员填写 0');
  await capture('deepseek-completion-unverified-exit-1100');assert.equal(current.calls.some(c=>c.correction),false);
  assert.equal((await current.state()).reviews[0].status,'passed');assert.equal(await current.original(),'old-a');await close();
  assert.deepEqual(errors,[]);console.log('Project-flow rules UI passed: per-round level, lowest-level acceptance, requested checks, next-round confirmation, quota reassignment, disputes, refund cap, DeepSeek submission normalization and unverified exit-code visibility at 1100px.');
}catch(error){console.error('Project-flow rules UI failure state:',JSON.stringify(await current?.state()));await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw error;}finally{await close();await browser.close();await server.close();}
