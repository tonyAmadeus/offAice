import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendDecision } from '../src/shared/decision-recommendation';
import { assessReview } from '../src/shared/project-flow-review';
import { failureMessage } from '../src/backend/adapter-failure';

const review = ['重新检查', '换负责人检查', '我来判断'];
const card = (reason: string, options = review, kind: any = 'unresolved-review') => recommendDecision({ kind, options, reason, eligibleMemberIds: ['claude', 'dsh'] });

test('each unclear check gets the button a non-programmer should press', () => {
  assert.deepEqual(card('未能核实：\n• 执行 x\n  原因：文件不存在 — 找不到檔案'), { choice: '我来判断', why: '缺的是资料文件，换人检查也一样看不到', opinion: '缺少需要的文件，这一项留到下一轮补上后再检查。' });
  assert.deepEqual(card('原因：没有执行权限 — denied'), { choice: '换负责人检查', why: '换一位能执行的成员来检查', memberId: 'claude' });
  assert.equal(card('原因：额度用完 — rate limit')?.choice, '换负责人检查');
  assert.equal(card('AIROOM 已自动执行：\n• node a.js → 失败（exit 1）\n原因：指令执行失败')?.choice, '我来判断');
  assert.equal(card('原因：检查者没有说明（可能没有实际执行）')?.choice, '重新检查');
  assert.deepEqual(card('其他原因'), { choice: '换负责人检查', why: '换一位成员再确认一次', memberId: 'claude' });
  assert.equal(card('原因：文件不存在', ['重新复核', '换人复核', '退回补充依据']), undefined, 'never names a button the card lacks');
  assert.deepEqual(card('等待额度', ['继续等待', '换人接手'], 'quota-wait'), { choice: '换人接手', why: '额度恢复可能要很久，换人比较快', memberId: 'claude' });
  assert.equal(card('整合已自动修正两次', ['重新安排', '暂停'], 'replan')?.choice, '重新安排');
  assert.equal(card('x', ['暂停'], 'replan'), undefined);
});

test('a command AIROOM ran itself is not reported as missing a completion record', () => {
  const command = "python -B tools/probe.py '探測/QQQ.json' --json";
  const payload: any = { verdict: 'pass', verificationComplete: true, findings: [], assessments: [],
    criteriaResults: [{ criterion: 'c', verified: true, evidence: 'AIROOM 自动执行成功' }],
    evidence: [{ kind: 'command', source: 'reported', command, description: 'run' }] };
  const missing = (reasons: string[]) => reasons.some(r => r.includes('命令缺少实际完成记录'));
  assert.equal(missing(assessReview(payload, ['c']).reasons), true, 'without the auto-run list the old warning stays');
  assert.equal(missing(assessReview(payload, ['c'], [], [], [], [], [command.replace(' --json', '  --json')]).reasons), false);
});

test('provider errors become plain instructions', () => {
  assert.equal(failureMessage('The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4.1-flash. (request_id: x)'),
    '模型「deepseek-v4.1-flash」不被 DeepSeek 接受。请到 设置 → 连接与版本，把模型改成「deepseek-flash」，然后再试。');
  assert.match(failureMessage('Invalid params: session cwd does not match: C:\\x'), /自动开新对话/);
  assert.equal(failureMessage("ENOENT: no such file or directory, open '探測/QQQ.json'"), '成员找不到需要的文件：探測/QQQ.json。请确认文件已经放进项目文件夹。');
  assert.equal(failureMessage('Something odd happened\nstack line'), '成员这次没能完成。原因：Something odd happened');
  assert.match(failureMessage('429 rate limit'), /额度或请求频率/);
  assert.match(failureMessage('401 unauthorized'), /登录已失效/);
});
