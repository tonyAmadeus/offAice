import '../../scripts/test-bootstrap.mjs';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { createServer } from '../../scripts/ui-test-server.mjs';
const server = await createServer({ configFile:false, root:process.cwd(), logLevel:'silent', server:{host:'127.0.0.1', port:0} }); await server.listen();
const browser = await chromium.launch({channel:'msedge', headless:true}), page = await browser.newPage();
try {
  await page.clock.install();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/run-progress.html`);
  const one = page.getByRole('region', {name:'独立准备甲运行进度'}), two = page.getByRole('region', {name:'独立准备乙运行进度'});
  await expect(one).toContainText('已用 3 分 1 秒'); await expect(one.getByRole('button', {name:'催一下'})).toBeEnabled(); await expect(two.getByRole('button',{name:'催一下'})).toBeDisabled();
  assert.deepEqual(await page.evaluate(()=>window.calls), [], 'elapsed time never stops work automatically');
  await one.getByRole('button',{name:'再等等'}).click(); await expect(one.getByRole('button',{name:'停止这一份'})).toHaveCount(0); await expect(two.getByRole('button',{name:'停止这一份'})).toBeVisible();
  await page.clock.fastForward(180000); await expect(one.getByRole('button',{name:'催一下'})).toBeVisible();
  await one.getByRole('button',{name:'催一下'}).click(); await expect(one).toContainText('已补充收尾要求'); await expect(one.getByRole('button',{name:'催一下'})).toBeDisabled();
  page.on('dialog', dialog=>dialog.accept()); await two.getByRole('button',{name:'停止这一份'}).click();
  assert.deepEqual(await page.evaluate(()=>window.calls), [{method:'run.nudge',params:{runId:'one'}},{method:'run.stop',params:{runId:'two'}}]);
  console.log('Stage timing UI passed: elapsed display, reminder only, wait postpones only selected item, supported nudge once, unsupported disabled, stop targets only selected run.');
} finally { await browser.close(); await server.close(); }
