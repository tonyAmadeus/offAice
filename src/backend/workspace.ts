import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash,randomUUID } from 'node:crypto';
import type { Project, Session, Artifact } from '../shared/types';
import { resolveSafePath } from './security';
import {beginWriteback} from './workspace-writeback';

const exec=promisify(execFile);
const excluded=new Set(['node_modules','.git','.airoom','.npm-cache','.electron-cache','.electron-temp','.builder-cache','.test-cache','.airoom-smoke']);
const MAX_FILES=30000, MAX_COPY_BYTES=1024*1024*1024, MAX_FILE_BYTES=128*1024*1024;
interface Baseline { directory:string; files:Record<string,string>; inherited?:{sessionId:string;fingerprint:string} }
let preparing=Promise.resolve();
async function git(cwd:string,args:string[]) { return (await exec('git',args,{cwd,windowsHide:true,maxBuffer:16*1024*1024,timeout:60000})).stdout; }
async function exists(file:string) { try { await fs.access(file);return true; } catch { return false; } }
function hash(content:Buffer) { return createHash('sha256').update(content).digest('hex'); }
function identity(value:string) { return createHash('sha256').update(value).digest('hex').slice(0,24); }
function key(relative:string) { return relative.replaceAll('\\','/'); }

async function scan(root:string):Promise<Artifact[]> {
  const result:Artifact[]=[];
  async function walk(relative:string) {
    for (const entry of await fs.readdir(resolveSafePath(root,relative),{withFileTypes:true})) {
      if (excluded.has(entry.name)) continue;
      const child=relative ? path.join(relative,entry.name) : entry.name;
      if (entry.isSymbolicLink()) { resolveSafePath(root,child); continue; }
      const target=resolveSafePath(root,child);
      const stat=await fs.stat(target);
      result.push({name:entry.name,path:target,relativePath:child,size:stat.size,modifiedAt:stat.mtime.toISOString(),directory:stat.isDirectory()});
      if (result.length>MAX_FILES) throw new Error('工作区文件数量过多，请选择更小的项目目录。');
      if (stat.isDirectory()) await walk(child);
    }
  }
  await walk('');return result;
}

