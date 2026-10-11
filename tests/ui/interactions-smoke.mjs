import '../../scripts/test-bootstrap.mjs';
// Session management and desktop-style interactions against a fixture backend.
// node tests/ui/interactions-smoke.mjs
import assert from 'node:assert/strict';
import {installPersonalFixture} from './personal-fixture.mjs';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from '../../scripts/ui-test-server.mjs';

const output = new URL('../../.test-cache/ui-preview/', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '');
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}`;
const at = n => new Date(Date.now() - n * 60000).toISOString();
const provider = id => ({ id, name: id, available: true, auth: id === 'dsh' ? 'account' : 'subscription', detail: 'fixture', ...(id==='claude'?{configuration:{model:true,effort:'reported'},modelOptions:[{id:'opus',label:'Opus',efforts:['low','high'],effortSource:'reported',isDefault:true}]}:{}), capabilities: { steer: false, cancel: 'native', streaming: true, write: true, history: true }, checkedAt: at(1) });
const snapshot = {
  projects: [{ id: 'p', name: '交互项目', directory: 'C:\\proj', createdAt: at(60), collaborationPaused: false }],
  sessions: [
    { id: 'a', projectId: 'p', provider: 'claude', title: 'Claude 对话', createdAt: at(50), updatedAt: at(5), revision: 1, writeMode: true, workspace: 'C:\\data\\workspaces\\a', workspaceKind: 'worktree' },
    { id: 'b', projectId: 'p', provider: 'codex', title: '整理登录流程', createdAt: at(40), updatedAt: at(4), revision: 1, writeMode: true },
    { id: 'c', projectId: 'p', provider: 'dsh', title: '旧的调研', createdAt: at(30), updatedAt: at(30), revision: 1, writeMode: false, archived: true },
  ],
  runs: [
    { id: 'r1', sessionId: 'a', projectId: 'p', provider: 'claude', revision: 1, status: 'stopped', input: '把 README 翻译成英文', createdAt: at(6), updatedAt: at(5), completedAt: at(5), bootId: 'b', delivery: 'confirmed' },
    { id: 'r2', sessionId: 'b', projectId: 'p', provider: 'codex', revision: 1, status: 'ended', input: '检查登录', createdAt: at(4), updatedAt: at(3), completedAt: at(3), bootId: 'b', delivery: 'confirmed' },
  ],
  events: [{ id: 'u1', runId: 'r1', sessionId: 'a', provider: 'claude', at: at(5), kind: 'status', text: '额度', data: { rateLimit: { status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1791069000 } } } }, fidelity: 'native' }], approvals: [], providers: ['claude', 'codex', 'dsh'].map(provider), collaborations: [],
  settings: { networkMode: 'tun', proxyUrl: '', paths: {}, models: {}, efforts: {}, permissions: { codex: { commands: 'auto', fileScope: 'any', network: true }, claude: { commands: 'auto', fileScope: 'any', network: true }, dsh: { commands: 'auto', fileScope: 'any', network: true } }, deepseekEnabled: false, deepseekBaseUrl: '', dshProfile: 'airoom', maxParallel: 2, stopTimeoutMs: 10000, defaultWriteMode: true, defaultAutoApprove: true, maxRunMinutes: 30, deepseekMaxRequests: 12 },
  backendReady: true, dataDirectory: 'C:\\data', deepseekKeyConfigured: false,
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.addInitScript(({ snapshot }) => {
    window.__snapshot = snapshot; window.__calls = []; window.__listeners = [];
    const publish = () => window.__listeners.forEach(listener => listener({ type: 'snapshot', snapshot: structuredClone(window.__snapshot) }));
    window.airoom = {
      pathForFile: () => 'C:\\files\\需求.md',
      invoke: async (method, params) => {
        window.__calls.push({ method, params });
        const s = window.__snapshot;
        if (method === 'snapshot') return structuredClone(s);
        // Finished sessions keep their record out of snapshots; the window asks for it when opened.
        if (method === 'session.events') return params.sessionId === 'b' ? [{ id: 'history-only', runId: 'r2', sessionId: 'b', provider: 'codex', at: new Date().toISOString(), kind: 'delta', text: '这段只在历史记录里。', fidelity: 'native' }] : [];
        if (method === 'session.update') { const item = s.sessions.find(x => x.id === params.sessionId); Object.assign(item, params.title ? { title: params.title } : {}, 'effort' in params ? { effort: params.effort ?? undefined } : {}, 'pinned' in params ? { pinned: params.pinned } : {}, 'archived' in params ? { archived: params.archived } : {}); publish(); return structuredClone(item); }
        if (method === 'session.delete') { s.sessions = s.sessions.filter(x => x.id !== params.sessionId); s.runs = s.runs.filter(x => x.sessionId !== params.sessionId); publish(); return { deleted: true }; }
        if (method === 'project.update') { s.projects[0].name = params.name; publish(); return s.projects[0]; }
        if (method === 'workspace.apply') return { applied: [{ path: 'README.en.md', kind: 'added' }, { path: 'src/a.ts', kind: 'modified' }], conflicts: [], unchanged: false };
        if (method === 'file.save') return { saved: true, path: 'C:\\Users\\me\\Documents\\x.md' };
        if (method === 'artifact.list') return [];
        if (method === 'project.diff') return { text: '相对任务开始时：\n新增 README.en.md' };
        return {};
      },
      onEvent: listener => { window.__listeners.push(listener); return () => {}; },
    };
  }, { snapshot });
  await installPersonalFixture(page);
  page.on('dialog',d=>d.accept());
  await page.goto(url);
  await page.getByText('今天想请谁来帮忙？').waitFor();
  const calls = () => page.evaluate(() => window.__calls);

  await page.getByRole('button',{name:'Gptia 的工位',exact:true}).click();
  await page.getByText('这段只在历史记录里。').waitFor();
  assert.ok((await calls()).some(c=>c.method==='session.events'&&c.params.sessionId==='b'));
  assert.equal(await page.getByText('旧会话与全部历史',{exact:true}).count(),0);
  await page.getByRole('button',{name:'话题操作'}).click();await page.getByRole('menuitem',{name:'话题管理'}).click();
  const history=page.getByRole('complementary',{name:'话题管理'});
  await history.getByRole('button',{name:'改名',exact:true}).click();
  const rename=history.getByRole('textbox',{name:'话题名称'});await rename.fill('登录流程梳理');await rename.press('Enter');
  await page.waitForFunction(()=>window.__calls.some(c=>c.method==='room.rename'&&c.params.title==='登录流程梳理'));
  await history.getByRole('button',{name:'关闭话题管理'}).click();
  await page.keyboard.press('Control+k');await page.getByRole('dialog',{name:'快速切换会话'}).waitFor();
  await page.getByRole('textbox',{name:'搜索会话'}).fill('README');await page.keyboard.press('Enter');
  await page.getByRole('heading',{name:'Claudia 的工位',exact:true}).waitFor();
  assert.equal((await calls()).filter(c=>c.method==='room.send'||c.method==='session.send').length,0,'opening history never resends it');
  await page.getByRole('button',{name:'选择话题模型和思考程度'}).click();const popover=page.getByRole('dialog',{name:'这个会话的模型'});
  await popover.getByRole('combobox').last().selectOption('high');await page.screenshot({animations:'disabled',path:`${output}interaction-model.png`});await popover.getByRole('button',{name:'保存'}).click();
  await page.waitForFunction(()=>window.__calls.some(c=>c.method==='session.update'&&c.params.effort==='high'&&c.params.model===null));
  await page.getByRole('button',{name:'话题工作副本操作'}).click();await page.getByRole('menuitem',{name:'应用到原文件夹'}).click();
  const applied=page.getByRole('dialog',{name:'改动已应用到原文件夹'});await applied.getByText('已应用 2 项改动。').waitFor();await page.screenshot({animations:'disabled',path:`${output}interaction-apply.png`});await applied.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'话题操作'}).click();await page.getByRole('menuitem',{name:'导出当前话题'}).click();await page.waitForFunction(()=>window.__calls.some(c=>c.method==='file.save'&&c.params.content.includes('把 README 翻译成英文')));
  await page.getByRole('button',{name:'开新话题',exact:true}).click();const topic=page.getByRole('dialog',{name:'开新话题'});await topic.getByRole('textbox',{name:'新话题名称'}).fill('新资料');
  assert.equal(await topic.getByRole('checkbox').isChecked(),false);await topic.getByRole('button',{name:'开始新话题'}).click();
  await page.getByRole('button',{name:'话题操作'}).click();await page.getByRole('menuitem',{name:'话题管理'}).click();await history.locator('.topic-item').filter({hasText:'Claude 对话'}).getByRole('button',{name:'删除',exact:true}).click();
  await page.getByRole('dialog',{name:'删除话题',exact:true}).getByRole('button',{name:'确认删除',exact:true}).click();
  await page.waitForFunction(()=>window.__calls.some(c=>c.method==='room.delete'&&c.params.threadId==='desk-topic-a'));
  assert.ok((await calls()).some(c=>c.method==='session.delete'&&c.params.sessionId==='a'&&c.params.discardWorkspace===false));
  await history.getByRole('button',{name:'关闭话题管理'}).click();
  await page.getByRole('button',{name:'交互项目',exact:true}).dblclick();await page.getByRole('textbox',{name:'项目名称'}).fill('新项目名');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.__calls.some(c=>c.method==='project.update'&&c.params.name==='新项目名'));
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Interaction smoke passed: personal history on demand, topic rename, Ctrl+K without resend, model/effort, copy apply result, export, archive deletion confirmation, project rename.');
} finally { await browser.close(); await server.close(); }
