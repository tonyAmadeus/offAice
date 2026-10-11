import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isolatedTestEnvironment, cleanupTestEnvironment } from './test-environment.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { directory, env } = isolatedTestEnvironment(process.env, root);
env.AIROOM_DESKTOP_RUNTIME_PARENT=process.env.AIROOM_DESKTOP_RUNTIME_PARENT??path.join(process.env.LOCALAPPDATA??path.join(process.env.USERPROFILE??root,'AppData','Local'),'Temp');
const unit = readdirSync(new URL('../tests/', import.meta.url)).filter(name => name.endsWith('.test.ts')).sort().map(name => `tests/${name}`);
const ui = readdirSync(new URL('../tests/ui/', import.meta.url)).filter(name => name.endsWith('-smoke.mjs')).sort().map(name => `tests/ui/${name}`);
const stages = [
  ['类型检查', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['进程管理组件', ['scripts/build-job.mjs']],
  ['单元与集成测试', ['--import', './scripts/test-bootstrap.mjs', '--import', 'tsx', '--test', ...unit]],
  ...ui.map(file => [file, ['--import', './scripts/test-bootstrap.mjs', '--import', 'tsx', file]]),
  ['构建桌面程序', ['scripts/build.mjs']],
  ['桌面冒烟（独立未登录账号）', ['--import', 'tsx', 'scripts/desktop-smoke.mjs']],
];
try{for (const [name, args] of stages) {
  console.log(`\n验证：${name}`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${name} 未通过（${signal ?? code}）。后续验证未执行。`)));
  });
}
console.log('\n全部验证通过。测试使用独立未登录账号，没有发送真实模型请求。');
}finally{cleanupTestEnvironment(directory,root);}
