import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { Session } from '../shared/types';
import { resolveSafePath } from './security';
import type { WorkspaceChange } from './workspace';
import type { ProjectUndo } from './workspace-writeback';

const excluded=new Set(['node_modules','.git','.airoom','.npm-cache','.electron-cache','.electron-temp','.builder-cache','.test-cache','.airoom-smoke']);
const MAX_FILES=30000,MAX_BYTES=1024*1024*1024,MAX_FILE_BYTES=128*1024*1024;
type FileState={hash:string;mode:number};
type Files=Record<string,FileState>;
type GitState={head:string;directory:string;index?:FileState;tree?:string};
type Image={files:Files;git?:GitState};
interface Checkpoint { sessionId:string;runId:string;root:string;status:'capturing'|'available'|'none'|'undone'|'unavailable';before:Image;after?:Image;at:string;reason?:string }
export interface UndoInfo { runId?:string;status:Checkpoint['status']|'missing';changes:WorkspaceChange[];conflicts:{path:string;reason:string}[];canUndo:boolean;reason?:string;projectUndo?:ProjectUndo }
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const same=(a?:FileState,b?:FileState)=>a?.hash===b?.hash&&a?.mode===b?.mode;
const identity=(value:string)=>digest(value).slice(0,24);
const missing=(error:unknown)=>['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??'');
function git(cwd:string,args:string[],input?:string,env?:NodeJS.ProcessEnv):Promise<string>{
  return new Promise((resolve,reject)=>{const child=execFile('git',args,{cwd,env,windowsHide:true,maxBuffer:16*1024*1024,timeout:60000},(error,stdout)=>error?reject(error):resolve(stdout));child.stdin?.on('error',()=>{});child.stdin?.end(input);});
}
async function readFileState(file:string,objects?:string):Promise<FileState|undefined>{
  let stat;try{stat=await fs.lstat(file);}catch(error){if(missing(error))return;throw error;}
  if(!stat.isFile()||stat.isSymbolicLink())throw new Error('路径已成为目录或文件链接，请手动核对。');
  if(stat.size>MAX_FILE_BYTES)throw new Error('文件超过 128 MiB，无法保存本轮还原点。');
  const bytes=await fs.readFile(file),after=await fs.lstat(file);
  if(!after.isFile()||stat.size!==after.size||stat.mtimeMs!==after.mtimeMs||stat.ino!==after.ino)throw new Error('保存还原点时文件被其他程序修改，请稍后重试。');
  const hash=digest(bytes);
  if(objects){const target=resolveSafePath(objects,hash);try{await fs.writeFile(target,bytes,{flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const saved=await fs.lstat(target);if(!saved.isFile()||saved.isSymbolicLink()||digest(await fs.readFile(target))!==hash)throw new Error('还原点缓存内容校验失败。');}}
  return {hash,mode:stat.mode&0o777};
}
/** Reject links in every existing component, including links whose target has disappeared. */
async function filePath(root:string,relative:string){
  if(!relative||relative.split(/[\\/]/).some(part=>part==='..'||excluded.has(part)))throw new Error('还原点中的文件路径无效。');
  const target=resolveSafePath(root,relative),parts=relative.split(/[\\/]/);
  for(let index=1;index<=parts.length;index++){
    try{const entry=await fs.lstat(path.join(root,...parts.slice(0,index)));if(entry.isSymbolicLink())throw new Error('文件路径包含链接，请手动核对。');if(index<parts.length&&!entry.isDirectory())throw new Error('文件的父路径不再是目录。');}
    catch(error){if(missing(error))break;throw error;}
  }
  return target;
}
async function locations(session:Session,dataDirectory:string){
  if(!session.workspace||!['copy','worktree'].includes(session.workspaceKind??''))throw new Error('只有允许写入的独立工作副本可以撤销。');
  const workspaces=path.resolve(dataDirectory,'workspaces'),relative=path.relative(workspaces,path.resolve(session.workspace));
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('工作副本不在 AIROOM 的工作区目录里。');
  const root=resolveSafePath(workspaces,relative);
  if((await fs.lstat(root)).isSymbolicLink())throw new Error('工作副本不能是目录链接。');
  const directory=resolveSafePath(dataDirectory,`checkpoints/${identity(session.id)}`);
  await fs.mkdir(directory,{recursive:true});
  const objects=resolveSafePath(directory,'objects');await fs.mkdir(objects,{recursive:true});
  return {root,directory,objects,manifest:resolveSafePath(directory,'latest.json')};
}
async function capture(root:string,objects:string,include:string[]=[],canceled:()=>boolean=()=>false):Promise<Image>{
  let gitState:GitState|undefined,names:string[]=[];
  // A worktree follows .gitignore; dependency/build output is outside the file undo scope.
  if(await fs.lstat(path.join(root,'.git')).then(()=>true,error=>missing(error)?false:Promise.reject(error))){
    const top=(await git(root,['rev-parse','--show-toplevel'])).trim();
    if(path.resolve(top).toLowerCase()!==path.resolve(root).toLowerCase())throw new Error('工作副本的 Git 边界已改变。');
    const directory=(await git(root,['rev-parse','--absolute-git-dir'])).trim();
    gitState={head:(await git(root,['rev-parse','HEAD'])).trim(),directory,index:await readFileState(path.join(directory,'index'),objects)};
    names=(await git(root,['ls-files','--cached','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
  }else{
    const walk=async(relative:string)=>{for(const entry of await fs.readdir(resolveSafePath(root,relative),{withFileTypes:true})){
      if(canceled())throw new Error('保存还原点已取消。');
      if(excluded.has(entry.name))continue;
      const name=relative?`${relative}/${entry.name}`:entry.name;
      if(entry.isSymbolicLink())throw new Error(`工作副本含链接 ${name}，请先手动核对文件边界。`);
      if(entry.isDirectory())await walk(name);else names.push(name);
      if(names.length>MAX_FILES)throw new Error('还原点超过 30000 个文件，请使用较小的项目。');
    }};await walk('');
  }
  let bytes=0,count=0;const files:Files={};
  for(const name of [...new Set([...names,...include])].sort()){
    if(canceled())throw new Error('保存还原点已取消。');
    if(name.split(/[\\/]/).some(part=>excluded.has(part)))continue;
    const relative=name.replaceAll('\\','/'),target=await filePath(root,relative),state=await readFileState(target,objects);
    if(!state)continue;
    bytes+=(await fs.stat(target)).size;
    if(bytes>MAX_BYTES||++count>MAX_FILES)throw new Error('还原点超过 1 GiB 或 30000 个文件，请使用较小的项目。');
    files[relative]=state;
  }
  return {files,git:gitState};
}
async function save(file:string,value:Checkpoint){const temporary=`${file}.${randomUUID()}.tmp`;await fs.writeFile(temporary,JSON.stringify(value));await fs.rename(temporary,file);}
async function load(file:string):Promise<Checkpoint|undefined>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(missing(error))return;throw error;}}
function changes(checkpoint:Checkpoint):WorkspaceChange[]{
  if(!checkpoint.after)return [];
  return [...new Set([...Object.keys(checkpoint.before.files),...Object.keys(checkpoint.after.files)])].sort().filter(name=>!same(checkpoint.before.files[name],checkpoint.after!.files[name])).map(name=>({path:name,kind:!checkpoint.before.files[name]?'added':!checkpoint.after!.files[name]?'deleted':'modified'}));
}
async function gitTree(root:string,directory:string,objects:string,files:Files){
  const entries=Object.entries(files),env={...process.env,GIT_INDEX_FILE:path.join(directory,'snapshot.index')};
  await git(root,['read-tree','--empty'],undefined,env);
  if(entries.length){
    const hashes=(await git(root,['hash-object','-w','--no-filters','--stdin-paths'],entries.map(([,file])=>JSON.stringify(path.join(objects,file.hash).replaceAll('\\','/'))).join('\n')+'\n')).trim().split(/\r?\n/);
    if(hashes.length!==entries.length||hashes.some(value=>!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(value)))throw new Error('Git 未完整保存本轮暂存快照。');
    await git(root,['update-index','-z','--index-info'],entries.map(([name,file],index)=>`${file.mode&0o111?'100755':'100644'} ${hashes[index]}\t${name}\0`).join(''),env);
  }
  return (await git(root,['write-tree'],undefined,env)).trim();
}
export async function beginCheckpoint(session:Session,runId:string,dataDirectory:string,canceled:()=>boolean=()=>false){
  const location=await locations(session,dataDirectory),previous=await load(location.manifest);
  const before=await capture(location.root,location.objects,[],canceled);
  if(before.git)before.git.tree=await gitTree(location.root,location.directory,location.objects,before.files);
  if(canceled())throw new Error('保存还原点已取消。');
  await save(location.manifest,{sessionId:session.id,runId,root:location.root,status:'capturing',before,at:new Date().toISOString()});
  return previous?.runId;
}
async function verify(checkpoint:Checkpoint,root:string,objects:string):Promise<UndoInfo['conflicts']>{
  const conflicts:UndoInfo['conflicts']=[];
  if(checkpoint.root!==root||!checkpoint.after)return [{path:'工作副本',reason:'还原点与当前工作副本不匹配'}];
  const hasGit=await fs.lstat(path.join(root,'.git')).then(()=>true,error=>missing(error)?false:Promise.reject(error));
  if(hasGit!==Boolean(checkpoint.after.git)||Boolean(checkpoint.before.git)!==Boolean(checkpoint.after.git)||checkpoint.before.git?.directory!==checkpoint.after.git?.directory)return [{path:'Git',reason:'还原点的 Git 目录不匹配'}];
  for(const change of changes(checkpoint)){
    try{
      const current=await readFileState(await filePath(root,change.path));
      if(!same(current,checkpoint.after.files[change.path]))conflicts.push({path:change.path,reason:'本轮结束后文件又被修改，已保留后续编辑'});
      for(const state of [checkpoint.before.files[change.path],checkpoint.after.files[change.path]])if(state){
        if(!/^[0-9a-f]{64}$/.test(state.hash)||digest(await fs.readFile(resolveSafePath(objects,state.hash)))!==state.hash)throw new Error('还原点文件缺失或内容校验失败');
      }
    }catch(error){conflicts.push({path:change.path,reason:(error as Error).message});}
  }
  if(checkpoint.after.git){
    try{
      if(await fs.access(path.join(checkpoint.after.git.directory,'index.lock')).then(()=>true,()=>false))throw new Error('Git 正在操作暂存区，请等待后重试');
      if((await git(root,['rev-parse','--absolute-git-dir'])).trim()!==checkpoint.after.git.directory||(await git(root,['rev-parse','HEAD'])).trim()!==checkpoint.after.git.head||!same(await readFileState(path.join(checkpoint.after.git.directory,'index')),checkpoint.after.git.index))conflicts.push({path:'Git',reason:'本轮结束后 Git 提交、目录或暂存区又被修改'});
      const index=checkpoint.before.git?.index;if(index&&digest(await fs.readFile(resolveSafePath(objects,index.hash)))!==index.hash)throw new Error('Git 暂存区还原点校验失败');
    }catch(error){conflicts.push({path:'Git',reason:(error as Error).message});}
  }
  return conflicts;
}
export async function finishCheckpoint(session:Session,runId:string,dataDirectory:string,cleaned=true):Promise<UndoInfo>{
  const location=await locations(session,dataDirectory),checkpoint=await load(location.manifest);
  if(!checkpoint||checkpoint.runId!==runId)throw new Error('本轮还原点不存在。');
  try{
    if(!cleaned)throw new Error('本轮程序退出尚未确认，请先核对进程，不能撤销。');
    checkpoint.after=await capture(location.root,location.objects,Object.keys(checkpoint.before.files));
    if(checkpoint.before.git?.head!==checkpoint.after.git?.head||checkpoint.before.git?.directory!==checkpoint.after.git?.directory)throw new Error('本轮改变了 Git 提交或目录状态，请先手动核对；文件撤销不重写提交。');
    checkpoint.status=changes(checkpoint).length||!same(checkpoint.before.git?.index,checkpoint.after.git?.index)?'available':'none';
  }catch(error){checkpoint.status='unavailable';checkpoint.reason=(error as Error).message;}
  await save(location.manifest,checkpoint);
  // Reclaim only owned content-addressed blobs, retaining before/after data for the most recent run.
  const needed=new Set([...Object.values(checkpoint.before.files),...Object.values(checkpoint.after?.files??{}),checkpoint.before.git?.index,checkpoint.after?.git?.index].filter((value):value is FileState=>!!value).map(value=>value.hash));
  for(const name of await fs.readdir(location.objects))if(/^[0-9a-f]{64}$/.test(name)&&!needed.has(name))await fs.unlink(resolveSafePath(location.objects,name));
  return {runId,status:checkpoint.status,changes:changes(checkpoint),conflicts:[],canUndo:checkpoint.status==='available',reason:checkpoint.reason};
}
export async function checkpointInfo(session:Session,dataDirectory:string):Promise<UndoInfo>{
  const location=await locations(session,dataDirectory),checkpoint=await load(location.manifest);
  if(!checkpoint)return {status:'missing',changes:[],conflicts:[],canUndo:false,reason:'这个工作副本还没有可撤销的轮次。'};
  const conflicts=checkpoint.status==='available'?await verify(checkpoint,location.root,location.objects):[];
  return {runId:checkpoint.runId,status:checkpoint.status,changes:changes(checkpoint),conflicts,canUndo:checkpoint.status==='available'&&!conflicts.length,reason:checkpoint.reason??(checkpoint.status==='capturing'?'本轮还没有完整记录结束状态。':checkpoint.status==='none'?'最近一轮没有文件或暂存区改动。':checkpoint.status==='undone'?'最近一轮已经撤销。':undefined)};
}
async function restore(root:string,relative:string,state:FileState|undefined,objects:string){
  const target=await filePath(root,relative);
  if(!state){await fs.unlink(target).catch(error=>{if(!missing(error))throw error;});return;}
  const bytes=await fs.readFile(resolveSafePath(objects,state.hash));if(digest(bytes)!==state.hash)throw new Error('还原点内容校验失败。');
  await fs.mkdir(path.dirname(target),{recursive:true});await filePath(root,relative);
  const temporary=path.join(path.dirname(target),`.airoom-restore-${randomUUID()}`);
  try{await fs.writeFile(temporary,bytes,{flag:'wx',mode:state.mode});await fs.chmod(temporary,state.mode);await filePath(root,relative);await fs.rename(temporary,target);}finally{await fs.unlink(temporary).catch(()=>{});}
}
async function restoreIndex(gitState:GitState|undefined,objects:string){
  if(!gitState)return;const target=path.join(gitState.directory,'index');
  if(!gitState.index){await fs.unlink(target).catch(error=>{if(!missing(error))throw error;});return;}
  const bytes=await fs.readFile(resolveSafePath(objects,gitState.index.hash));if(digest(bytes)!==gitState.index.hash)throw new Error('Git 暂存区还原点校验失败。');
  const temporary=`${target}.airoom-${randomUUID()}`;try{await fs.writeFile(temporary,bytes,{flag:'wx',mode:gitState.index.mode});await fs.chmod(temporary,gitState.index.mode);await fs.rename(temporary,target);}finally{await fs.unlink(temporary).catch(()=>{});}
}
export async function undoCheckpoint(session:Session,runId:string,dataDirectory:string,validateChanges?:(paths:string[])=>void):Promise<UndoInfo>{
  const location=await locations(session,dataDirectory),checkpoint=await load(location.manifest),info=await checkpointInfo(session,dataDirectory);
  if(!checkpoint||checkpoint.runId!==runId)throw new Error('可撤销的最近一轮已经改变，请重新查看。');
  if(!info.canUndo)return info;validateChanges?.(info.changes.map(c=>c.path));
  const applied:string[]=[],lock=checkpoint.after!.git?path.join(checkpoint.after!.git.directory,'index.lock'):undefined;
  const handle=lock?await fs.open(lock,'wx'):undefined;
  let indexRestored=false;
  try{
    const endedGit=checkpoint.after!.git;
    if(endedGit&&((await git(location.root,['rev-parse','--absolute-git-dir'])).trim()!==endedGit.directory||(await git(location.root,['rev-parse','HEAD'])).trim()!==endedGit.head||!same(await readFileState(path.join(endedGit.directory,'index')),endedGit.index)))throw new Error('撤销前 Git 提交、目录或暂存区又被修改。');
    for(const change of info.changes){
      if(!same(await readFileState(await filePath(location.root,change.path)),checkpoint.after!.files[change.path]))throw new Error(`撤销前 ${change.path} 又被修改。`);
      await restore(location.root,change.path,checkpoint.before.files[change.path],location.objects);applied.push(change.path);
    }
    await restoreIndex(checkpoint.before.git,location.objects);
    indexRestored=Boolean(checkpoint.before.git);
    checkpoint.status='undone';checkpoint.at=new Date().toISOString();await save(location.manifest,checkpoint);
  }catch(error){
    for(const name of applied.reverse()){
      if(!same(await readFileState(await filePath(location.root,name)),checkpoint.before.files[name]))throw new Error(`撤销期间 ${name} 又被修改，回滚尚未确认，请手动核对。`);
      await restore(location.root,name,checkpoint.after!.files[name],location.objects);
    }
    if(indexRestored)await restoreIndex(checkpoint.after!.git,location.objects);
    throw error;
  }finally{await handle?.close();if(lock)await fs.unlink(lock);}
  return {...info,status:'undone',canUndo:false};
}

export async function removeCheckpoint(sessionId:string,dataDirectory:string){
  const root=resolveSafePath(dataDirectory,'checkpoints');
  const directory=path.join(root,identity(sessionId));
  let stat;try{stat=await fs.lstat(directory);}catch(error){if(missing(error))return;throw error;}
  if(stat.isSymbolicLink()||(await fs.lstat(root)).isSymbolicLink())throw new Error('还原点目录含链接，未自动清理。');
  const saved=await load(resolveSafePath(root,`${identity(sessionId)}/latest.json`));
  if(saved?.sessionId!==sessionId)throw new Error('还原点归属未确认，未自动清理。');
  const relative=path.relative(root,path.resolve(directory));if(relative!==identity(sessionId))throw new Error('还原点目录不在预期位置。');
  await fs.rm(directory,{recursive:true,force:true});
}
