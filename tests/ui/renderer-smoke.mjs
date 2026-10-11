import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import {installPersonalFixture} from './personal-fixture.mjs';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createServer } from '../../scripts/ui-test-server.mjs';

const output = new URL('../../.test-cache/ui-renderer/', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '');
await mkdir(output, { recursive: true });
const server=process.env.AIROOM_UI_TEST_URL?undefined:await createServer({configFile:false,root:process.cwd(),logLevel:'silent',server:{host:'127.0.0.1',port:0}});
await server?.listen();
const url=process.env.AIROOM_UI_TEST_URL??`http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 750 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  // A plain renderer must never invent a connection or an executable task.
  await page.goto(url);
  await page.getByText('桌面后端未连接。请从 AIROOM 桌面应用打开工作台。').waitFor();
  assert.equal(await page.getByRole('button', { name: '添加第一个项目' }).isDisabled(), true);
  await page.screenshot({ path: `${output}/empty-1100.png` });

  const settings = { networkMode:'tun', proxyUrl:'http://127.0.0.1:7897', paths:{codex:'C:\\old\\codex.exe'}, models:{}, permissions:{codex:{commands:'auto',fileScope:'workspace',network:true},claude:{commands:'ask',fileScope:'workspace',network:true},dsh:{commands:'auto',fileScope:'workspace',network:true}}, deepseekEnabled:true, deepseekBaseUrl:'https://api.deepseek.com', dshProfile:'airoom', maxParallel:3, stopTimeoutMs:10000, defaultWriteMode:false };
  const now = new Date().toISOString();
  const snapshot = {
    projects: [{ id:'p', name:'界面验收项目', directory:'C:\\workspace\\project', createdAt:now, collaborationPaused:false }],
    sessions: [{ id:'s', projectId:'p', provider:'codex', title:'检查任务与实时介入', createdAt:now, updatedAt:now, revision:1, writeMode:false, workspace:'C:\\workspace\\project', workspaceKind:'original' }],
    runs:[{ id:'r', sessionId:'s', projectId:'p', provider:'codex', revision:1, status:'running', input:'检查工作区并给出实施计划，先等我确认方向。', createdAt:now, updatedAt:now, bootId:'test', delivery:'confirmed' }],
    events:[{ id:'e1', runId:'r', sessionId:'s', provider:'codex', at:now, kind:'delta', text:'已读取项目结构。接下来会检查现有约束，并整理需要你确认的实施顺序。', fidelity:'native' }, { id:'e2', runId:'r', sessionId:'s', provider:'codex', at:now, kind:'plan', text:'1. 查看现有项目文件\n2. 核对任务要求\n3. 提交计划，等待方向确认', fidelity:'native' }],
    approvals:[], providers:[{id:'codex',name:'Codex', available:true, auth:'subscription', detail:'测试环境认证响应', capabilities:{steer:true,cancel:'native',streaming:true,write:true,history:true}, checkedAt:now}],
    collaborations:[], settings, backendReady:true, dataDirectory:'C:\\test\\data', deepseekKeyConfigured:false,
  };
  // Test fixtures live only in the test browser; production starts with zero tasks.
  await page.addInitScript(({snapshot}) => {
    window.__snapshot = snapshot;
    window.__calls = [];
    window.__listeners = [];
    window.airoom = {
      invoke: async (method, params) => {
        window.__calls.push({method,params});
        if (method === 'snapshot') return structuredClone(window.__snapshot);
        const publish=()=>window.__listeners.forEach(listener=>listener({type:'snapshot',snapshot:structuredClone(window.__snapshot)}));
        const versionState=provider=>({member:provider,packageName:'fixture',current:'0.160.0',baselineVersions:['0.160.0'],connection:{state:'connected',detail:'fixture'},source:'custom',activeVersion:window.__snapshot.settings.paths[provider]?.includes('0.161.0')?'0.161.0':undefined,selectedPath:window.__snapshot.settings.paths[provider]??null,installed:['0.161.0']});
        if(method==='member.versions')return versionState(params.provider);
        if(method==='member.use'){
          window.__snapshot.settings.paths[params.provider]=params.version?`C:\\managed\\${params.version}\\${params.provider}.exe`:undefined;publish();return versionState(params.provider);
        }
        if(method==='settings.save'){
          const old=window.__snapshot.settings;window.__snapshot.settings={...old,...params.settings,paths:{...old.paths,...params.settings.paths},models:{...old.models,...params.settings.models}};publish();return structuredClone(window.__snapshot.settings);
        }
        if (method === 'artifact.list') return [{name:'review.html',relativePath:'review.html',path:'C:\\test\\review.html',size:100,modifiedAt:'2026-10-03',directory:false}];
        if (method === 'artifact.read') return {content:'<script>window.__outputExecuted = true</script><h1>产物预览</h1>',language:'html',truncated:false};
        if (method === 'project.diff') return {text:'diff --git a/example.md b/example.md\n+结果'};
        if (method === 'run.review') return {projectId:'p',sessionId:'s'};
        if (method === 'attachment.pick') return [{id:'11111111-1111-1111-1111-111111111111',name:'界面.png',kind:'image',mime:'image/png',size:2048},{id:'22222222-2222-2222-2222-222222222222',name:'需求.md',kind:'text',mime:'text/plain',size:120}];
        if (method === 'session.send') return params.text === '先不用聊' ? {delivery:'paused',activeTaskContinues:true} : {};
        return {};
      },
      onEvent: listener => {window.__listeners.push(listener); return () => {window.__listeners = window.__listeners.filter(item => item !== listener);};},
    };
  }, {snapshot});
  await installPersonalFixture(page);
  await page.reload();
  await page.getByText('今天想请谁来帮忙？').waitFor();
  await page.getByRole('button',{name:'Gptia 的工位',exact:true}).click();
  await page.getByRole('heading',{name:'Gptia 的工位',exact:true}).waitFor();
  await page.getByText('已读取项目结构。接下来会检查现有约束，并整理需要你确认的实施顺序。').waitFor();
  assert.equal(await page.getByRole('main',{name:'个人工位'}).getByRole('tab').count(),0);
  await page.screenshot({path:`${output}/desk-1100.png`});
  await page.getByRole('button',{name:'中止当前对话'}).click();
  let calls=await page.evaluate(()=>window.__calls);
  assert.ok(calls.some(c=>c.method==='room.stop'&&c.params.roomId==='desk:codex'));
  assert.ok(calls.some(c=>c.method==='run.stop'&&c.params.runId==='r'));
  await page.getByRole('button',{name:'添加图片或文件'}).click();
  await page.getByLabel('待发送的附件').getByText('需求.md').waitFor();
  await page.getByRole('textbox',{name:'在工位里说话'}).fill('按附件改');
  await page.getByRole('button',{name:'发送到工位'}).click();
  await page.waitForFunction(()=>window.__calls.some(c=>c.method==='room.send'&&c.params.text==='按附件改'&&c.params.attachments?.map(x=>x.name).join()==='界面.png,需求.md'));
  await page.getByLabel('待发送的附件').waitFor({state:'detached'});
  await page.getByRole('button', {name:'设置与连接'}).click();
  await page.getByRole('dialog', {name:'设置与成员连接'}).waitFor();
  const codexCard=page.locator('.provider-settings.member-codex');
  await codexCard.locator('.model-picker input').fill('fixture-unsaved-model');
  await codexCard.locator('.version-row select').selectOption('0.161.0');
  await page.waitForFunction(()=>window.__snapshot.settings.paths.codex==='C:\\managed\\0.161.0\\codex.exe');
  assert.equal(await codexCard.getByLabel(/执行文件路径/).inputValue(),'C:\\managed\\0.161.0\\codex.exe');
  await codexCard.getByRole('button',{name:'检查',exact:true}).click();
  await page.waitForFunction(()=>window.__calls.some(x=>x.method==='provider.probe'&&x.params.provider==='codex'));
  calls=await page.evaluate(()=>window.__calls);
  assert.equal(calls.filter(x=>x.method==='settings.save').at(-1).params.settings.paths.codex,'C:\\managed\\0.161.0\\codex.exe','probe must preserve the version selected in the same modal');
  assert.equal(calls.filter(x=>x.method==='settings.save').at(-1).params.settings.models.codex,'fixture-unsaved-model','switching must retain unsaved model changes');
  await codexCard.getByRole('button',{name:'登录',exact:true}).click();
  await page.waitForFunction(()=>window.__calls.some(x=>x.method==='provider.login'&&x.params.provider==='codex'));
  assert.equal(await page.evaluate(()=>window.__snapshot.settings.paths.codex),'C:\\managed\\0.161.0\\codex.exe');
  const authorization=page.getByLabel('Claude 官方授权码');
  await authorization.fill('fixture-code#fixture-state');
  assert.equal(await authorization.getAttribute('type'),'password');
  await page.getByRole('button',{name:'提交授权码',exact:true}).click();
  assert.equal(await authorization.inputValue(),'','authorization code must be cleared after submission');
  calls=await page.evaluate(()=>window.__calls);
  assert.ok(calls.some(call=>call.method==='provider.loginCode'&&call.params.provider==='claude'&&call.params.code==='fixture-code#fixture-state'));
  assert.ok(!(await page.locator('body').innerText()).includes('fixture-code'),'authorization code must never appear in visible output');
  await page.getByRole('button', {name:'网络', exact:true}).click();
  assert.equal(await page.getByRole('radio').first().isChecked(), true, 'network defaults to TUN');
  await page.screenshot({path:`${output}/network-1100.png`});
  await page.getByRole('button',{name:'权限',exact:true}).click();
  await page.getByRole('button',{name:'使用自动工作设置',exact:true}).click();
  const automatic=page.getByRole('checkbox',{name:'新工作会话自动批准操作'});
  assert.equal(await automatic.isChecked(),true);
  for(const member of ['Codex','Claude','DeepSeek Harness']){
    const group=page.getByRole('radiogroup',{name:member+' 文件范围',exact:true});
    assert.equal(await group.getByRole('radio',{name:'不限制',exact:true}).getAttribute('aria-checked'),'true');
  }
  await automatic.uncheck();await automatic.check();
  await page.getByRole('button', {name:'工作台',exact:true}).click();
  assert.equal(await page.getByRole('spinbutton',{name:/单个任务最长运行时间/}).inputValue(),'30');
  assert.equal(await page.getByRole('spinbutton',{name:/停止等待时间/}).inputValue(),'10');
  assert.equal(await page.getByRole('spinbutton',{name:/DeepSeek API 备选/}).count(),0,'the retired fallback no longer offers an ineffective budget control');
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.getByRole('dialog',{name:'设置与成员连接'}).waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>window.__snapshot.settings.paths.codex),'C:\\managed\\0.161.0\\codex.exe','saving must preserve the selected version');
  assert.equal(await page.evaluate(()=>window.__snapshot.settings.defaultAutoApprove),true);
  assert.equal(await page.evaluate(()=>window.__snapshot.settings.defaultWriteMode),true);
  assert.equal(await page.evaluate(()=>window.__snapshot.settings.models.codex),'fixture-unsaved-model','automatic work must preserve model edits');

  await page.evaluate(()=>{
    window.__snapshot.runs[0].status='rate_limited';window.__snapshot.runs[0].completedAt=new Date().toISOString();
    window.__listeners.forEach(listener=>listener({type:'snapshot',snapshot:structuredClone(window.__snapshot)}));
  });
  await expect(page.getByRole('button',{name:'中止当前对话',exact:true})).toHaveCount(0);
  await page.getByRole('textbox',{name:'在工位里说话'}).fill('额度恢复后的新任务');
  assert.equal(await page.getByRole('button',{name:'发送到工位'}).isDisabled(),false);

  await page.evaluate(() => {
    window.__snapshot.providers[0].auth = 'api';
    window.__listeners.forEach(listener => listener({type:'snapshot',snapshot:structuredClone(window.__snapshot)}));
  });
  await page.getByText('需改为订阅').first().waitFor();
  // Even an available CLI is blocked when Codex/Claude reports API authentication.
  await page.evaluate(() => {
    window.__snapshot.runs[0].status = 'ended';
    window.__listeners.forEach(listener => listener({type:'snapshot',snapshot:structuredClone(window.__snapshot)}));
  });
  await page.getByRole('textbox', {name:'在工位里说话'}).fill('另一项任务');
  assert.equal(await page.getByRole('button', {name:'发送到工位'}).isDisabled(), true, 'subscription members must not silently use API billing');

  await page.evaluate(() => {
    window.__snapshot.approvals = [{id:'a',runId:'r',sessionId:'s',provider:'codex',type:'approval',title:'读取已授权工作区',detail:'文件范围由原生请求确定。',options:[{id:'native_allow_once',label:'仅允许这次'},{id:'native_deny',label:'拒绝'}],state:'pending',createdAt:new Date().toISOString()}];
    window.__listeners.forEach(listener => listener({type:'snapshot',snapshot:structuredClone(window.__snapshot)}));
  });
  // Pending approvals show inline in the conversation and in the 回应 panel.
  await page.getByRole('main',{name:'个人工位'}).getByRole('button',{name:'仅允许这次'}).click();
  calls = await page.evaluate(() => window.__calls);
  assert.ok(calls.some(call => call.method === 'approval.answer' && call.params.choice === 'native_allow_once'), 'approval option id must retain native semantics');
  await page.evaluate(() => {
    window.__snapshot.backendReady = false;
    window.__listeners.forEach(listener => listener({type:'snapshot',snapshot:structuredClone(window.__snapshot)}));
  });
  await page.getByRole('button',{name:'重启后端'}).click();
  calls = await page.evaluate(()=>window.__calls);
  assert.ok(calls.some(call=>call.method==='backend.restart'));
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Renderer smoke passed: personal chat/stop/attachments, version switch preserves drafts through probe/login/save, terminal quota state, subscription guard, native approvals.');
} catch(error){await page.screenshot({path:`${output}/failure.png`});console.error('Renderer page errors:',errors);console.error('Renderer diagnostics:',await page.evaluate(()=>window.__calls?.filter(c=>c.method==='renderer.error')));throw error;} finally {
  await browser.close();
  await server?.close();
}
