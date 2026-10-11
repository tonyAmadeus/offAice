import { build } from 'esbuild';
import { build as buildVite } from 'vite';
import { mkdir, copyFile, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import './build-job.mjs';
await mkdir('dist', { recursive: true });
for (const [entry, outfile, format] of [
  ['src/main/main.ts', 'dist/main.mjs', 'esm'],
  ['src/main/preload.ts', 'dist/preload.cjs', 'cjs'],
  ['src/backend/worker.ts', 'dist/worker.mjs', 'esm'],
  ['src/backend/adapters/claude-permission-mcp.ts', 'dist/claude-permission-mcp.cjs', 'cjs'],
]) await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format, target: 'node24', packages: 'external', sourcemap: true });
if(existsSync('src/backend/backup.ts'))await build({entryPoints:['src/backend/backup.ts'],outfile:'dist/backup.mjs',bundle:true,platform:'node',format:'esm',target:'node24',packages:'external',sourcemap:true});
else await Promise.all(['dist/backup.mjs','dist/backup.mjs.map'].map(file=>rm(file,{force:true})));
await copyFile('scripts/windows-job.ps1', 'dist/windows-job.ps1');
await copyFile('scripts/dsh-account-plugin.mjs', 'dist/dsh-account-plugin.mjs');
await copyFile('scripts/verify-runtime-dependencies.ps1', 'dist/verify-runtime-dependencies.ps1');
await copyFile('build/airoom.ico', 'dist/airoom.ico');
await copyFile('build/airoom.png', 'dist/airoom.png');
await cp('build/third-party','dist/third-party',{recursive:true});
await buildVite({ base: './', build: { outDir: 'dist/renderer', emptyOutDir: true } });
