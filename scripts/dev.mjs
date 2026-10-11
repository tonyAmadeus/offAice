import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
if (result.status) process.exit(result.status);
await import('./launch.mjs');
