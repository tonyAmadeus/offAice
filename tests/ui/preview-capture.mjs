// Full-resolution screenshots of named scenes from a running preview-server.mjs.
//   node tests/ui/preview-capture.mjs [scene ...] [--theme dark|light] [--size 1400x880] [--out dir]
// Each scene starts from a fresh page load; steps click elements by accessible name or selector.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const argv = process.argv.slice(2), opt = (key, fallback) => { const i = argv.indexOf(key); return i >= 0 ? argv.splice(i, 2)[1] : fallback; };
const theme = opt('--theme', 'dark'), [width, height] = opt('--size', '1400x880').split('x').map(Number);
const out = path.resolve(opt('--out', '.test-cache/ui-real')), base = opt('--url', 'http://127.0.0.1:5390/');
await mkdir(out, { recursive: true });

const click = (name, exact = true) => async p => { await p.getByRole('button', { name, exact }).first().click(); };
const css = selector => async p => { await p.locator(selector).first().click(); };
const scroll = (selector, top) => async p => { await p.locator(selector).first().evaluate((node, y) => { node.scrollTop = y; }, top); };
const SCENES = {
  home: [],
  'home-scrolled': [scroll('main', 700)],
  desk: [click('Claudia 的工位')],
  'desk-gptia': [click('Gptia 的工位')],
  member: [css('.roster-row')],
  lounge: [css('.room-entry')],
  roundtable: [async p => { await p.locator('.room-entry').nth(1).click(); }],
  attention: [css('.attention-entry')],
  project: [css('.list-row-main')],
  'project-2': [async p => { await p.locator('.list-row-main').nth(3).click(); }],
  report: [async p => { await p.locator('.list-row-main').nth(3).click(); }, click('Claudia 的项目汇报')],
  settings: [click('设置与连接')],
  automation: [click('自动功能与定时任务')],
  usage: [click('用量与额度')],
  cards: [click('管理人物卡')],
  connections: [click('设置与连接'), click('连接与版本')],
  'connections-providers': [click('设置与连接'), click('连接与版本'), scroll('.settings-content', 900)],
  permissions: [click('设置与连接'), click('权限')],
  profile: [click('设置与连接'), click('个人资料')],
  workbench: [click('设置与连接'), click('工作台')],
  network: [click('设置与连接'), click('网络')],
  together: [click('请大家一起来', false)],
  switcher: [async p => { await p.keyboard.press('Control+k'); }],
  session: [async p => { await p.keyboard.press('Control+k'); await p.getByRole('option').first().click(); }],
  'add-project': [async p => { await p.getByRole('button', { name: '添加项目' }).first().click(); }],
};
const names = argv.length ? argv : Object.keys(SCENES);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [];
try {
  for (const name of names) {
    const steps = SCENES[name]; if (!steps) { console.log('unknown scene', name); continue; }
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
    await page.goto(base); await page.locator('.roster-row').first().waitFor();
    try { for (const step of steps) { await step(page); await page.waitForTimeout(400); } }
    catch (e) { errors.push(`${name}: step failed ${e.message.split('\n')[0]}`); }
    await page.waitForTimeout(900);
    const file = path.join(out, `${theme}-${name}.png`); await page.screenshot({ path: file });
    console.log(file); await context.close();
  }
} finally { await browser.close(); }
if (errors.length) console.log('ERRORS:\n' + errors.join('\n'));
