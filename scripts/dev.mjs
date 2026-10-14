import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit', windowsHide: true });
if (result.error) { console.error(result.error.message); process.exit(1); }
if (result.status !== 0) process.exit(result.status ?? 1);
await import('./launch.mjs');
