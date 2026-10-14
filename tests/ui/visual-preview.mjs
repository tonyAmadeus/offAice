import '../../scripts/test-bootstrap.mjs';
// Visual preview of the renderer against a rich fixture backend.
// node tests/ui/visual-preview.mjs → screenshots in .test-cache/ui-preview (light and dark).
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from '../../scripts/ui-test-server.mjs';

const output = new URL('../../.test-cache/ui-preview/', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '');
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}`;
const only = process.argv[2];

const minutes = n => new Date(Date.now() - n * 60000).toISOString();
const seconds = n => new Date(Date.now() - n * 1000).toISOString();
const provider = (id, name, auth, model, extra = {}) => ({ id, name, available: true, auth, detail: '测试环境', model, version: id === 'claude' ? '2.1.288 (Claude Code)' : id === 'codex' ? 'codex-cli 0.160.0' : '0.2.0-rc.2', verified: true, runtimeReady: true, capabilities: { steer: id === 'codex', cancel: 'native', streaming: true, write: id !== 'deepseek', history: true }, checkedAt: minutes(3), modelOptions: id === 'codex' ? [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['low', 'medium', 'high'], isDefault: true, description: '日常编码与长任务' }] : [], ...extra });
const settings = { networkMode: 'tun', proxyUrl: 'http://127.0.0.1:7897', paths: {}, models: {}, efforts: { codex: 'medium' }, permissions: { codex: { commands: 'auto', fileScope: 'any', network: true }, claude: { commands: 'auto', fileScope: 'any', network: true }, dsh: { commands: 'auto', fileScope: 'workspace', network: true } }, deepseekEnabled: true, deepseekBaseUrl: 'https://api.deepseek.com', dshProfile: 'airoom', maxParallel: 2, stopTimeoutMs: 10000, defaultWriteMode: true, defaultAutoApprove: true, maxRunMinutes: 30, deepseekMaxRequests: 12 };
const answer = '五项都已完成，`node check.mjs` 运行通过。\n\n## 结果\n\n1. **口令**：README.md 里写的口令是 **青石**。\n2. **搜索 add**：共找到 3 处\n   - `src/math.js:1`\n   - `check.mjs:1`\n3. 已新增并导出 `multiply(a, b)`。\n\n| 文件 | 改动 |\n|---|---|\n| src/math.js | 新增 multiply |\n| check.mjs | 增加检查 |\n\n```js\nexport function multiply(a, b) {\n  return a * b;\n}\n```\n\n> 改动还没有提交到 git。';
const snapshot = {
  projects: [{ id: 'p', name: '自动工作验收', directory: 'C:\\Users\\admin\\proj', createdAt: minutes(90), collaborationPaused: false }, { id: 'p2', name: 'AIROOM 界面', directory: 'C:\\x', createdAt: minutes(80), collaborationPaused: false }],
  sessions: [
    { id: 's1', projectId: 'p', provider: 'claude', title: 'Claude 对话', createdAt: minutes(60), updatedAt: minutes(2), revision: 1, writeMode: true, workspace: 'C:\\Users\\admin\\.airoom\\data\\workspaces\\abc-ebf9', workspaceKind: 'worktree', autoApprove: true },
    { id: 's2', projectId: 'p', provider: 'codex', title: 'Codex 对话', createdAt: minutes(50), updatedAt: minutes(1), revision: 1, writeMode: true, workspace: 'C:\\w2', workspaceKind: 'worktree' },
    { id: 's3', projectId: 'p', provider: 'dsh', title: 'DeepSeek · DSH 对话', createdAt: minutes(40), updatedAt: minutes(8), revision: 1, writeMode: true, workspace: 'C:\\w3', workspaceKind: 'worktree' },
    { id: 's4', projectId: 'p', provider: 'codex', title: 'Codex 对话', createdAt: minutes(30), updatedAt: minutes(0), revision: 1, writeMode: false },
  ],
  runs: [
    { id: 'r1', sessionId: 's1', projectId: 'p', provider: 'claude', revision: 1, status: 'ended', inputPreview: '请完成：1) 读取 README.md 告诉我口令；2) 搜索所有 add；3) 新增 multiply 并运行检查。', inputLength: 59, createdAt: minutes(5), updatedAt: minutes(4), completedAt: minutes(4), bootId: 'b', delivery: 'confirmed' },
    { id: 'r2', sessionId: 's1', projectId: 'p', provider: 'claude', revision: 1, status: 'running', inputPreview: '再帮我给 multiply 写单元测试，并运行。', inputLength: 24, createdAt: seconds(40), updatedAt: seconds(5), bootId: 'b', delivery: 'confirmed' },
    { id: 'r3', sessionId: 's2', projectId: 'p', provider: 'codex', revision: 1, status: 'ended', inputPreview: '在继续之前，先问我要不要加参数校验。', inputLength: 18, createdAt: minutes(3), updatedAt: minutes(2), completedAt: minutes(2), bootId: 'b', delivery: 'confirmed' },
    { id: 'r4', sessionId: 's3', projectId: 'p', provider: 'dsh', revision: 1, status: 'waiting_user', inputPreview: '清理临时文件', inputLength: 6, createdAt: minutes(9), updatedAt: minutes(8), bootId: 'b', delivery: 'confirmed' },
  ],
  events: [
    { id: 'e0', runId: 'r1', sessionId: 's1', provider: 'claude', at: minutes(5), kind: 'message', text: 'x', data: { role: 'user' }, fidelity: 'derived' },
    { id: 'e1', runId: 'r1', sessionId: 's1', provider: 'claude', at: minutes(5), kind: 'reasoning', text: '**Planning the edits**\n\nI should read README first, then search for add usages before editing math.js.', fidelity: 'native' },
    { id: 'e2', runId: 'r1', sessionId: 's1', provider: 'claude', at: minutes(4.8), kind: 'tool', text: '调用：Read', fidelity: 'native' },
    { id: 'e3', runId: 'r1', sessionId: 's1', provider: 'claude', at: minutes(4.6), kind: 'tool', text: '调用：Bash', fidelity: 'native' },
    { id: 'e4', runId: 'r1', sessionId: 's1', provider: 'claude', at: minutes(4.2), kind: 'delta', text: answer, fidelity: 'native' },
    { id: 'e5', runId: 'r2', sessionId: 's1', provider: 'claude', at: seconds(40), kind: 'message', text: 'x', data: { role: 'user' }, fidelity: 'derived' },
    { id: 'e6', runId: 'r2', sessionId: 's1', provider: 'claude', at: seconds(20), kind: 'message', text: '测试文件放在 tests/ 目录下', data: { role: 'user' }, fidelity: 'derived' },
    { id: 'e7', runId: 'r2', sessionId: 's1', provider: 'claude', at: seconds(30), kind: 'reasoning', text: '先看看项目里有没有现成的测试框架……', fidelity: 'native' },
    { id: 'e8', runId: 'r2', sessionId: 's1', provider: 'claude', at: seconds(8), kind: 'tool', text: '开始："C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'node --test tests\'', fidelity: 'native' },
    { id: 'e9', runId: 'r3', sessionId: 's2', provider: 'codex', at: minutes(2.5), kind: 'message', text: '要给 multiply 加参数类型校验吗？', data: { type: 'agentMessage', questions: [{ title: '要给 multiply 加参数类型校验吗？', options: ['要', '不要'] }] }, fidelity: 'native' },
    { id: 'e10', runId: 'r3', sessionId: 's2', provider: 'codex', at: minutes(2.4), kind: 'delta', text: '等待你的回答，本轮不修改任何文件。', fidelity: 'native' },
  ],
  approvals: [
    { id: 'a1', runId: 'r4', sessionId: 's3', provider: 'dsh', type: 'approval', title: 'pwsh 请求本次操作许可', detail: '需要删除工作区里的临时目录 tmp。\n"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'Remove-Item .\\tmp -Recurse\'\nC:\\Users\\admin\\.airoom\\data\\workspaces\\w3', options: [{ id: 'allow', label: '仅允许这次' }, { id: 'reject', label: '拒绝' }], allowChoice: 'allow', denyChoice: 'reject', category: 'pwsh', categoryLabel: '执行命令', state: 'pending', createdAt: minutes(8) },
  ],
  providers: [provider('codex', 'Codex', 'subscription', 'gpt-6-astra'), provider('claude', 'Claude', 'subscription', 'claude-opus-5-5'), provider('dsh', 'DeepSeek · DSH', 'account', 'deepseek-flash'), { ...provider('deepseek', 'DeepSeek API', 'none', 'deepseek-chat'), available: false, detail: '请在设置中配置 DeepSeek API 密钥' }],
  collaborations: [], settings, backendReady: true, dataDirectory: 'C:\\Users\\admin\\.airoom\\data', deepseekKeyConfigured: false,
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [];
async function page(theme, width = 1440, height = 900) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme });
  const p = await context.newPage();
  p.on('pageerror', error => errors.push(error.message));
  p.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await p.addInitScript(({ snapshot }) => {
    window.__snapshot = snapshot; window.__listeners = [];
    window.airoom = {
      invoke: async (method, params) => {
        if (method === 'snapshot') return structuredClone(window.__snapshot);
        if (method === 'member.versions') return { member: params.provider, packageName: 'x', current: '0.160.0', baselineVersions: ['0.160.0'], connection: {state:'connected',detail:'fixture'}, source: 'bundled', selectedPath: null, installed: ['0.159.0'], latest: '0.161.0' };
        if (method === 'artifact.list') return [{ name: 'math.js', relativePath: 'src/math.js', path: '', size: 120, modifiedAt: '', directory: false }, { name: 'check.mjs', relativePath: 'check.mjs', path: '', size: 220, modifiedAt: '', directory: false }, { name: 'README.md', relativePath: 'README.md', path: '', size: 40, modifiedAt: '', directory: false }, { name: 'baseline.json', relativePath: '.airoom/baseline.json', path: '', size: 40, modifiedAt: '', directory: false }];
        if (method === 'project.diff') return { text: '相对任务开始时：\n修改 src/math.js\n新增 check.mjs\n\ndiff --git a/src/math.js b/src/math.js\n@@ -1,3 +1,7 @@\n export function add(a, b) {\n+export function multiply(a, b) {\n-  old\n' };
        return {};
      },
      onEvent: listener => { window.__listeners.push(listener); return () => {}; },
    };
  }, { snapshot });
  await p.goto(url);
  return p;
}
const shot = async (p, name) => { await p.waitForTimeout(700); await p.screenshot({ path: `${output}${name}.png` }); };

try {
  for (const theme of ['light', 'dark']) {
    if (only && only !== theme) continue;
    const p = await page(theme);
    await p.getByText('今天想请谁来帮忙？').waitFor();
    await shot(p, `${theme}-home`);
    await p.locator('.session-item').first().click();
    await p.getByRole('textbox', { name: '输入任务或补充要求' }).waitFor();
    await shot(p, `${theme}-claude-running`);
    await p.locator('.timeline').evaluate(node => { node.scrollTop = 0; });
    await shot(p, `${theme}-claude-top`);
    await p.locator('.session-item').nth(1).click();
    await shot(p, `${theme}-codex-question`);
    await p.locator('.session-item').nth(2).click();
    await shot(p, `${theme}-dsh-approval`);
    await p.getByRole('tab', { name: '产出' }).click();
    await shot(p, `${theme}-files`);
    await p.locator('.session-item').nth(3).click();
    await shot(p, `${theme}-empty-session`);
    await p.getByRole('button', { name: '设置与连接' }).click();
    await shot(p, `${theme}-settings`);
    await p.getByRole('button', { name: '权限', exact: true }).click();
    await shot(p, `${theme}-permissions`);
    await p.getByRole('button', { name: '关闭对话框' }).click();
    await p.getByRole('button', { name: '新建会话' }).first().click();
    await shot(p, `${theme}-new-session`);
    await p.context().close();
  }
  if (!only || only === 'small') {
    const p = await page('light', 1100, 720);
    await shot(p, 'small-home');
    await p.locator('.session-item').first().click();
    await shot(p, 'small-claude');
    await p.context().close();
  }
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
} finally {
  await browser.close();
  await server.close();
}
