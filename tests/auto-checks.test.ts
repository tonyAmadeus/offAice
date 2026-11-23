import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkCommands, runCheck, autoCheckSummary } from '../src/backend/auto-checks';
import { unverifiedCause } from '../src/shared/project-flow-review';

test('one-line runner commands in backticks are picked up; prose and risky commands are not', () => {
  const found = checkCommands([
    "執行 `python -B tools/probe_cboe_gex.py '探測/QQQ.json' --expiry 2026-11-23 --atm-pct 2.0 --json` 能正常跑完，輸出和報告一致",
    '報告寫清楚 `建議` 欄位',
    '執行 `node a.js; rm -rf x` 成功',
    '執行 `python a.py` 和 `python b.py`',
  ]);
  assert.deepEqual(found.map(f => f.command), ["python -B tools/probe_cboe_gex.py '探測/QQQ.json' --expiry 2026-11-23 --atm-pct 2.0 --json"]);
});

test('AIROOM runs the command itself and reports exit code and output', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'airoom-check-'));
  try {
    writeFileSync(path.join(dir, 'ok.js'), 'console.log("total 42")');
    writeFileSync(path.join(dir, 'bad.js'), 'console.error("找不到檔案：探測/QQQ.json"); process.exit(2)');
    const ok = await runCheck('node ok.js', dir), bad = await runCheck('node bad.js', dir);
    assert.equal(ok.exitCode, 0); assert.match(ok.output, /total 42/);
    assert.equal(bad.exitCode, 2); assert.match(bad.output, /找不到檔案/);
    const summary = autoCheckSummary([{ criterion: 'a', ...ok }, { criterion: 'b', ...bad }]);
    assert.match(summary, /node ok\.js → 成功（exit 0）/);
    assert.match(summary, /node bad\.js → 失败（exit 2）\n  .*找不到檔案/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unverified criterion says why', () => {
  assert.match(unverifiedCause('執行後：找不到檔案：探測/QQQ.json'), /原因：文件不存在/);
  assert.match(unverifiedCause('sandbox denied the command'), /原因：没有执行权限/);
  assert.match(unverifiedCause(''), /检查者没有说明/);
});
