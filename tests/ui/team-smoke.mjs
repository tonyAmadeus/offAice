import '../../scripts/test-bootstrap.mjs';
// Character cards, the user's profile and the team chat room against a fixture backend.
// node tests/ui/team-smoke.mjs → assertions plus screenshots in .test-cache/ui-preview
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from '../../scripts/ui-test-server.mjs';
import {installPersonalFixture} from './personal-fixture.mjs';

const output = new URL('../../.test-cache/ui-preview/', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '');
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}`;
const at = n => new Date(Date.now() - n * 60000).toISOString();
const provider = id => ({ id, name: id, available: true, auth: id === 'dsh' ? 'account' : 'subscription', detail: 'fixture', capabilities: { steer: false, cancel: 'native', streaming: true, write: true, history: true }, checkedAt: at(1), modelOptions: id === 'claude' ? [{ id: 'opus', label: 'Opus', efforts: ['low', 'high'], isDefault: true }] : [] });
const builtIns = [
  { id: 'claude', executor: 'claude', name: 'Claudia', motto: '翻开书，先把问题想清楚。', color: '#d9692f', builtIn: true },
  { id: 'codex', executor: 'codex', name: 'Gptia', motto: '交给我，代码我来理顺。', color: '#7b6fd6', builtIn: true },
  { id: 'dsh', executor: 'dsh', name: 'DS', motto: '收到！马上开工～', color: '#3c66d9', builtIn: true },
];
const snapshot = {
  projects: [{ id: 'p', name: '项目', directory: 'C:\\proj', createdAt: at(60), collaborationPaused: false }],
  sessions: [], runs: [], events: [], approvals: [], providers: ['claude', 'codex', 'dsh'].map(provider), collaborations: [],
  settings: { networkMode: 'tun', proxyUrl: '', paths: {}, models: {}, efforts: {}, permissions: { codex: { commands: 'auto', fileScope: 'any', network: true }, claude: { commands: 'auto', fileScope: 'any', network: true }, dsh: { commands: 'auto', fileScope: 'any', network: true } }, deepseekEnabled: false, deepseekBaseUrl: 'https://api.deepseek.com', dshProfile: 'airoom', maxParallel: 2, stopTimeoutMs: 10000, defaultWriteMode: true, defaultAutoApprove: true, maxRunMinutes: 30, deepseekMaxRequests: 12 },
  backendReady: true, dataDirectory: 'C:\\data', deepseekKeyConfigured: false,
  members: builtIns, profile: { name: '你' }, room: { messages: [], state: { active: false, mode: 'chat' }, currentThreadId:'room-main', threads:[{id:'room-main',title:'当前话题',createdAt:at(60)}], hasMore:false },
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 880 } });
const errors = [];
const confirmations = [];
let acceptDialogs = true;
page.on('dialog',async dialog=>{confirmations.push(dialog.message());if(acceptDialogs)await dialog.accept();else await dialog.dismiss();});
page.on('pageerror', error => errors.push(error.message));
try {
  await page.addInitScript(({ snapshot }) => {
    window.__snapshot = snapshot; window.__calls = []; window.__listeners = [];
    window.__roomFull = { [snapshot.room.currentThreadId]: [] }; window.__roomSequence=0;
    const publish = () => window.__listeners.forEach(listener => listener({ type: 'snapshot', snapshot: structuredClone(window.__snapshot) }));
    window.airoom = {
      invoke: async (method, params) => {
        window.__calls.push({ method, params });
        const s = window.__snapshot;
        if (method === 'snapshot') return structuredClone(s);
        if (method === 'team.save') {
          const card = { ...params.member, id: params.member.id || 'm-new' + (window.__memberSequence = (window.__memberSequence ?? 0) + 1), builtIn: ['claude', 'codex', 'dsh'].includes(params.member.id) };
          const index = s.members.findIndex(member => member.id === card.id);
          if (index >= 0) s.members[index] = { ...s.members[index], ...card }; else s.members.push(card);
          publish(); return card;
        }
        if (method === 'executor.save') {
          const executor={id:'acp-0a1b2c3d4e5f',args:[],env:{},permissions:{commands:'ask',fileScope:'workspace',network:true},createdAt:new Date().toISOString(),...params.executor,args:String(params.executor.args||'').split(/\s+/).filter(Boolean),env:Object.fromEntries(String(params.executor.env||'').split('\n').filter(Boolean).map(line=>line.split('=')))};
          s.executors=[...(s.executors??[]),executor];s.providers.push({id:executor.id,name:executor.name,available:false,auth:'none',detail:'Fake ACP 可以启动，但需要先登录。',capabilities:{steer:false,cancel:'native',streaming:true,write:true,history:true},checkedAt:new Date().toISOString()});
          publish();return executor;
        }
        if (method === 'executor.authenticate') {const info=s.providers.find(item=>item.id===params.id);info.available=true;info.auth='account';info.detail='Fake ACP 已通过 ACP 连接。';publish();return {detail:'已完成登录（浏览器登录）。'};}
        if (method === 'profile.save') { s.profile = params.profile; publish(); return s.profile; }
        if (method === 'project.update' && params.memberIds) { const project = s.projects.find(item => item.id === params.projectId); project.memberIds = params.memberIds; publish(); return project; }
        if (method === 'persona.import') return { path: 'C:\\Users\\me\\.dsh\\AGENTS.md', text: '你是大肥鱼，热情开朗。', truncated: false };
        if (method === 'room.send') {
          const full=window.__roomFull[s.room.currentThreadId];
          const add=message=>full.push({id:'msg-'+(++window.__roomSequence),threadId:s.room.currentThreadId,at:new Date().toISOString(),status:'done',...message});
          add({author:'user',text:params.text||'请看附件。',...(params.attachments?{attachments:params.attachments}:{})});
          const named=s.members.map(member=>({id:member.id,index:params.text.replaceAll('＠','@').toLowerCase().indexOf('@'+member.name.toLowerCase())})).filter(member=>member.index>=0).sort((a,b)=>a.index-b.index).map(member=>member.id);
          const recipients=named.length?named:params.memberIds;
          recipients.forEach(id=>add({author:id,text:id==='claude'?'大家好！今天心情不错。':'我也在，**随时**可以开工。'}));
          if(params.style==='work')add({author:recipients[0],text:'会议结论已经整理。',kind:'summary'});
          s.room.messages=full.slice(-100);s.room.hasMore=full.length>100;s.room.before=s.room.hasMore?s.room.messages[0].id:undefined;
          publish(); return { accepted: true };
        }
        if (method === 'attachment.pick') return [{id:'11111111-1111-1111-1111-111111111111',name:'界面.png',kind:'image',mime:'image/png',size:2048},{id:'22222222-2222-2222-2222-222222222222',name:'需求.md',kind:'text',mime:'text/plain',size:120}];
        if (method === 'attachment.reveal') return {shown:true};
        if (method === 'room.history') {
          const full=window.__roomFull[params.threadId]??[];
          const end=params.before?full.findIndex(message=>message.id===params.before):full.length;
          const start=Math.max(0,end-(params.limit??100)),messages=structuredClone(full.slice(start,end));
          if(window.__delayHistory)await new Promise(resolve=>{window.__releaseHistory=resolve;});
          return {threadId:params.threadId,messages,hasMore:start>0,before:start>0?messages[0].id:undefined};
        }
        if (method === 'room.export') {
          const thread=s.room.threads.find(item=>item.id===params.threadId),full=window.__roomFull[params.threadId];
          return {title:thread.title,content:'# '+thread.title+'\n\n'+full.map(message=>(message.kind==='summary'?'## 会议总结\n':'')+(message.status==='passed'?'（选择不发言）':message.text)).join('\n\n'),count:full.length};
        }
        if (method === 'run.review') {
          s.sessions.push({id:'review',projectId:'p',provider:'dsh',title:'复核 · Claudia',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),revision:1,writeMode:false});
          window.__roomFull[s.room.currentThreadId].push({id:'review-note',threadId:s.room.currentThreadId,author:'system',system:true,text:'已请 DS 复核 Claudia 在项目「项目」的结果。',at:new Date().toISOString(),link:{projectId:'p',sessionId:'review',runId:'review-run'}});
          s.room.messages=window.__roomFull[s.room.currentThreadId].slice(-100);publish();return {projectId:'p',sessionId:'review',runId:'review-run'};
        }
        if (method === 'run.verdict') {
          const full=window.__roomFull[s.room.currentThreadId],message=full.find(item=>item.id===params.messageId),target=message.link.reviewOf?.runId??message.link.runId;
          for(const item of full)if(item.link?.outcome&&!item.link.verdict&&(item.link.reviewOf?.runId??item.link.runId)===target)item.link={...item.link,verdict:params.verdict};
          s.room.messages=full.slice(-100);publish();return {};
        }
        if (method === 'room.handoff') {
          const session={id:'handed',projectId:params.projectId,provider:'claude',title:'Claude 对话',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),revision:1,writeMode:params.writeMode};
          s.sessions.push(session);
          window.__roomFull[s.room.currentThreadId].push({id:'handoff-note',threadId:s.room.currentThreadId,author:'system',system:true,text:'已交给 Claudia（项目「项目」）：请根据团队聊天室的讨论完成下面的任务。',at:new Date().toISOString(),link:{projectId:params.projectId,sessionId:'handed'}});
          s.room.messages=window.__roomFull[s.room.currentThreadId].slice(-100);publish();return {projectId:params.projectId,sessionId:'handed',runId:'handed-run'};
        }
        if (method === 'room.react') {
          const message=window.__roomFull[s.room.currentThreadId].find(item=>item.id===params.messageId);
          const reactions={...(message.reactions??{})},authors=reactions[params.emoji]??[];
          reactions[params.emoji]=authors.includes('user')?authors.filter(item=>item!=='user'):[...authors,'user'];
          if(!reactions[params.emoji].length)delete reactions[params.emoji];
          message.reactions=Object.keys(reactions).length?reactions:undefined;s.room.messages=window.__roomFull[s.room.currentThreadId].slice(-100);publish();return {reactions};
        }
        if (method === 'file.save') return {saved:true,path:'fixture.md'};
        if (method === 'room.archive') {
          const old=s.room.threads.find(item=>item.id===s.room.currentThreadId),source=params?.from?s.room.threads.find(item=>item.id===params.from):old;
          if(!window.__roomFull[old.id].length&&params?.inherit){old.inherited={threadId:source.id,title:source.title,text:'- 摘要：'+source.title};publish();return old;}
          old.archivedAt=new Date().toISOString();old.title=params?.title??'已归档的讨论';old.count=window.__roomFull[old.id].length;
          const next={id:'topic-'+(++window.__roomSequence),title:'当前话题',createdAt:new Date().toISOString(),count:0,...(params?.inherit?{inherited:{threadId:source.id,title:source.title,text:'- 摘要：'+source.title}}:{})};
          s.room.threads.unshift(next);s.room.currentThreadId=next.id;s.room.messages=[];s.room.hasMore=false;s.room.before=undefined;window.__roomFull[next.id]=[];
          publish();return next;
        }
        if (method === 'room.compress') {
          const thread=s.room.threads.find(item=>item.id===params.threadId),member=s.members.find(item=>item.id===params.memberId);
          thread.summary={text:'- 结论：按第二版来\n- 待办：Claudia 写测试',by:member.id,byName:member.name,at:new Date().toISOString(),count:window.__roomFull[thread.id].length,proposals:['阿潘喜欢简洁的回答','阿潘周末不谈工作']};publish();return thread.summary;
        }
        if (method === 'room.rename') {s.room.threads.find(item=>item.id===params.threadId).title=params.title.trim();publish();return {title:params.title.trim()};}
        if (method === 'memory.sources') return params.executor === 'claude' ? [{id:'claude:x',label:'Claude 项目记忆：C:\\x',count:1},{id:'claude:y',label:'Claude 项目记忆：C:\\y',count:2}] : [];
        if (method === 'memory.read') return params.source === 'claude:y' ? [{text:'习惯用 TypeScript',origin:'Claude 记忆 · a'},{text:'回答先给结论',origin:'Claude 记忆 · b'}] : [{text:'x 项目的事',origin:'Claude 记忆 · x'}];
        if (method === 'memory.accept' || method === 'memory.dismiss') {const thread=s.room.threads.find(item=>item.id===params.threadId);delete thread.summary.proposals;publish();return {};}
        if (method === 'room.uninherit') {const thread=s.room.threads.find(item=>item.id===params.threadId);delete thread.inherited;publish();return thread;}
        if (method === 'room.clear') {window.__roomFull[s.room.currentThreadId]=[];s.room.messages=[];s.room.hasMore=false;s.room.before=undefined;publish();return {cleared:true};}
        if (method === 'room.delete') {delete window.__roomFull[params.threadId];s.room.threads=s.room.threads.filter(item=>item.id!==params.threadId);publish();return {deleted:true};}
        return {};
      },
      onEvent: listener => { window.__listeners.push(listener); return () => {}; },
    };
  }, { snapshot });
  await installPersonalFixture(page);await page.goto(url);
  await page.getByText('今天想请谁来帮忙？').waitFor();
  // The home page lists what is still missing before work can start, with a way to fix each.
  const checklist = page.getByRole('region', { name: '开工前检查' });
  await checklist.getByText('告诉大家怎么称呼你').waitFor();
  const setProvider = change => page.evaluate(change => {
    const s = window.__snapshot, index = s.providers.findIndex(item => item.id === 'claude');
    window.__savedClaude ??= structuredClone(s.providers[index]);
    s.providers[index] = change ? { ...s.providers[index], ...change } : window.__savedClaude;
    window.__listeners.forEach(listener => listener({ type: 'snapshot', snapshot: structuredClone(s) }));
  }, change);
  await setProvider({ available: false, auth: 'none' });
  const claudeRow = checklist.locator('.setup-item', { hasText: 'Claudia' });
  await claudeRow.getByText('需要登录').waitFor();
  await page.waitForTimeout(300); await page.screenshot({ path: `${output}home-setup.png` });
  await claudeRow.getByRole('button', { name: '去登录' }).click();
  await page.locator('[data-provider="claude"].focus-flash').waitFor();
  await page.getByRole('button', { name: '关闭对话框' }).click();
  await setProvider(null);
  await claudeRow.getByText(/已就绪/).waitFor();
  // Ignoring the list hides it until something new needs attention.
  await checklist.getByRole('button', { name: '忽略开工前检查' }).click();
  await checklist.waitFor({ state: 'detached' });
  await setProvider({ available: false, auth: 'none' });
  await checklist.getByText('需要登录').waitFor();
  await setProvider(null);
  await checklist.waitFor({ state: 'detached' });
  // One entry per action: the home page no longer repeats sidebar buttons or lists recent sessions.
  for (const name of ['开启一个会话', '去聊天室', '设置成员连接', '检查成员连接']) assert.equal(await page.getByRole('button', { name }).count(), 0, `no duplicate "${name}" on the home page`);
  assert.equal(await page.getByText('最近的会话').count(), 0);
  // A roster avatar opens the member card rather than a new session.
  await page.locator('.roster-row.member-claude').click();
  const memberCard = page.getByRole('dialog', { name: 'Claudia 的人物卡片' });
  await memberCard.getByText('「翻开书，先把问题想清楚。」').waitFor();
  await memberCard.getByText('连接').waitFor();
  await page.waitForTimeout(250); await page.screenshot({ path: `${output}member-card.png` });
  await page.keyboard.press('Escape'); await memberCard.waitFor({ state: 'detached' });
  // So does a stage card; its one entry opens the member's desk on the most recent topic, without starting a new one.
  await page.getByRole('button', { name: '查看 Gptia 的人物卡片' }).click();
  const gptiaCard = page.getByRole('dialog', { name: 'Gptia 的人物卡片' });
  assert.equal(await gptiaCard.getByRole('button', { name: /开会话|打开工位/ }).count(), 0, 'one desk entry on the card');
  await gptiaCard.getByRole('button', { name: '去 Gptia 的工位聊天' }).click();
  await page.getByRole('main',{name:'个人工位'}).getByRole('heading',{name:'Gptia 的工位',exact:true}).waitFor();await gptiaCard.waitFor({state:'detached'});await page.waitForFunction(()=>window.__calls.some(c=>c.method==='desk.open'&&c.params.memberId==='codex'));assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.method==='desk.topic').length),0,'opening the desk does not start a topic');await page.getByRole('button',{name:/回到团队主页|AIROOM/}).first().click();
  // 请大家一起来: choose the project and who takes part. What to do and who leads are settled later, in the meeting room.
  await page.getByRole('button', { name: '请大家一起来' }).click();
  const collab = page.getByRole('dialog', { name: '请大家一起来' });
  assert.equal(await collab.locator('textarea').count(), 0, 'no goal to write at the entrance');
  assert.equal(await collab.getByRole('radiogroup', { name: '由谁来负责' }).count(), 0, 'no lead chosen at the entrance');
  assert.equal(await collab.getByRole('radio', { checked: true }).count(), 1, 'one project is chosen');
  await collab.locator('.collaborator-choice.member-dsh').click();
  assert.ok(await collab.getByRole('checkbox', { name: '邀请 Claudia' }).isChecked() && await collab.getByRole('checkbox', { name: '邀请 Gptia' }).isChecked() && !await collab.getByRole('checkbox', { name: '邀请 DS' }).isChecked(), 'clicking a card toggles that member');
  await page.waitForTimeout(250); await page.screenshot({ path: `${output}collaboration.png` });
  assert.equal(await collab.getByText('接力协作', { exact: true }).count(), 0);
  await collab.getByRole('button', { name: '进入会议室' }).click();
  await collab.waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.__calls.findLast(call => call.method === 'project.update')?.params), { projectId: 'p', memberIds: ['claude', 'codex'] }, 'the chosen people are saved on the project');
  assert.equal(await page.evaluate(() => localStorage.getItem('airoom.project.members:p')), null, 'nothing is kept in browser storage');
  assert.equal(await page.evaluate(() => window.__calls.filter(call => ['projectFlow.start', 'collaboration.start'].includes(call.method)).length), 0, 'entering the meeting room starts nothing');
  await page.locator('.brand').click(); await page.locator('.team-stage').waitFor();
  // Only configured members stand on the home page; there is no placeholder seat.
  assert.equal(await page.getByText('敬请期待').count(), 0);
  assert.equal(await page.locator('.team-stage [role="listitem"]').count(), await page.evaluate(() => window.__snapshot.members.length));
  const calls = () => page.evaluate(() => window.__calls);
  // Images are framed on the preview itself: drag to move, scroll to zoom.
  const avatarVars = () => page.locator('.card-preview-avatar .avatar').evaluate(avatar => ({ x: Number(avatar.style.getPropertyValue('--fx')), y: Number(avatar.style.getPropertyValue('--fy')), zoom: Number(avatar.style.getPropertyValue('--zoom')) }));
  const portraitVars = () => page.locator('.card-preview-portrait').evaluate(portrait => ({ scale: Number(portrait.style.getPropertyValue('--portrait-scale')), x: Number(portrait.style.getPropertyValue('--px')), y: Number(portrait.style.getPropertyValue('--py')) }));
  const drag = async (name, dx, dy) => {
    const box = await page.getByRole('group', { name }).boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 5 }); await page.mouse.up();
  };
  const wheel = async (name, deltaY) => {
    const box = await page.getByRole('group', { name }).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, deltaY); await page.waitForTimeout(50);
  };

  // Settings: members are portrait cards; editing one saves name, address and persona.
  await page.getByRole('button', { name: '设置与连接' }).click();
  const dialog = page.getByRole('dialog', { name: '设置与成员连接' });
  await dialog.getByRole('button', { name: '团队成员', exact: true }).click();
  await dialog.getByRole('button', { name: '编辑 Claudia 的人物卡' }).waitFor();
  await page.waitForTimeout(400); await page.screenshot({ path: `${output}team-gallery.png` });
  await dialog.getByRole('button', { name: '编辑 DS 的人物卡' }).click();
  await page.getByRole('textbox', { name: /怎么称呼你/ }).fill('阿潘');
  await page.getByRole('button', { name: /从DSH 桌面端的 AGENTS.md/ }).click();
  const personaPreview = page.getByRole('dialog', { name: '导入前先看看' });
  await personaPreview.getByText(/大肥鱼/).waitFor();
  await personaPreview.getByRole('button', { name: '用这段作为人设' }).click();
  await page.waitForFunction(() => document.querySelector('textarea')?.value.includes('大肥鱼'));
  // Everyday life: routine, habits and relations to teammates.
  await page.getByRole('textbox', { name: '早上的作息' }).fill('煎个蛋，听会儿歌');
  await page.getByRole('textbox', { name: '小动作' }).fill('甩尾巴\n\n抱着抱枕');
  await page.getByRole('textbox', { name: '和 Claudia 的关系' }).fill('最喜欢跟着她学东西');
  assert.equal(await page.getByRole('textbox', { name: '和 DS 的关系' }).count(), 0, 'no relation to oneself');
  await page.locator('.life-editor').screenshot({ path: `${output}team-life.png` });
  // Memory is a list of entries: add one, switch another off.
  await page.getByRole('textbox', { name: '新增一条记忆' }).fill('喜欢简洁的回答');
  await page.getByRole('textbox', { name: '新增一条记忆' }).press('Enter');
  await page.getByRole('textbox', { name: '新增一条记忆' }).fill('周末不讨论工作');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('checkbox', { name: /让成员记住：周末不讨论工作/ }).uncheck();
  await page.getByRole('group', { name: '长期记忆' }).getByText('生效 1 条').waitFor();
  await page.getByRole('group', { name: '长期记忆' }).screenshot({ path: `${output}team-memory.png` });
  assert.equal(await page.getByRole('slider').count(), 0, 'no per-axis sliders remain');
  const initialAvatar = await avatarVars();
  await drag('调整头像', 24, 12);
  const draggedAvatar = await avatarVars();
  assert.ok(draggedAvatar.x < initialAvatar.x && draggedAvatar.y < initialAvatar.y, 'dragging the avatar right and down moves the crop centre left and up');
  await wheel('调整头像', -300);
  const zoomedAvatar = await avatarVars();
  assert.ok(zoomedAvatar.zoom > draggedAvatar.zoom, 'scrolling up zooms the avatar in');
  await page.getByRole('group', { name: '调整头像' }).focus(); await page.keyboard.press('Equal');
  assert.ok(Math.abs((await avatarVars()).zoom - Math.round(zoomedAvatar.zoom * 1.1 * 1000) / 1000) < 0.002, '+ zooms in from the keyboard');
  const editedAvatar = await avatarVars();
  await wheel('调整立绘', 300);
  await drag('调整立绘', 30, -20);
  const editedPortrait = await portraitVars();
  assert.ok(editedPortrait.scale < 1 && editedPortrait.x > 0 && editedPortrait.y < 0, 'the portrait shrinks on scroll down and follows the drag');
  const previewGeometry = await page.locator('.card-preview-portrait img').evaluate(image => ({
    width: parseFloat(getComputedStyle(image).width), frameWidth: image.parentElement.clientWidth,
    frameHeight: image.parentElement.clientHeight, aspect: image.naturalHeight / image.naturalWidth,
  }));
  assert.ok(Math.abs(previewGeometry.width - Math.max(previewGeometry.frameWidth, previewGeometry.frameHeight / previewGeometry.aspect) * editedPortrait.scale) < 0.5, 'the portrait visibly shrinks from its default framing');
  assert.deepEqual(await avatarVars(), editedAvatar, 'framing the portrait does not alter the avatar crop');
  assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).count(), 0, 'the editor offers the correct save action');
  const saveBounds = await page.getByRole('button', { name: '保存人物卡' }).boundingBox();
  assert.ok(saveBounds.y >= 0 && saveBounds.y + saveBounds.height <= 880, 'saving remains visible even when card fields require scrolling');
  await page.locator('.card-image-controls').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300); await page.screenshot({ path: `${output}team-editor.png` });
  // The always-visible footer must save the card being edited, rather than discard it through settings.save.
  await dialog.locator('.modal-footer .button.primary').click();
  const savedCrop = (await calls()).find(call => call.method === 'team.save' && call.params.member.id === 'dsh');
  assert.ok(savedCrop, 'the footer must save the edited avatar crop through team.save');
  assert.deepEqual(savedCrop.params.member.face, editedAvatar);
  assert.equal(savedCrop.params.member.portraitScale, editedPortrait.scale);
  assert.deepEqual(savedCrop.params.member.portraitOffset, { x: editedPortrait.x, y: editedPortrait.y });
  await page.waitForFunction(() => window.__calls.some(call => call.method === 'team.save' && call.params.member.id === 'dsh' && call.params.member.userTitle === '阿潘' && call.params.member.persona.includes('大肥鱼') && call.params.member.memories?.length === 2 && call.params.member.memories.every(entry => entry.source === 'manual') && call.params.member.memories[1].off === true && call.params.member.memories[0].text === '喜欢简洁的回答' && call.params.member.routine?.morning === '煎个蛋，听会儿歌' && call.params.member.quirks?.join('|') === '甩尾巴|抱着抱枕' && call.params.member.relations?.some(item => item.memberId === 'claude' && item.text === '最喜欢跟着她学东西')));
  // Importing desktop memory: pick a source and items; they join the card as imported entries.
  await dialog.getByRole('button', { name: '编辑 Claudia 的人物卡' }).click();
  await page.getByRole('group', { name: '长期记忆' }).getByRole('button', { name: '从桌面端导入' }).click();
  const importDialog = page.getByRole('dialog', { name: '从桌面端导入记忆' });
  await importDialog.getByText('x 项目的事').waitFor();
  await importDialog.getByRole('combobox', { name: '记忆来源' }).selectOption('claude:y');
  await importDialog.getByText('回答先给结论').waitFor();
  await importDialog.locator('li', { hasText: '回答先给结论' }).getByRole('checkbox').uncheck();
  await page.waitForTimeout(200); await page.screenshot({ path: `${output}team-memory-import.png` });
  await importDialog.getByRole('button', { name: '加入 1 条' }).click();
  await page.getByRole('group', { name: '长期记忆' }).getByText('导入 · Claude 记忆 · a').waitFor();
  assert.equal(await page.getByRole('group', { name: '长期记忆' }).getByText('回答先给结论').count(), 0);
  await dialog.locator('.card-editor-footer').getByRole('button', { name: '取消' }).click();
  await dialog.getByRole('button', { name: '编辑 Claudia 的人物卡' }).waitFor();

  await dialog.getByRole('button', { name: '编辑 DS 的人物卡' }).click();
  assert.deepEqual(await avatarVars(), editedAvatar, 'the saved avatar crop survives reopening the editor');
  assert.deepEqual(await portraitVars(), editedPortrait, 'the saved portrait framing survives reopening the editor');
  await page.setViewportSize({ width: 1024, height: 730 });
  await page.locator('.card-image-controls').scrollIntoViewIfNeeded();
  const narrowPreview = await page.locator('.card-preview-portrait').boundingBox();
  const narrowSave = await page.getByRole('button', { name: '保存人物卡' }).boundingBox();
  assert.ok(narrowPreview.y >= 0 && narrowPreview.y + narrowPreview.height <= 730, 'the portrait preview stays visible while adjusting in a smaller desktop window');
  assert.ok(narrowSave.y >= 0 && narrowSave.y + narrowSave.height <= 730, 'the footer remains reachable in a smaller desktop window');
  await page.screenshot({ path: `${output}team-image-controls-1024.png` });
  await page.setViewportSize({ width: 1360, height: 880 });
  await wheel('调整立绘', -400); await page.getByRole('button', { name: '取消', exact: true }).click();
  await dialog.getByRole('button', { name: '编辑 DS 的人物卡' }).click();
  assert.deepEqual(await portraitVars(), editedPortrait, 'cancel leaves the saved framing untouched');
  await page.getByRole('button', { name: '立绘恢复默认' }).click();
  assert.deepEqual(await portraitVars(), { scale: 1, x: 0, y: 0 });
  await page.getByRole('button', { name: '头像恢复默认' }).click();
  await page.getByRole('button', { name: '保存人物卡' }).click();
  const resetSave = (await calls()).filter(call => call.method === 'team.save' && call.params.member.id === 'dsh').at(-1);
  assert.ok(resetSave.params.member.portraitScale === undefined && resetSave.params.member.portraitOffset === undefined && resetSave.params.member.face === undefined, 'default framing can be saved');
  await dialog.getByRole('button', { name: '编辑 DS 的人物卡' }).click();
  assert.deepEqual(await portraitVars(), { scale: 1, x: 0, y: 0 });
  await page.getByRole('button', { name: '取消', exact: true }).click();

  // Adding a member: choose an executor and a name.
  await page.getByRole('button', { name: /添加成员/ }).click();
  assert.equal(await page.getByRole('radio', { name: '接入新的 AI 程序' }).getAttribute('aria-checked'), 'true', 'a new member starts by connecting a new program');
  await page.getByRole('textbox', { name: /名字/ }).fill('审稿人');
  await page.getByRole('radio', { name: '沿用已有的程序' }).click();
  await page.getByRole('combobox', { name: '使用的程序', exact: true }).selectOption('codex');
  await page.getByRole('button', { name: '保存人物卡' }).click();
  await page.waitForFunction(() => window.__calls.some(call => call.method === 'team.save' && call.params.member.name === '审稿人' && call.params.member.executor === 'codex' && !call.params.member.id));
  await dialog.getByRole('button', { name: '编辑 审稿人 的人物卡' }).waitFor();

  // Connecting a new AI program: its connection is saved first, then the member that uses it.
  await page.getByRole('button', { name: /添加成员/ }).click();
  await page.getByRole('textbox', { name: /名字/ }).fill('小G');
  await page.getByRole('textbox', { name: '程序名称' }).fill('Gemini CLI');
  await page.getByRole('textbox', { name: '程序路径' }).fill('gemini');
  await page.getByRole('textbox', { name: '启动参数' }).fill('--experimental-acp');
  await page.getByRole('textbox', { name: '环境变量' }).fill('GEMINI_CLI_HOME=D:\\g');
  await page.waitForTimeout(300); await page.screenshot({ path: `${output}team-new-program.png` });
  await page.getByRole('button', { name: '保存人物卡' }).click();
  await page.waitForFunction(() => window.__calls.some(call => call.method === 'team.save' && call.params.member.name === '小G' && call.params.member.executor === 'acp-0a1b2c3d4e5f'));
  const connection = (await calls()).find(call => call.method === 'executor.save').params.executor;
  assert.deepEqual({ name: connection.name, command: connection.command, args: connection.args, env: connection.env }, { name: 'Gemini CLI', command: 'gemini', args: '--experimental-acp', env: 'GEMINI_CLI_HOME=D:\\g' });
  await dialog.getByRole('button', { name: '连接与版本', exact: true }).click();
  const acpSection = dialog.getByRole('region', { name: 'Gemini CLI 的连接' });
  await acpSection.getByText('需要先登录').waitFor();
  await acpSection.getByRole('button', { name: '登录' }).click();
  await acpSection.getByText('已通过 ACP 连接').waitFor(); await acpSection.getByText('已连接', { exact: true }).waitFor();
  await acpSection.getByRole('button', { name: '设置' }).click();
  assert.ok(await acpSection.getByRole('button', { name: '删除连接' }).isDisabled(), 'a connection in use cannot be deleted');
  await acpSection.scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await page.screenshot({ path: `${output}team-acp-connection.png` });
  await acpSection.getByRole('button', { name: '收起' }).click();

  // Profile: the user's own name, and how each member will address them.
  await page.getByRole('button', { name: '个人资料', exact: true }).click();
  await page.getByRole('textbox', { name: /你的名字/ }).fill('阿潘');
  await page.waitForTimeout(300); await page.screenshot({ path: `${output}team-profile.png` });
  await page.getByRole('button', { name: '保存个人资料' }).click();
  await page.waitForFunction(() => window.__calls.some(call => call.method === 'profile.save' && call.params.profile.name === '阿潘'));
  await page.getByRole('button', { name: '关闭对话框' }).click();

  // The chat room: invite, talk, and see replies with each member's face.
  await page.locator('.room-entry').filter({hasText:'茶歇室'}).click();
  await page.getByText('大家都在，聊点什么？').waitFor();
  // The studio behind the chat shows the picture for the current time of day.
  assert.ok(['morning','afternoon','evening','night'].includes(await page.locator('.room-backdrop').getAttribute('data-period')));
  assert.equal(await page.locator('.room-backdrop-layer.current').count(), 1);
  await page.waitForTimeout(400); await page.screenshot({ path: `${output}room-empty.png` });
  await page.locator('.guest-chip.on', { hasText: '审稿人' }).waitFor(); // a new ready member is invited by default
  await page.getByRole('textbox', { name: '在聊天室里说话' }).fill('大家早上好！');
  await page.getByRole('button', { name: '发送到聊天室' }).click();
  await page.getByText('大家好！今天心情不错。').waitFor();
  const sent = (await calls()).find(call => call.method === 'room.send');
  assert.deepEqual(sent.params.memberIds.sort(), ['claude', 'codex', 'dsh', 'm-new1', 'm-new2'].sort(), 'a signed-in ACP member joins the room like everyone else');
  assert.equal(sent.params.mode, 'discuss'); assert.equal(sent.params.style, 'chat'); assert.equal(sent.params.maxCalls, undefined, 'chat uses the saved call policy instead of forcing an unlimited override');
  await page.waitForTimeout(400); await page.screenshot({ path: `${output}room-chat.png` });
  assert.equal(await page.getByRole('radio', { name: '自由讨论' }).count(), 0, '自由讨论 is folded into 闲聊 and 开会');
  await page.getByRole('radio', { name: '开会' }).click();
  await page.getByRole('button', { name: '开始会议' }).waitFor();
  assert.equal(await page.getByLabel('讨论调用预算').count(), 0, 'call policy belongs in settings rather than the composer');

  // @ completion supports the keyboard and preserves textual mention order.
  await page.getByRole('radio',{name:'闲聊'}).click();
  const roomInput=page.getByRole('textbox',{name:'在聊天室里说话'});
  await roomInput.fill('@');
  await page.getByRole('listbox',{name:'点名成员'}).waitFor();
  await page.screenshot({path:`${output}room-mentions.png`});
  await roomInput.press('ArrowDown');await roomInput.press('Enter');
  assert.equal(await roomInput.inputValue(),'@Gptia ');
  await roomInput.fill('@Gptia @d');await roomInput.press('Enter');
  assert.equal(await roomInput.inputValue(),'@Gptia @DS ');
  await roomInput.fill('@Gptia @DS 点名顺序验证');await roomInput.press('Control+Enter');
  await page.waitForFunction(()=>window.__calls.filter(call=>call.method==='room.send').length===2);
  const namedSend=(await calls()).filter(call=>call.method==='room.send').at(-1);
  assert.equal(namedSend.params.text,'@Gptia @DS 点名顺序验证');
  assert.deepEqual(await page.evaluate(()=>window.__snapshot.room.messages.slice(-2).map(message=>message.author)),['codex','dsh']);
  await page.getByRole('radio',{name:'开会'}).click();await roomInput.fill('@Gptia 会议议题');
  await page.getByRole('button',{name:'开始会议'}).click();await page.getByText('会议总结',{exact:true}).waitFor();

  // "+" attaches pictures and files; the tray shows them before sending and the sent message keeps them.
  await page.getByRole('radio',{name:'闲聊'}).click();
  await page.getByRole('button',{name:'添加图片或文件'}).click();
  const tray=page.getByLabel('待发送的附件');
  await tray.getByText('界面.png').waitFor();await tray.getByText('需求.md').waitFor();
  await tray.getByRole('button',{name:'移除附件 需求.md'}).click();
  await tray.getByText('需求.md').waitFor({state:'detached'});
  await page.waitForTimeout(200);await page.locator('.room-input').screenshot({path:`${output}room-attachments.png`});
  assert.equal(await page.getByRole('button',{name:'发送到聊天室'}).isDisabled(),false,'a picture alone can be sent');
  await page.getByRole('button',{name:'发送到聊天室'}).click();
  await page.waitForFunction(()=>window.__calls.some(call=>call.method==='room.send'&&call.params.attachments?.length===1&&call.params.attachments[0].name==='界面.png'));
  await page.locator('.room-line.mine .attachment-image img[alt="界面.png"]').waitFor();
  await tray.waitFor({state:'detached'});
  await page.getByRole('radio',{name:'开会'}).click();
  assert.equal(await page.getByRole('button',{name:'添加图片或文件'}).isDisabled(),false,'a meeting accepts the same attachments');
  await page.getByRole('radio',{name:'闲聊'}).click();

  // Pages remain complete while new messages move the snapshot's recent-message window.
  await page.evaluate(()=>{
    const s=window.__snapshot,threadId=s.room.currentThreadId;
    const full=Array.from({length:350},(_,index)=>({id:'history-'+index,threadId,author:'user',text:'历史第 '+index+' 条',at:'2026-10-04T02:00:00Z',status:'done'}));
    window.__roomFull[threadId]=full;s.room.messages=full.slice(-100);s.room.hasMore=true;s.room.before=s.room.messages[0].id;
    window.__listeners.forEach(listener=>listener({type:'snapshot',snapshot:structuredClone(s)}));
  });
  await page.getByText('历史第 349 条',{exact:true}).waitFor();
  await page.locator('.room-messages').evaluate(node=>{node.scrollTop=0;});
  await page.getByText('历史第 150 条',{exact:true}).waitFor();
  await page.evaluate(()=>{
    const s=window.__snapshot,full=window.__roomFull[s.room.currentThreadId];
    full.push({id:'history-350',threadId:s.room.currentThreadId,author:'user',text:'历史第 350 条',at:'2026-10-04T02:00:00Z',status:'done'});
    s.room.messages=full.slice(-100);s.room.before=s.room.messages[0].id;window.__listeners.forEach(listener=>listener({type:'snapshot',snapshot:structuredClone(s)}));
  });
  await page.getByText('历史第 350 条',{exact:true}).waitFor();
  assert.equal(await page.getByText('历史第 250 条',{exact:true}).count(),1,'the message removed from the rolling snapshot remains in loaded history');
  await page.locator('.room-messages').evaluate(node=>{node.scrollTop=0;});await page.getByText('历史第 50 条',{exact:true}).waitFor();
  await page.locator('.room-messages').evaluate(node=>{node.scrollTop=0;});await page.getByText('历史第 0 条',{exact:true}).waitFor();
  assert.equal(await page.locator('.room-line').count(),351);
  await page.evaluate(()=>{
    const s=window.__snapshot,full=window.__roomFull[s.room.currentThreadId];
    full.push({id:'passed',threadId:s.room.currentThreadId,author:'claude',authorName:'Claudia',text:'[PASS]',status:'passed',at:'2026-10-04T02:00:00Z'});
    full.push({id:'summary',threadId:s.room.currentThreadId,author:'codex',text:'保留的会议总结',kind:'summary',status:'done',at:'2026-10-04T02:00:00Z'});
    s.room.messages=full.slice(-100);window.__listeners.forEach(listener=>listener({type:'snapshot',snapshot:structuredClone(s)}));
  });
  await page.locator('.room-passed summary').waitFor();assert.equal(await page.getByText('[PASS]',{exact:true}).count(),0);
  await page.locator('.room-passed summary').click();await page.getByText('这次没有需要补充的内容。判断是否发言仍会使用额度。').waitFor();
  await page.getByRole('button',{name:'话题操作'}).click();await page.getByRole('menuitem',{name:'导出聊天室'}).click();
  await page.waitForFunction(()=>window.__calls.some(call=>call.method==='file.save'));
  const exported=(await calls()).find(call=>call.method==='file.save').params.content;
  assert.ok(exported.includes('历史第 0 条')&&exported.includes('保留的会议总结')&&exported.includes('会议总结'));

  // Reading position: member messages arriving while scrolled up are counted, and a long answer starts folded.
  const arrive = (items) => page.evaluate(items => {
    const s = window.__snapshot, threadId = s.room.currentThreadId, full = window.__roomFull[threadId], at = Date.now();
    items.forEach((item, index) => full.push({ threadId, status: 'done', at: new Date(at + 60000 + index).toISOString(), ...item }));
    s.room.messages = full.slice(-100); window.__listeners.forEach(listener => listener({ type: 'snapshot', snapshot: structuredClone(s) }));
  }, items);
  await page.locator('.room-messages').evaluate(node => { node.scrollTop = 0; });
  await page.waitForTimeout(200);
  await arrive([{ id: 'late-1', author: 'codex', text: '我补充一点。' }, { id: 'late-long', author: 'claude', text: Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 行`).join('\n') }]);
  const jump = page.getByRole('button', { name: '有 2 条新消息' });
  await jump.click(); await jump.waitFor({ state: 'detached' });
  const longLine = page.locator('.room-line', { hasText: '第 30 行' });
  await longLine.locator('.room-bubble.folded').waitFor();
  await longLine.getByRole('button', { name: '展开全文' }).click();
  await longLine.getByRole('button', { name: '收起' }).waitFor();
  assert.equal(await longLine.locator('.room-bubble.folded').count(), 0);
  // Leaving and returning: a divider marks what arrived meanwhile.
  await page.getByTitle('回到团队主页').click();
  await page.getByText('今天想请谁来帮忙？').waitFor();
  await page.waitForTimeout(100);
  await arrive([{ id: 'while-away', author: 'dsh', text: '你不在的时候我想到一个办法。' }]);
  await page.locator('.room-entry').filter({hasText:'茶歇室'}).click();
  const divider = page.getByRole('separator').filter({ hasText: '以下是新消息' });
  await divider.waitFor();
  assert.equal(await page.locator('.room-new-divider + .room-line').innerText().then(text => text.includes('你不在的时候我想到一个办法。')), true, 'the divider sits right before the first unread message');
  await page.waitForTimeout(300); await page.screenshot({ path: `${output}room-unread.png` });

  // Reactions: members' emoji show on the user's message; the user can add and remove theirs on member messages.
  await page.evaluate(()=>{
    const s=window.__snapshot,full=window.__roomFull[s.room.currentThreadId];
    full.push({id:'asked',threadId:s.room.currentThreadId,author:'user',text:'方案定了吗？',status:'done',at:'2026-10-04T02:01:00Z',reactions:{'👍':['codex','dsh']}});
    full.push({id:'reacted',threadId:s.room.currentThreadId,author:'codex',text:'',status:'passed',reaction:'👍',replyTo:'asked',at:'2026-10-04T02:01:00Z'});
    full.push({id:'answer',threadId:s.room.currentThreadId,author:'claude',text:'定了，按第二版来。',status:'done',at:'2026-10-04T02:01:00Z'});
    s.room.messages=full.slice(-100);window.__listeners.forEach(listener=>listener({type:'snapshot',snapshot:structuredClone(s)}));
  });
  const memberReaction=page.getByRole('button',{name:'👍 Gptia、DS'});
  await memberReaction.waitFor();assert.ok(await memberReaction.isDisabled(),'members\' reactions on the user message are read-only');
  assert.equal(await page.getByText('Gptia 选择不发言').count(),0,'a reaction-only turn does not add its own line');
  const answer=page.locator('.room-line',{hasText:'定了，按第二版来。'});
  await answer.hover();await answer.getByRole('button',{name:'添加表情回应'}).click();
  await page.getByRole('menuitem',{name:'回应 👍 同意'}).click();
  await page.waitForFunction(()=>window.__calls.some(call=>call.method==='room.react'&&call.params.messageId==='answer'&&call.params.emoji==='👍'));
  const mine=answer.getByRole('button',{name:'👍 阿潘'});
  await mine.waitFor();assert.equal(await mine.getAttribute('aria-pressed'),'true');
  await page.waitForTimeout(300);await page.screenshot({path:`${output}room-reactions.png`});
  await mine.click();await mine.waitFor({state:'detached'});

  // Hand a conclusion to a project; the room notes it and the note opens the session.
  // Message actions sit in one menu: from "…" or a right-click on the message.
  await answer.hover(); await answer.getByRole('button', { name: 'Claudia 的消息操作' }).click();
  const actions = page.getByRole('menu');
  assert.deepEqual(await actions.getByRole('menuitem').allInnerTexts(), ['复制文字', '回复这条', '交给项目']);
  await page.keyboard.press('Escape'); await actions.waitFor({ state: 'detached' });
  await answer.locator('.room-bubble').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '交给项目' }).click();
  const handoffDialog = page.getByRole('dialog', { name: '交给项目' });
  assert.match(await handoffDialog.getByRole('textbox', { name: '交给项目的任务' }).inputValue(), /Claudia：定了，按第二版来。/);
  await handoffDialog.getByRole('combobox', { name: '交给哪位成员' }).selectOption('claude');
  await handoffDialog.getByRole('checkbox', { name: /允许修改文件/ }).uncheck();
  await page.waitForTimeout(300); await page.screenshot({ path: `${output}room-handoff.png` });
  await handoffDialog.getByRole('button', { name: '交给 Claudia' }).click();
  await page.waitForFunction(() => window.__calls.some(call => call.method === 'room.handoff' && call.params.projectId === 'p' && call.params.memberId === 'claude' && call.params.writeMode === false && call.params.messageId === 'answer' && !call.params.sessionId));
  await page.getByRole('button', { name: /已交给 Claudia.*打开会话/ }).click();
  const handedDesk=page.getByRole('main',{name:'个人工位'});await handedDesk.getByRole('heading',{name:'Claudia 的工位',exact:true}).waitFor();
  await page.waitForFunction(()=>window.__calls.some(c=>c.method==='room.select'&&c.params.roomId==='desk:claude'&&c.params.threadId==='desk-topic-handed'));
  assert.equal(await handedDesk.getByRole('combobox',{name:'话题记录'}).inputValue(),'desk-topic-handed','the original handoff session opens as its own desk topic');
  assert.equal(await page.getByRole('button',{name:'打开工作记录'}).count(),0,'the personal desk has no project activity panel');
  await page.setViewportSize({width:1640,height:880});await page.screenshot({path:`${output}handoff-desk-wide.png`});
  assert.equal(await page.getByRole('button',{name:'和聊天室并排显示'}).count(),0,'the desk remains an independent chat at a wide width');
  await page.setViewportSize({width:1360,height:880});
  await page.locator('.room-entry').filter({hasText:'茶歇室'}).click();
  await page.getByText('定了，按第二版来。').waitFor();

  // The outcome note shows the answer and offers acceptance, sending back and a review by another member.
  const outcomeNote = (id, runId, extra) => page.evaluate(([id, runId, extra]) => {
    const s = window.__snapshot, threadId = s.room.currentThreadId, at = new Date().toISOString();
    if (!s.runs.some(run => run.id === runId)) s.runs.push({ id: runId, sessionId: 'handed', projectId: 'p', provider: 'claude', revision: 1, status: 'ended', inputPreview: '第二版', inputLength: 3, createdAt: at, updatedAt: at, completedAt: at, delivery: 'confirmed', bootId: 'boot' });
    window.__roomFull[threadId].push({ id, threadId, author: 'system', system: true, at, ...extra });
    s.room.messages = window.__roomFull[threadId].slice(-100);
    window.__listeners.forEach(listener => listener({ type: 'snapshot', snapshot: structuredClone(s) }));
  }, [id, runId, extra]);
  await outcomeNote('outcome-note', 'handed-run', { text: 'Claudia 在项目「项目」完成了交给 TA 的任务，结果待你验收。', detail: '**已完成**：第二版写好了。', link: { projectId: 'p', sessionId: 'handed', runId: 'handed-run', outcome: 'ended' } });
  const taskNote = page.locator('.room-note').filter({ hasText: '完成了交给 TA 的任务' });
  await taskNote.getByText('查看 Claudia 的回答').click();
  await taskNote.getByText('第二版写好了。').waitFor();
  await taskNote.getByRole('button', { name: '请人复核' }).click();
  const reviewDialog = page.getByRole('dialog', { name: '请人复核' });
  const reviewers = await reviewDialog.getByRole('combobox', { name: '复核成员' }).locator('option').evaluateAll(options => options.map(option => option.value));
  assert.ok(!reviewers.includes('claude') && reviewers.includes('dsh'), 'the author never reviews their own result');
  await reviewDialog.getByRole('combobox', { name: '复核成员' }).selectOption('dsh');
  await reviewDialog.getByRole('textbox', { name: '复核重点' }).fill('看看表单');
  await page.waitForTimeout(300); await page.screenshot({ path: `${output}room-review.png` });
  await reviewDialog.getByRole('button', { name: '请 DS 复核' }).click();
  await page.waitForFunction(() => window.__calls.some(call => call.method === 'run.review' && call.params.runId === 'handed-run' && call.params.memberId === 'dsh' && call.params.focus === '看看表单' && call.params.messageId === 'outcome-note' && call.params.threadId));
  await page.getByRole('button', { name: /已请 DS 复核 Claudia.*打开会话/ }).waitFor();
  await outcomeNote('review-outcome', 'review-run', { text: 'DS 在项目「项目」复核完了 Claudia 的结果，结论在下面。', detail: '**需实测**：表单校验。\n需要修改', link: { projectId: 'p', sessionId: 'review', runId: 'review-run', outcome: 'ended', reviewOf: { sessionId: 'handed', runId: 'handed-run' } } });
  const reviewNote = page.locator('.room-note').filter({ hasText: '复核完了' });
  await reviewNote.getByText('查看复核结论').waitFor();
  await reviewNote.getByRole('button', { name: '交给 Claudia 修改' }).click();
  const returnDialog = page.getByRole('dialog', { name: '交给 Claudia 修改' });
  assert.match(await returnDialog.getByRole('textbox', { name: '修改意见' }).inputValue(), /需要修改/);
  await returnDialog.getByRole('button', { name: '交回 Claudia 修改' }).click();
  await page.waitForFunction(() => window.__calls.some(call => call.method === 'run.verdict' && call.params.messageId === 'review-outcome' && call.params.verdict === 'returned' && /需要修改/.test(call.params.note)));
  await reviewNote.getByText('已打回修改').waitFor(); await taskNote.getByText('已打回修改').waitFor();
  await outcomeNote('fixed-outcome', 'fixed-run', { text: 'Claudia 在项目「项目」完成了交给 TA 的任务，结果待你验收。', link: { projectId: 'p', sessionId: 'handed', runId: 'fixed-run', outcome: 'ended' } });
  const fixedNote = page.locator('.room-note').filter({ hasNotText: '已打回修改' }).filter({ hasText: '结果待你验收' });
  await fixedNote.getByRole('button', { name: '通过', exact: true }).click();
  await page.waitForFunction(() => window.__calls.some(call => call.method === 'run.verdict' && call.params.messageId === 'fixed-outcome' && call.params.verdict === 'accepted'));
  await page.locator('.room-note').filter({ hasText: '已验收通过' }).waitFor();
  await page.waitForTimeout(300); await page.screenshot({ path: `${output}room-verdicts.png` });

  // Compress the current topic: one member writes a summary, which the topic bar then carries.
  await page.getByRole('button',{name:'话题操作'}).click();await page.getByRole('menuitem',{name:'压缩上下文'}).click();
  await page.waitForFunction(()=>window.__calls.some(call=>call.method==='room.compress'&&call.params.memberId==='claude'));
  await page.locator('.room-topic-bar .topic-summary summary').waitFor();
  assert.match(await page.locator('.room-topic-bar .topic-summary summary').innerText(),/已压缩 · Claudia/);
  await page.getByRole('button',{name:'有 2 条可以记住的事'}).click();
  const proposalDialog=page.getByRole('dialog',{name:'可以记住的事'});
  await proposalDialog.locator('li',{hasText:'阿潘周末不谈工作'}).getByRole('checkbox').uncheck();
  await proposalDialog.locator('label',{hasText:'Gptia'}).getByRole('checkbox').uncheck();
  await page.waitForTimeout(200); await page.screenshot({path:`${output}room-memory-proposals.png`});
  await proposalDialog.getByRole('button',{name:'记住 1 条'}).click();
  await page.waitForFunction(()=>window.__calls.some(call=>call.method==='memory.accept'&&call.params.texts.join()==='阿潘喜欢简洁的回答'&&!call.params.memberIds.includes('codex')&&call.params.memberIds.includes('claude')));
  await page.getByRole('button',{name:/条可以记住的事/}).waitFor({state:'detached'});

  // Topic management: every topic in one panel, renaming in place.
  await page.getByRole('button',{name:'话题操作'}).click();await page.getByRole('menuitem',{name:'话题管理'}).click();
  const panel=page.getByRole('complementary',{name:'话题管理'});
  await panel.getByRole('button',{name:'改名'}).click();
  await panel.getByRole('textbox',{name:'话题名称'}).fill('第二版方案');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.__calls.some(call=>call.method==='room.rename'&&call.params.title==='第二版方案'));
  await panel.getByText('第二版方案',{exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭话题管理'}).click();

  // Archive, read-only viewing, export and deletion are separate from clearing the current topic.
  const archivedId=await page.evaluate(()=>window.__snapshot.room.currentThreadId);
  await page.getByRole('button',{name:'开新话题'}).click();
  const newTopic=page.getByRole('dialog',{name:'开新话题'});
  await newTopic.getByRole('textbox',{name:/给当前话题起个名字/}).fill('方案讨论');
  assert.ok(await newTopic.getByRole('checkbox',{name:/继承压缩后的上下文/}).isChecked(),'inheriting the summary is the default');
  await page.waitForTimeout(300);await page.screenshot({path:`${output}room-new-topic.png`});
  await newTopic.getByRole('button',{name:'开始新话题'}).click();
  await page.getByText('大家都在，聊点什么？').waitFor();
  const archiveCall=(await calls()).filter(call=>call.method==='room.archive').at(-1);
  assert.deepEqual({title:archiveCall.params.title,inherit:archiveCall.params.inherit,memberId:archiveCall.params.memberId},{title:'方案讨论',inherit:true,memberId:'claude'});
  await page.locator('.room-topic-bar .topic-summary.inherited summary').waitFor();
  assert.match(await page.locator('.room-topic-bar .topic-summary.inherited summary').innerText(),/延续「方案讨论」/);
  await page.getByRole('combobox',{name:'话题记录'}).selectOption(archivedId);
  await page.getByText('保留的会议总结',{exact:true}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'在聊天室里说话'}).count(),0,'archives are read-only');
  await page.waitForTimeout(400);await page.screenshot({path:`${output}room-archive.png`});
  await page.getByRole('button',{name:'话题操作'}).click();await page.getByRole('menuitem',{name:'导出聊天室'}).click();
  await page.waitForFunction(()=>window.__calls.filter(call=>call.method==='file.save').length===2);
  assert.ok((await calls()).filter(call=>call.method==='file.save').at(-1).params.content.includes('历史第 0 条'),'archive export includes records not yet loaded on screen');
  await page.getByRole('button',{name:'回到当前话题'}).click();
  // A late archive response cannot replace the active topic after switching back.
  await page.evaluate(()=>{window.__delayHistory=true;});
  await page.getByRole('combobox',{name:'话题记录'}).selectOption(archivedId);
  await page.waitForFunction(()=>Boolean(window.__releaseHistory));
  await page.getByRole('button',{name:'回到当前话题'}).click();
  await page.evaluate(()=>{window.__delayHistory=false;window.__releaseHistory();});
  await page.getByText('大家都在，聊点什么？').waitFor();assert.equal(await page.getByText('保留的会议总结',{exact:true}).count(),0);
  // From the panel: continue an archived topic in the (empty) current one, then delete the archive.
  await page.getByRole('button',{name:'话题操作'}).click();await page.getByRole('menuitem',{name:'话题管理'}).click();
  await page.waitForTimeout(300);await page.screenshot({path:`${output}room-topics.png`});
  const archivedItem=panel.locator('.topic-item',{hasText:'方案讨论'});
  await archivedItem.getByRole('button',{name:'接着聊'}).click();
  await page.getByRole('dialog',{name:'接着这个话题聊'}).getByRole('button',{name:'开始新话题'}).click();
  await page.waitForFunction(id=>window.__calls.some(call=>call.method==='room.archive'&&call.params.from===id&&call.params.inherit===true),archivedId);
  await page.getByRole('combobox',{name:'话题记录'}).selectOption(archivedId);await page.getByText('保留的会议总结',{exact:true}).waitFor();
  await page.getByRole('button',{name:'话题操作'}).click();await page.getByRole('menuitem',{name:'删除归档话题'}).click();await page.getByText('大家都在，聊点什么？').waitFor();
  assert.equal(await page.getByRole('combobox',{name:'话题记录'}).locator('option').count(),1);
  // The current topic can stop continuing the earlier one; the summary bar goes with it.
  await page.getByRole('button',{name:'不再延续'}).click();
  await page.waitForFunction(()=>window.__calls.some(call=>call.method==='room.uninherit'&&call.params.threadId===window.__snapshot.room.currentThreadId));
  await page.locator('.room-topic-bar .topic-summary.inherited').waitFor({state:'detached'});
  assert.ok(confirmations.some(text=>text.startsWith('不再延续「方案讨论」')));
  assert.ok(confirmations.some(text=>text.startsWith('让 Claudia 把当前话题压缩成摘要'))&&confirmations.some(text=>text.startsWith('删除归档话题')));

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Team smoke passed: setup checklist, member card and desk topics, collaboration picker, cards/avatar/portrait, new ACP program member + connection, desktop memory import, profile, room @ completion/order, meeting summary, stable full-history paging during new arrivals, collapsed PASS, new-message jump/fold/divider, emoji reactions, original handoff session in personal desk, review and acceptance, compression, memory proposals, topic panel/rename/inherit/continue/stop continuing, complete export, archive/read-only/delete and late history response isolation.');
} finally { await browser.close(); await server.close(); }