async function copyBaseline(source:string,destination:string,names:string[]) {
  let total=0,count=0;const files:Record<string,string>={};
  for (const relative of names) {
    if (!relative || relative.split(/[\\/]/).some(part=>excluded.has(part))) continue;
    const original=resolveSafePath(source,relative), target=resolveSafePath(destination,relative);
    let stat;
    try { stat=await fs.lstat(original); } catch(error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') { if (await exists(target)) await fs.unlink(target);continue; } throw error; }
    if (stat.isSymbolicLink()) throw new Error(`工作区含文件链接 ${relative}，请先明确链接边界再创建写入副本。`);
    if (!stat.isFile()) continue;
    total+=stat.size;count++;
    if (stat.size>MAX_FILE_BYTES || total>MAX_COPY_BYTES || count>MAX_FILES) throw new Error('工作区副本超出第一版的复制上限，请选择更小的代码目录。');
    await fs.mkdir(path.dirname(target),{recursive:true});
    resolveSafePath(destination,relative); // Recheck the created parent before writing.
    await fs.copyFile(original,target);
    await fs.chmod(target,stat.mode);
    const after=await fs.stat(original);
    if (stat.size!==after.size || stat.mtimeMs!==after.mtimeMs) throw new Error(`复制时 ${relative} 被其他程序修改，请重新创建任务副本。`);
    files[key(relative)]=hash(await fs.readFile(target));
  }
  return files;
}

export async function workspaceFiles(root:string):Promise<Artifact[]> {
  if (!(await exists(path.join(root,'.git')))) return (await scan(root)).filter(file=>!file.directory);
  const files:Artifact[]=[];
  for(const name of (await git(root,['ls-files','--cached','--others','--exclude-standard','-z'])).split('\0')) {
    if(!name||name.split(/[\\/]/).some(part=>excluded.has(part)))continue;
    let info;try{info=await fs.lstat(resolveSafePath(root,name));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    if(info.isSymbolicLink())throw new Error(`交接文件 ${name} 是链接，请先核对文件边界。`);
    if(info.isFile())files.push({name:path.basename(name),path:resolveSafePath(root,name),relativePath:name,size:info.size,modifiedAt:info.mtime.toISOString(),directory:false});
  }
  return files;
}

/** A content version of the actual source files; ignored build output is omitted. */
export async function workspaceFingerprint(root:string):Promise<string> {
  const files=(await workspaceFiles(root)).sort((a,b)=>key(a.relativePath).localeCompare(key(b.relativePath)));let total=0;
  if(files.length>MAX_FILES)throw new Error('交接文件数量过多，请缩小项目范围。');
  const digest=createHash('sha256');
  for(const file of files){total+=file.size;if(file.size>MAX_FILE_BYTES||total>MAX_COPY_BYTES)throw new Error('交接文件超过复制上限，请先整理工作副本。');digest.update(JSON.stringify([key(file.relativePath),hash(await fs.readFile(resolveSafePath(root,file.relativePath)))]));}
  return digest.digest('hex');
}

export async function prepareWorkspace(project:Project,session:Session,writeMode:boolean,dataDirectory:string,from?:Session,expectedFingerprint?:string):Promise<{directory:string;kind:'worktree'|'copy'|'original';inherited?:{sessionId:string;fingerprint:string}}> {
  const original=await fs.realpath(project.directory);
  if (!writeMode) return {directory:original,kind:'original'};
  const workspaces=path.resolve(dataDirectory,'workspaces');await fs.mkdir(workspaces,{recursive:true});
  if (session.workspace && session.workspaceKind && session.workspaceKind!=='original') {
    const relative=path.relative(workspaces,path.resolve(session.workspace));
    const safe=resolveSafePath(workspaces,relative);
    const info=await fs.stat(safe);
    if (!info.isDirectory()) throw new Error('任务工作区已不存在，请重新选择项目。');
    return {directory:safe,kind:session.workspaceKind};
  }
  const target=resolveSafePath(workspaces,`${identity(project.id)}-${identity(session.id)}`);
  const previous=preparing;let release!:()=>void;
  preparing=new Promise<void>(resolve=>{release=resolve;});await previous;
  let created=false,kind:'worktree'|'copy'='copy',source=original;
  try {
    let inheritedBaseline:Baseline|undefined,fingerprint:string|undefined;
    if(from){
      if(from.projectId!==project.id||!from.workspace||!from.workspaceKind||from.workspaceKind==='original')throw new Error('上一阶段没有可交接的独立工作副本。');
      const relative=path.relative(workspaces,path.resolve(from.workspace));
      if(!relative)throw new Error('上一阶段副本的归属无法核对。');
      source=await fs.realpath(resolveSafePath(workspaces,relative));
      inheritedBaseline=JSON.parse(await fs.readFile(resolveSafePath(source,'.airoom/baseline.json'),'utf8')) as Baseline;
      if(path.resolve(inheritedBaseline.directory).toLowerCase()!==original.toLowerCase())throw new Error('上一阶段工作副本的来源与项目不一致。');
      fingerprint=await workspaceFingerprint(source);
      if(expectedFingerprint&&fingerprint!==expectedFingerprint)throw new Error('上一阶段文件在交接前发生变化，请先核对新的成果版本。');
    }
    if (await exists(target)) {
      const saved=JSON.parse(await fs.readFile(resolveSafePath(target,'.airoom/baseline.json'),'utf8')) as Baseline;
      if (saved.directory!==original) throw new Error('现有任务副本的来源与当前项目不一致。');
      if(from&&(saved.inherited?.sessionId!==from.id||saved.inherited.fingerprint!==fingerprint))throw new Error('现有副本继承的成果与本次交接不同，请核对后新建阶段。');
      const kind=await exists(path.join(target,'.git'))?'worktree':'copy';return {directory:target,kind,...(saved.inherited?{inherited:saved.inherited}:{})};
    }
    let repository:string|undefined;
    try { repository=(await git(source,['rev-parse','--show-toplevel'])).trim(); } catch {}
    let hasHead=false;
    if (repository) { try { await git(source,['rev-parse','--verify','HEAD']);hasHead=true; } catch {} }
    let files:Record<string,string>;
    if (repository && hasHead && path.resolve(repository).toLowerCase()===source.toLowerCase()) {
      await git(source,['worktree','add','--detach',target,'HEAD']);kind='worktree';created=true;
      const names=(await git(source,['ls-files','--cached','--others','--exclude-standard','-z'])).split('\0');
      const deletions=(await git(source,['diff','--name-only','--diff-filter=D','HEAD','-z'])).split('\0').filter(Boolean);
      files=await copyBaseline(source,target,names);
      for (const relative of deletions) { const removed=resolveSafePath(target,relative);if (await exists(removed)) await fs.unlink(removed);delete files[key(relative)]; }
    } else {
      await fs.mkdir(target,{recursive:true});created=true;
      const artifacts=await scan(source);
      files=await copyBaseline(source,target,artifacts.filter(item=>!item.directory).map(item=>item.relativePath));
    }
    if(from&&(await workspaceFingerprint(source)!==fingerprint||await workspaceFingerprint(target)!==fingerprint))throw new Error('交接期间上一阶段文件发生变化，未启动下一阶段，请核对后再继续。');
    const inherited=from?{sessionId:from.id,fingerprint:fingerprint!}:undefined;
    await fs.mkdir(resolveSafePath(target,'.airoom'),{recursive:true});
    await fs.writeFile(resolveSafePath(target,'.airoom/baseline.json'),JSON.stringify({directory:original,files:inheritedBaseline?.files??files,...(inherited?{inherited}:{})}),'utf8');
    return {directory:target,kind,...(inherited?{inherited}:{})};
  } catch(error) {
    if(created){
      const safe=resolveSafePath(workspaces,path.relative(workspaces,target));
      if(kind==='worktree')await git(source,['worktree','remove','--force',safe]).catch(async()=>{await fs.rm(safe,{recursive:true,force:true});await git(source,['worktree','prune']).catch(()=>{});});
      else await fs.rm(safe,{recursive:true,force:true});
    }
    throw error;
  } finally { release(); }
}

export async function listArtifacts(root:string):Promise<Artifact[]> { return scan(await fs.realpath(root)); }
export async function readArtifact(root:string,relative:string):Promise<{content:string;language:string;truncated:boolean}> {
  const target=resolveSafePath(root,relative), stat=await fs.stat(target);
  if (!stat.isFile()) throw new Error('请选择文件。');
  const maximum=512*1024;
  const handle=await fs.open(target,'r');let bytes:Buffer;
  try { bytes=Buffer.alloc(Math.min(stat.size,maximum));await handle.read(bytes,0,bytes.length,0); } finally { await handle.close(); }
  if (bytes.includes(0)) throw new Error('这是二进制文件，请从文件列表打开产物。');
  const languages:Record<string,string>={'.ts':'typescript','.tsx':'tsx','.js':'javascript','.jsx':'jsx','.json':'json','.md':'markdown','.py':'python','.html':'html','.css':'css','.ps1':'powershell','.yml':'yaml','.yaml':'yaml','.txt':'text'};
  return {content:bytes.toString('utf8'),language:languages[path.extname(target).toLowerCase()]??'text',truncated:stat.size>maximum};
}

export type WorkspaceChange={path:string;kind:'added'|'modified'|'deleted'};
export type ApplyResult={applied:WorkspaceChange[];conflicts:{path:string;reason:string}[];unchanged:boolean};
async function fileHash(file:string) { try { return hash(await fs.readFile(file)); } catch(error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return undefined; throw error; } }

/**
 * Copy a work copy's changes back into the original project.
 * Every change is checked against the task-start baseline first: a project file that changed since the
 * task began is a conflict, and any conflict cancels the whole apply, so nothing is half-written.
 */
export async function applyWorkspace(root:string,projectDirectory:string,validateChanges?:(paths:string[])=>void,runId?:string):Promise<ApplyResult> {
  const directory=await fs.realpath(root), original=await fs.realpath(projectDirectory);
  const baselinePath=resolveSafePath(directory,'.airoom/baseline.json');
  const baseline=JSON.parse(await fs.readFile(baselinePath,'utf8')) as Baseline;
  if (path.resolve(baseline.directory).toLowerCase()!==original.toLowerCase()) throw new Error('这个工作副本不是从当前项目创建的，不能应用。');
  const plan:{change:WorkspaceChange;hash?:string}[]=[], conflicts:ApplyResult['conflicts']=[];
  const current=new Set<string>();
  // A git work copy follows the project's .gitignore: build output and local secrets are never carried over.
  let files:{relativePath:string;size:number}[];
  if (await exists(path.join(directory,'.git'))) {
    files=[];
    for (const name of (await git(directory,['ls-files','--cached','--others','--exclude-standard','-z'])).split('\0')) {
      if (!name || name.split(/[\\/]/).some(part=>excluded.has(part))) continue;
      try { const info=await fs.lstat(resolveSafePath(directory,name)); if (info.isFile()) files.push({relativePath:name,size:info.size}); } catch {}
    }
  } else files=(await scan(directory)).filter(item=>!item.directory);
  for (const artifact of files) {
    const relative=key(artifact.relativePath);current.add(relative);
    if (artifact.size>MAX_FILE_BYTES) { conflicts.push({path:relative,reason:'文件过大，请手动复制'});continue; }
    const next=hash(await fs.readFile(resolveSafePath(directory,artifact.relativePath)));
    const base=baseline.files[relative];
    if (base===next) continue;
    const there=await fileHash(resolveSafePath(original,artifact.relativePath));
    if (there===next) continue; // Already identical in the project.
    if (base===undefined && there!==undefined) conflicts.push({path:relative,reason:'项目里已有同名文件，内容不同'});
    else if (base!==undefined && there!==base) conflicts.push({path:relative,reason:there===undefined?'项目里这个文件已被删除':'项目里这个文件在任务开始后被改过'});
    else plan.push({change:{path:relative,kind:base===undefined?'added':'modified'},hash:next});
  }
  for (const [relative,base] of Object.entries(baseline.files)) {
    if (current.has(relative)) continue;
    const there=await fileHash(resolveSafePath(original,relative));
    if (there===undefined) continue;
    if (there!==base) conflicts.push({path:relative,reason:'副本里删除了它，但项目里的这个文件在任务开始后被改过'});
    else plan.push({change:{path:relative,kind:'deleted'}});
  }
  if (conflicts.length) return {applied:[],conflicts,unchanged:false};
  if (!plan.length) return {applied:[],conflicts:[],unchanged:true};
  validateChanges?.(plan.map(item=>item.change.path));
  const finishWriteback=runId?await beginWriteback(directory,original,runId,plan.map(item=>item.change)):undefined;
  for (const item of plan) {
    validateChanges?.([item.change.path]);const expected=baseline.files[item.change.path];
    if(await fileHash(resolveSafePath(original,item.change.path))!==expected)throw new Error('写入前项目文件发生改变，请重新检查。');
    const target=resolveSafePath(original,item.change.path);
    if (item.change.kind==='deleted') { validateChanges?.([item.change.path]);await fs.unlink(target);delete baseline.files[item.change.path];continue; }
    await fs.mkdir(path.dirname(target),{recursive:true});
    resolveSafePath(original,item.change.path); // Recheck the created parent before writing.
    const bytes=await fs.readFile(resolveSafePath(directory,item.change.path));if(hash(bytes)!==item.hash)throw new Error('采用前工作副本内容发生改变，请重新检查。');
    const temporary=target+'.airoom-apply-'+randomUUID();
    try{await fs.writeFile(temporary,bytes,{flag:'wx'});validateChanges?.([item.change.path]);if(await fileHash(target)!==expected)throw new Error('写入前项目文件发生改变，请重新检查。');validateChanges?.([item.change.path]);await fs.rename(temporary,target);}finally{await fs.unlink(temporary).catch(()=>{});}
    baseline.files[item.change.path]=item.hash!;
  }
  // The project now matches these files; later applies only carry newer changes.
  await fs.writeFile(baselinePath,JSON.stringify(baseline),'utf8');
  await finishWriteback?.();
  return {applied:plan.map(item=>item.change),conflicts:[],unchanged:false};
}

/** Remove a session's work copy: a git worktree is unregistered from the project, a plain copy is deleted. */
export async function discardWorkspace(session:Session,project:Project,dataDirectory:string):Promise<void> {
  if (!session.workspace || !session.workspaceKind || session.workspaceKind==='original') return;
  const workspaces=path.resolve(dataDirectory,'workspaces');
  const relative=path.relative(workspaces,path.resolve(session.workspace));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('工作副本不在 AIROOM 的工作区目录里，不能删除。');
  const target=resolveSafePath(workspaces,relative);
  if (!(await exists(target))) return;
  if (session.workspaceKind==='worktree') {
    try { await git(project.directory,['worktree','remove','--force',target]); }
    catch { await fs.rm(target,{recursive:true,force:true});await git(project.directory,['worktree','prune']).catch(()=>undefined); }
  } else await fs.rm(target,{recursive:true,force:true});
}

export async function diffWorkspace(root:string):Promise<{text:string}> {
  const directory=await fs.realpath(root), baselinePath=resolveSafePath(directory,'.airoom/baseline.json');
  let baseline:Baseline|undefined;
  try { baseline=JSON.parse(await fs.readFile(baselinePath,'utf8')) as Baseline; } catch(error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
  const changes:string[]=[];
  if (baseline) {
    const current=new Set<string>();
    for (const artifact of (await scan(directory)).filter(item=>!item.directory)) {
      const relative=key(artifact.relativePath);current.add(relative);
      if (!baseline.files[relative]) changes.push(`新增 ${relative}`);
      else if (artifact.size>MAX_FILE_BYTES || hash(await fs.readFile(resolveSafePath(directory,artifact.relativePath)))!==baseline.files[relative]) changes.push(`修改 ${relative}`);
    }
    for (const relative of Object.keys(baseline.files)) if (!current.has(relative)) changes.push(`删除 ${relative}`);
    if (!changes.length) return {text:'相对任务开始时，工作区尚无文件改动。'};
  }
  let native='';try { native=await git(directory,['diff','--no-ext-diff','--no-textconv','--no-renames','HEAD','--','.',':(exclude).airoom']); } catch {}
  return {text:(baseline?`相对任务开始时：\n${changes.join('\n')}\n\n`:'')+(native?`以下 Git 差异以 HEAD 为基准，可能包含项目原有的未提交修改：\n${native}`:baseline?'新增文件可在产物列表中查看。':'当前目录没有可用的 Git 差异。')};
}
