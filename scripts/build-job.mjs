import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

if (process.platform === 'win32') {
  await mkdir('dist', { recursive: true });
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(compiler, ['/nologo', '/target:library', '/optimize+', `/out:${path.resolve('dist/windows-job.dll')}`, path.resolve('scripts/windows-job.cs')], { stdio: 'inherit', windowsHide: true });
}
