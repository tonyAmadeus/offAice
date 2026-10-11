import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('Daily runtime deployment requires Windows.');
// An agent host may inherit PowerShell 7 module paths. Prefer that installed
// runtime instead of launching Windows PowerShell against incompatible modules.
const modern = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', windowsHide: true });
const executable = modern.status === 0 ? 'pwsh' : path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
for(const stage of ['build.mjs','prepare-deployment.mjs']){const result=spawnSync(process.execPath,[fileURLToPath(new URL('./'+stage,import.meta.url))],{cwd:path.resolve(fileURLToPath(new URL('..',import.meta.url))),stdio:'inherit',windowsHide:true});if(result.status!==0)throw new Error('Direct deployment preparation failed: '+stage);}
const script = fileURLToPath(new URL('./deploy-runtime.ps1', import.meta.url));
const child = spawn(executable, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
