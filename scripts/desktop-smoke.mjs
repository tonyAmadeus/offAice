import { spawn, execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, cp, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isolatedTestEnvironment, cleanupTestEnvironment } from './test-environment.mjs';
import { assertNormalIntegrity } from '../src/main/integrity.ts';
import { copyProductionDependencies } from './runtime-dependencies.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const testFile=process.argv[2]??'tests/electron-smoke.mjs';
if(!['tests/electron-smoke.mjs','tests/electron-restart-smoke.mjs'].includes(testFile))throw new Error('Unknown desktop test.');
const parent=path.resolve(process.env.AIROOM_DESKTOP_RUNTIME_PARENT??path.join(process.env.LOCALAPPDATA??path.join(process.env.USERPROFILE??root,'AppData','Local'),'Temp'));
const {directory,env}=isolatedTestEnvironment(process.env,root);
// npm run prepends development CLI wrappers. They are absent when a user opens the distribution.
for(const pathKey of Object.keys(env).filter(key=>key.toLowerCase()==='path'))env[pathKey]=env[pathKey].split(path.delimiter).filter(entry=>!/(?:^|[/\\])node_modules[/\\]\.bin[/\\]?$/i.test(entry.replace(/^"|"$/g,''))).join(path.delimiter);
let runtime;
try{
  if(process.platform==='win32'&&!env.AIROOM_ELECTRON_EXE){
    assertNormalIntegrity();
    await mkdir(parent,{recursive:true});runtime=await mkdtemp(path.join(parent,'AIROOM-verify-electron-'));
    // Project executables may carry a low-integrity label. Copy data and file
    // attributes only; the disposable runtime inherits its parent's permissions.
    try{await promisify(execFile)('robocopy.exe',[path.join(root,'node_modules','electron','dist'),runtime,'/E','/COPY:DAT','/DCOPY:DAT','/XJ','/R:1','/W:1','/NFL','/NDL','/NJH','/NJS','/NP'],{windowsHide:true,timeout:120000,maxBuffer:1024*1024});}
    catch(error){if(typeof error.code!=='number'||error.code>=8)throw new Error(`桌面测试的临时运行时准备失败：${error.message}`);}
    env.AIROOM_ELECTRON_EXE=path.join(runtime,'electron.exe');env.AIROOM_SMOKE_DEV='1';
    const appRoot=path.join(runtime,'resources','app');await mkdir(appRoot,{recursive:true});
    console.log('Disposable desktop app:',appRoot);
    await cp(path.join(root,'dist'),path.join(appRoot,'dist'),{recursive:true,filter:file=>!file.endsWith('.map')});
    await copyFile(path.join(root,'package.json'),path.join(appRoot,'package.json'));
    console.log('Disposable distribution dependencies:',await copyProductionDependencies(appRoot));
    env.AIROOM_SMOKE_APP_ROOT=appRoot;
  }
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--import','tsx',testFile],{cwd:root,env,windowsHide:true,stdio:'inherit'});
    child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(new Error(`桌面测试未通过（${signal??code}）。`)));
  });
}finally{
  cleanupTestEnvironment(directory,root);
  if(runtime){const target=path.resolve(runtime);if(path.dirname(target)!==parent||!path.basename(target).startsWith('AIROOM-verify-electron-'))throw new Error('测试运行时清理路径无法核对。');await rm(target,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
}
