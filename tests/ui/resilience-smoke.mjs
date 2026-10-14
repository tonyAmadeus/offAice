import '../../scripts/test-bootstrap.mjs';
// A broken part of the interface must not blank the window: malformed fixture data crashes single
// areas on purpose, and the rest stays usable. node tests/ui/resilience-smoke.mjs
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
const provider = id => ({ id, name: id, available: true, auth: id === 'dsh' ? 'account' : 'subscription', detail: 'fixture', capabilities: { steer: false, cancel: 'native', streaming: true, write: true, history: true }, checkedAt: at(1) });
const permissions = { commands: 'auto', fileScope: 'any', network: true };
const snapshot = {
  projects: [{ id: 'p', name: '韧性项目', directory: 'C:\\proj', createdAt: at(60), collaborationPaused: false }],
  sessions: [{ id: 'a', projectId: 'p', provider: 'claude', title: 'Claude 对话', createdAt: at(50), updatedAt: at(5), revision: 1, writeMode: true }],
  runs: [
    { id: 'r1', sessionId: 'a', projectId: 'p', provider: 'claude', revision: 1, status: 'ended', inputPreview: '第一轮任务', inputLength: 5, createdAt: at(10), updatedAt: at(9), completedAt: at(9), bootId: 'b', delivery: 'confirmed' },
    { id: 'r2', sessionId: 'a', projectId: 'p', provider: 'claude', revision: 1, status: 'waiting_user', inputPreview: '第二轮任务', inputLength: 5, createdAt: at(5), updatedAt: at(4), bootId: 'b', delivery: 'confirmed' },
  ],
  events: [{ id: 'e1', runId: 'r1', sessionId: 'a', provider: 'claude', at: at(9), kind: 'delta', text: '第一轮正常完成。', fidelity: 'native' }],
  // Options must be a list; a string makes the approval card throw while rendering.
  approvals: [{ id: 'ap', runId: 'r2', sessionId: 'a', provider: 'claude', type: 'approval', title: '运行命令', detail: 'npm test', options: 'broken', state: 'pending', createdAt: at(4) }],
  providers: ['claude', 'codex', 'dsh'].map(provider), collaborations: [],
  settings: { networkMode: 'tun', proxyUrl: '', paths: {}, models: {}, efforts: {}, permissions: { codex: permissions, claude: permissions, dsh: permissions }, deepseekEnabled: false, deepseekBaseUrl: 'https://api.deepseek.com', dshProfile: 'airoom', maxParallel: 2, stopTimeoutMs: 10000, defaultWriteMode: true, defaultAutoApprove: true, maxRunMinutes: 30, deepseekMaxRequests: 12 },
  backendReady: true, dataDirectory: 'C:\\data', deepseekKeyConfigured: false,
  // A connection whose arguments are not a list breaks the settings page.
  executors: [{ id: 'acp-0a1b2c3d4e5f', name: '坏掉的连接', command: 'agent', args: 'not-a-list', env: {}, permissions: { commands: 'ask', fileScope: 'workspace', network: true }, createdAt: at(30) }],
  members: [
    { id: 'claude', executor: 'claude', name: 'Claudia', color: '#d9692f', builtIn: true },
    { id: 'codex', executor: 'codex', name: 'Gptia', color: '#7b6fd6', builtIn: true },
    { id: 'dsh', executor: 'dsh', name: 'DS', color: '#3c66d9', builtIn: true },
  ],
  profile: { name: '你' }, room: { messages: [], state: { active: false, mode: 'chat' } },
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
const uncaught = [];
page.on('pageerror', error => uncaught.push(error.message));
try {
  await page.addInitScript(({ snapshot }) => {
    window.__calls = [];window.__snapshot=snapshot;window.__listeners=[];
    window.airoom = { invoke: async (method, params) => { window.__calls.push({ method, params }); return method === 'snapshot' ? structuredClone(snapshot) : {}; }, onEvent: fn => {window.__listeners.push(fn);return()=>{};} };
  }, { snapshot });
  await installPersonalFixture(page);
  await page.goto(url);
  await page.getByRole('button',{name:'Claudia 的工位',exact:true}).click();
  await page.getByText('第一轮正常完成。').waitFor();
  await page.getByText(/话题审批没能显示/).waitFor();
  assert.ok(await page.getByRole('textbox',{name:'在工位里说话'}).isVisible(),'a malformed approval does not remove chat/composer');
  await page.screenshot({path:`${output}resilience-desk.png`});
  await page.evaluate(()=>{window.__snapshot.approvals[0].options=[{id:'once',label:'仅允许这次'},{id:'deny',label:'拒绝'}];window.__listeners.forEach(fn=>fn({type:'snapshot',snapshot:structuredClone(window.__snapshot)}));});
  await page.getByRole('button',{name:'重试',exact:true}).click();
  await page.getByRole('button',{name:'仅允许这次'}).waitFor();
  // A failing dialog can still be closed, and the window keeps working.
  await page.getByRole('button', { name: '设置与连接' }).click();
  await page.getByText('设置出了点问题').waitFor();
  await page.waitForTimeout(300); await page.screenshot({ path: `${output}resilience-settings.png` });
  await page.getByRole('button', { name: '关闭' }).click();
  assert.equal(await page.getByText('设置出了点问题').count(), 0);
  assert.ok(await page.getByRole('button', { name: '设置与连接' }).isVisible(), 'the sidebar survived');
  const reports = await page.evaluate(() => window.__calls.filter(call => call.method === 'renderer.error').map(call => call.params.area));
  for (const area of ['话题审批', '设置']) assert.ok(reports.includes(area), `${area} failure was reported: ${reports}`);
  assert.equal(uncaught.length, 0, uncaught.join('\n'));
  console.log('Resilience smoke passed: a malformed personal approval and settings dialog fail alone, recover or close, are reported, and preserve healthy chat/composer/sidebar.');
} finally { await browser.close(); await server.close(); }
