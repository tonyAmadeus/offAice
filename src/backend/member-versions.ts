import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rm, rename, writeFile, lstat, realpath, readdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { ALL_EXECUTOR_CATALOG, catalogEntry, type CatalogId } from '../shared/executor-catalog';
import type { MemberInstallation } from '../shared/member-versions';
import type { ChildProcess } from 'node:child_process';
import { spawnOwned, stopOwned } from './process-supervisor';
import { collectCommand } from './adapters/common';
import { npmLaunch } from './node-runtime';
import { installZcode, completeZcodeEntry, latestZcodeVersion } from './zcode-install';
import {installQoder,completeQoderEntry,latestQoderVersion} from './qoder-install';
import {installCursor,completeCursorEntry,latestCursorVersion,isCursorVersion} from './cursor-install';

export const MEMBER_PACKAGES = Object.fromEntries(ALL_EXECUTOR_CATALOG.map(item=>[item.id,item.packageName])) as Record<CatalogId,string>;
/** Diagnostic baselines only; real checks and completed native tasks determine the displayed state. */
export const VERIFIED_VERSIONS = Object.fromEntries(ALL_EXECUTOR_CATALOG.map(item=>[item.id,item.verifiedVersions])) as Record<CatalogId,string[]>;
export interface InstalledVersion { version: string; entry: string }
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MARKER = '.airoom-install.json';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function isVersion(value: unknown): value is string { return typeof value === 'string' && VERSION_PATTERN.test(value); }
export function isCatalogVersion(member:CatalogId,value:unknown):value is string{return member==='cursor'?isCursorVersion(value):isVersion(value);}
export function extractVersion(value: string | undefined): string | undefined { return value?.match(/(?<![\w.])\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?![\w.])/u)?.[0]; }
export function isVerified(member: CatalogId, version: string | undefined): boolean { const exact = extractVersion(version); return !!exact && VERIFIED_VERSIONS[member].includes(exact); }
export function membersRoot(data: string): string { return path.join(data, 'members'); }
const versionDirectory = (data: string, member: CatalogId, version: string) => path.join(membersRoot(data), member, version);
function inside(root: string, target: string) { const rel = path.relative(root, target); return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); }
export function installedEntry(prefix: string, member: CatalogId): string | undefined {
  if(member==='cursor')return completeCursorEntry(prefix);
  if(member==='zcode')return completeZcodeEntry(prefix);
  if(member==='qoder'||member==='qodercn')return completeQoderEntry(prefix,undefined,member);
  const directory = path.join(prefix, 'node_modules', ...MEMBER_PACKAGES[member].split('/'));
  try {
    const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[catalogEntry(member).bin];
    if (pkg.name !== MEMBER_PACKAGES[member] || typeof bin !== 'string') return;
    const entry = path.resolve(directory, bin), info = statSync(entry);
    if (inside(directory, entry) && info.isFile() && info.size > 0) return entry;
  } catch { /* Absent or incomplete. */ }
}
const applies = (values: string[] | undefined, actual: string) => !values?.length || ((!values.some(x => !x.startsWith('!')) || values.includes(actual)) && !values.includes('!' + actual));
/** Check required peers and nested packages against npm's actual installation lock. */
function installFacts(prefix: string, member: CatalogId, version: string, strictIntegrity=false) {
  const entry = installedEntry(prefix, member); if (!entry) throw new Error('执行文件未完整安装。');
  const own = JSON.parse(readFileSync(path.join(prefix, 'node_modules', ...MEMBER_PACKAGES[member].split('/'), 'package.json'), 'utf8'));
  if (own.version !== version) throw new Error('安装的包版本与请求版本不一致。');
  const bytes = readFileSync(path.join(prefix, 'package-lock.json')), lock = JSON.parse(bytes.toString('utf8'));
  if (!lock.packages || Number(lock.lockfileVersion) < 2) throw new Error('缺少完整的 npm 安装清单。');
  const ownLock=lock.packages['node_modules/'+MEMBER_PACKAGES[member]];
  if(strictIntegrity&&(!ownLock||!/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(ownLock.integrity??'')))throw new Error('官方包缺少可核对的完整性记录。');
  for (const [name, value] of Object.entries(lock.packages) as [string, any][]) {
    if (!name.startsWith('node_modules/') || value.dev || !applies(value.os, process.platform) || !applies(value.cpu, process.arch)) continue;
    const target = path.resolve(prefix, name);
    if (name.includes('\\') || name.split('/').some(x => x === '..' || x === '.') || !inside(prefix, target)) throw new Error('安装清单中的依赖路径无效。');
    const file = path.join(target, 'package.json'); if (value.optional && !existsSync(file)) continue;
    if (JSON.parse(readFileSync(file, 'utf8')).version !== value.version) throw new Error('依赖版本不完整：' + name);
  }
  return { entry, lockSha256: digest(bytes), entrySize: statSync(entry).size };
}
function completeEntry(prefix: string, member: CatalogId, version: string): string | undefined {
  if(member==='cursor')return completeCursorEntry(prefix,version);
  if(member==='zcode')return completeZcodeEntry(prefix,version);
  if(member==='qoder'||member==='qodercn')return completeQoderEntry(prefix,version,member);
  try {
    const facts = installFacts(prefix, member, version);
    if (existsSync(path.join(prefix, MARKER))) {
      const marker = JSON.parse(readFileSync(path.join(prefix, MARKER), 'utf8'));
      if (marker.schema !== 1 || marker.member !== member || marker.version !== version || marker.lockSha256 !== facts.lockSha256 || marker.entrySize !== facts.entrySize) return;
    }
    return facts.entry; // Complete legacy versions remain discoverable; launch is checked before reuse.
  } catch { return; }
}
export function installedVersions(data: string, member: CatalogId): InstalledVersion[] {
  const root = path.join(membersRoot(data), member); if (!existsSync(root)) return [];
  return readdirSync(root).filter(version=>isCatalogVersion(member,version)).flatMap(version => { const entry = completeEntry(path.join(root, version), member, version); return entry ? [{ version, entry }] : []; }).sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
}
export function versionOfPath(data: string, member: CatalogId, file: string | undefined): string | undefined { if (file) return installedVersions(data, member).find(x => path.resolve(x.entry).toLowerCase() === path.resolve(file).toLowerCase())?.version; }
export type NpmRunner = (args: string[], env: NodeJS.ProcessEnv, cwd: string, timeout: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;
export class UnconfirmedNpmStop extends Error {}
/** A confirmed process exit must not wait indefinitely for inherited output pipes. */
export function waitForNpmOutput(child:ChildProcess,timeoutMs:number,stop:typeof stopOwned=stopOwned):ReturnType<NpmRunner> {
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='',settled=false,expired=false,drain:NodeJS.Timeout|undefined;
    const output=(data:string)=>{stdout=(stdout+data).slice(-200_000);};
    const errorOutput=(data:string)=>{stderr=(stderr+data).slice(-200_000);};
    function finish(code:number|null,error?:Error){
      if(settled)return;settled=true;clearTimeout(timer);clearTimeout(drain);
      child.removeListener('error',failed);child.removeListener('exit',exited);child.removeListener('close',closed);
      child.stdout?.removeListener('data',output);child.stderr?.removeListener('data',errorOutput);
      if(child.exitCode!==null||child.signalCode!==null){child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy();}
      error?reject(error):resolve({code,stdout,stderr});
    }
    const failed=(error:Error)=>{if(!expired)finish(null,error);};
    const closed=(code:number|null)=>{if(!expired)finish(code);};
    const exited=(code:number|null)=>{if(!expired){clearTimeout(timer);drain=setTimeout(()=>finish(code),1000);}};
    child.stdout?.setEncoding('utf8');child.stderr?.setEncoding('utf8');
    child.stdout?.on('data',output);child.stderr?.on('data',errorOutput);
    child.once('error',failed);child.once('exit',exited);child.once('close',closed);
    const timer=setTimeout(()=>{
      expired=true;
      void stop(child,3000).then(()=>finish(null,new Error('npm 操作超时，请检查网络后重试。')),
        error=>finish(null,new UnconfirmedNpmStop('npm 停止未确认，临时目录已保留：'+(error as Error).message)));
    },timeoutMs);
  });
}
export const runNpm: NpmRunner = async (args, env, cwd, timeoutMs) => {
  const npm=npmLaunch(env,cwd);
  return waitForNpmOutput(spawnOwned(npm.command,[...npm.prefix,...args],{cwd,env:npm.env}),timeoutMs);
};
/** npm 12 returns a one-element JSON array for a single view field; older npm returns the scalar. */
export function npmViewValue(stdout:string):unknown {const value=JSON.parse(stdout.trim());return Array.isArray(value)&&value.length===1?value[0]:value;}
export async function latestVersion(member: CatalogId, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  if(member==='cursor')return latestCursorVersion(env);
  if(member==='zcode')return latestZcodeVersion(env);
  if(member==='qoder'||member==='qodercn')return latestQoderVersion(env,member);
  const result = await runNpm(['view', MEMBER_PACKAGES[member], 'version', '--json'], env, cwd, 60_000);
  if (result.code !== 0) throw new Error('无法查询最新版本：' + result.stderr.trim().slice(-300));
  const value = npmViewValue(result.stdout); if (!isVersion(value)) throw new Error('npm 返回了无法识别的版本号。'); return value;
}
/** Check both lexical and resolved absolute paths before any recursive removal or move. */
async function managedTarget(data: string, member: CatalogId, target: string) {
  const root = path.resolve(membersRoot(data), member);
  if (path.dirname(path.resolve(target)) !== root) throw new Error('版本目录超出 AIROOM 管理范围。');
  for (const component of [membersRoot(data), root, target]) {
    const info = await lstat(component).catch(error => { if (error.code === 'ENOENT') return; throw error; });
    if (info?.isSymbolicLink()) throw new Error('版本目录包含目录链接，拒绝移动或删除。');
  }
  if (existsSync(target) && !inside(await realpath(root), await realpath(target))) throw new Error('版本目录实际位于管理范围之外。'); return path.resolve(target);
}
async function clean(data: string, member: CatalogId, target: string) { await rm(await managedTarget(data, member, target), { recursive: true, force: true }); }
/** Windows may release a just-exited CLI's directory handle after the guardian exit. */
async function moveManaged(data:string,member:CatalogId,source:string,target:string){
  for(let attempt=0;;attempt++){
    try{return await rename(await managedTarget(data,member,source),await managedTarget(data,member,target));}
    catch(error){
      if(process.platform!=='win32'||attempt>=20||!['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??''))throw error;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
  }
}
async function verifyLaunch(entry: string, version: string, env: NodeJS.ProcessEnv, prefix: string) {
  const cli = /\.(?:js|mjs|cjs)$/i.test(entry) ? { command: process.execPath, path: entry, prefix: [entry] } : { command: entry, path: entry, prefix: [] };
  const result = await collectCommand(cli, ['--version'], env, prefix, 30000);
  if (result.code !== 0 || extractVersion(result.stdout) !== version) throw new Error('新版本无法启动或报告了不同版本；尚未切换。'+(result.stderr||result.stdout).trim().slice(-600));
}
export type InstallProgress = Pick<MemberInstallation,'phase'|'writtenBytes'|'lastProgressAt'>;
export interface InstallOptions { npm?: NpmRunner; verify?: typeof verifyLaunch; progress?: (value:InstallProgress)=>void; requireIntegrity?:boolean }
async function stagingBytes(root:string):Promise<number>{
  let bytes=0,visited=0;const pending=[root];
  while(pending.length&&visited<5000){
    const directory=pending.pop()!;
    for(const entry of await readdir(directory,{withFileTypes:true}).catch(()=>[])){
      if(++visited>5000)break;
      const file=path.join(directory,entry.name);
      if(entry.isDirectory())pending.push(file);
      else if(entry.isFile())bytes+=(await lstat(file).catch(()=>undefined))?.size??0;
    }
  }
  return bytes;
}
const installations = new Set<string>();
export async function installVersion(data: string, member: CatalogId, version: string, env: NodeJS.ProcessEnv, options: InstallOptions = {}): Promise<InstalledVersion> {
  const catalog=catalogEntry(member);
  if (!isCatalogVersion(member,version)) throw new Error('版本号格式无效。');
  const root = path.resolve(membersRoot(data), member), prefix = versionDirectory(data, member, version), key = root.toLowerCase();
  if (installations.has(key)) throw new Error('该成员正在安装，请等待完成。'); installations.add(key);
  let temporary: string | undefined, retired: string | undefined;
  let sampler:NodeJS.Timeout|undefined,sampling=false,sampleRevision=0,writtenBytes=0,lastProgressAt:string|undefined;
  const progress=(phase:InstallProgress['phase'])=>options.progress?.({phase,...(writtenBytes?{writtenBytes,lastProgressAt}:{})});
  const stopSampling=()=>{clearInterval(sampler);sampleRevision++;};
  try {
    await mkdir(root, { recursive: true }); await managedTarget(data, member, prefix);
    if(member==='cursor')return await installCursor(root,version,env,options.progress,(source,target)=>moveManaged(data,member,source,target));
    if(member==='zcode')return await installZcode(root,version,env,options.progress,(source,target)=>moveManaged(data,member,source,target));
    if(member==='qoder'||member==='qodercn')return await installQoder(root,version,env,options.progress,(source,target)=>moveManaged(data,member,source,target),member);
    const launchEnvironment=['gemini','qwen','kimi'].includes(member)?{...env,AIROOM_NODE_CHILD_MODE:'1'}:env;
    const verify:typeof verifyLaunch=(entry,version,_env,prefix)=>(options.verify??verifyLaunch)(entry,version,launchEnvironment,prefix);
    if (completeEntry(prefix, member, version)) {
      try {
        progress('files');const facts = installFacts(prefix, member, version,options.requireIntegrity);progress('launch');await verify(facts.entry, version, env, prefix);
        await writeFile(path.join(prefix, MARKER), JSON.stringify({ schema: 1, member, version, ...facts, entry: path.relative(prefix, facts.entry) })); return { version, entry: facts.entry };
      } catch { /* Stage a replacement without changing the old directory first. */ }
    }
    temporary = path.join(root, '.install-' + version + '-' + randomUUID()); await mkdir(temporary);
    // Project-scoped npm installs require their script policy in the project manifest.
    // Approve only this reviewed vendor's setup script at the exact selected version.
    await writeFile(path.join(temporary,'package.json'),JSON.stringify({name:'airoom-managed-member',version:'0.0.0',private:true,allowScripts:{[`${MEMBER_PACKAGES[member]}@${version}`]:!!catalog.setupScript}}));
    progress('installing');const revision=sampleRevision,staging=temporary;
    if(options.progress){sampler=setInterval(()=>{
      if(sampling)return;sampling=true;
      void stagingBytes(staging).then(bytes=>{
        if(revision!==sampleRevision)return;
        if(bytes>writtenBytes){writtenBytes=bytes;lastProgressAt=new Date().toISOString();}
        progress('installing');
      }).catch(()=>{}).finally(()=>{sampling=false;});
    },2000);sampler.unref();}
    const result = await (options.npm ?? runNpm)(['install', `${MEMBER_PACKAGES[member]}@${version}`, '--prefix', temporary, '--no-audit', '--no-fund', '--omit=dev',...(options.requireIntegrity?['--ignore-scripts']:[])], env, temporary, 15 * 60_000);
    stopSampling();progress('files');
    if (result.code !== 0) throw new Error('npm 安装失败：' + (result.stderr || result.stdout).trim().slice(-400));
    if(options.requireIntegrity){
      const metadata=await (options.npm??runNpm)(['view',`${MEMBER_PACKAGES[member]}@${version}`,'dist.integrity','--registry=https://registry.npmjs.org/','--json'],env,temporary,60_000);
      const lock=JSON.parse(readFileSync(path.join(temporary,'package-lock.json'),'utf8'));
      const integrity=lock.packages?.['node_modules/'+MEMBER_PACKAGES[member]]?.integrity;
      if(metadata.code!==0||!/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(integrity??'')||npmViewValue(metadata.stdout)!==integrity)throw new Error('下载包与官方完整性记录不一致，未启用该版本。');
      // A mirror's metadata cannot authorize a vendor setup script. Approve it only after the official hash matches.
      if(catalog.setupScript){const setup=await (options.npm??runNpm)(['rebuild',MEMBER_PACKAGES[member],'--prefix',temporary,'--ignore-scripts=false','--no-audit','--no-fund'],env,temporary,120_000);if(setup.code!==0)throw new Error('已校验的官方安装脚本执行失败：'+setup.stderr.trim().slice(-300));}
    }
    const facts = installFacts(temporary, member, version,options.requireIntegrity);
    progress('launch');await verify(facts.entry, version, env, temporary);
    await writeFile(path.join(temporary, MARKER), JSON.stringify({ schema: 1, member, version, ...facts, entry: path.relative(temporary, facts.entry) }));
    if (existsSync(prefix)) { retired = path.join(root, '.replaced-' + version + '-' + randomUUID());await moveManaged(data,member,prefix,retired); }
    try { await moveManaged(data,member,temporary,prefix); }
    catch (error) { if (retired) { await moveManaged(data,member,retired,prefix); retired = undefined; } throw error; }
    temporary = undefined; if (retired) await clean(data, member, retired).catch(() => {});
    return { version, entry: installedEntry(prefix, member)! };
  } catch (error) {
    stopSampling();
    if (temporary && !(error instanceof UnconfirmedNpmStop)) await clean(data, member, temporary);
    if(error instanceof Error&&error.message==='npm 操作超时，请检查网络后重试。')throw new Error('下载或安装超时（最多 15 分钟）；本次未切换版本，请检查网络后重试。');
    throw error;
  }
  finally { stopSampling();installations.delete(key); }
}
export async function removeVersion(data: string, member: CatalogId, version: string, beforeRemove?: () => void): Promise<void> {
  if (!isCatalogVersion(member,version)) throw new Error('版本号格式无效。');
  const target = await managedTarget(data, member, versionDirectory(data, member, version));
  beforeRemove?.();
  await rm(target, { recursive: true, force: true });
}
