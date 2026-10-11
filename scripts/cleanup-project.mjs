import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';

const DAY=86400000;
const slash=value=>value.replaceAll('\\','/');
const key=value=>process.platform==='win32'?value.toLowerCase():value;
const same=(a,b)=>key(path.resolve(a))===key(path.resolve(b));
const within=(root,target)=>{const relative=path.relative(root,target);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
const exists=async file=>{try{return await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const hash=async file=>{const digest=createHash('sha256');for await(const chunk of createReadStream(file))digest.update(chunk);return digest.digest('hex');};
const fingerprint=s=>[s.size,s.mtimeMs,s.ctimeMs,s.birthtimeMs,String(s.ino)].join(':');
const newest=s=>Math.max(s.mtimeMs,s.ctimeMs,s.birthtimeMs);
const recordExtensions=new Set(['.log','.json','.jsonl','.md','.txt','.csv','.xml','.html','.htm','.png','.jpg','.jpeg','.webp','.gif','.svg','.pdf','.sqlite','.sqlite3','.db','.wal','.shm','.zip','.7z','.tar','.gz','.tgz','.bak','.backup','.har','.trace','.dmp','.mp4','.webm','.yaml','.yml']);
const recordDirectories=new Set(['docs','handoffs','records','tests','results','test-results','screenshots','logs','reports','evidence','.git']);
const recordFile=relative=>slash(relative).split('/').some(part=>recordDirectories.has(part.toLowerCase()))||recordExtensions.has(path.extname(relative).toLowerCase())||/\.(?:sqlite3?|db)-(?:wal|shm)$/i.test(relative)||/^AIROOM.+\.exe$/i.test(path.basename(relative));

export async function validateRoot(input){
  const root=path.resolve(input),stat=await fs.lstat(root);
  if(!stat.isDirectory()||stat.isSymbolicLink()||!same(await fs.realpath(root),root)||same(root,path.parse(root).root))throw new Error('项目根目录必须是实际目录，不能是磁盘根目录、链接或联接。');
  const manifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  if(manifest.name!=='airoom'||!await exists(path.join(root,'src/backend/engine.ts'))||!await exists(path.join(root,'.git')))throw new Error('这不是完整的 AIROOM Git 项目目录。');
  return root;
}
async function safePath(root,relative){
  const target=path.resolve(root,relative);
  if(!within(root,target))throw new Error('清理路径越出项目目录：'+relative);
  if(!same(await fs.realpath(path.dirname(target)),path.dirname(target)))throw new Error('清理路径经过链接或联接：'+relative);
  if(!within(root,await fs.realpath(path.dirname(target)))&&!same(root,path.dirname(target)))throw new Error('清理路径指向项目之外：'+relative);
  const stat=await fs.lstat(target);
  if(stat.isSymbolicLink())throw new Error('跳过链接或联接：'+relative);
  return {target,stat};
}
function trackedFiles(root){return new Set(execFileSync('git',['-C',root,'ls-files','-z'],{encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024}).split('\0').filter(Boolean).map(p=>key(slash(p))));}
export function runningProcesses(){
  if(process.platform!=='win32'){
    return execFileSync('ps',['-eo','pid=,ppid=,comm=,args='],{encoding:'utf8'}).trim().split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);return m?{pid:+m[1],parent:+m[2],name:m[3],command:m[4]}:null;}).filter(Boolean);
  }
  // Command lines stay in memory; reports contain only the process ID and name.
  const raw=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine) | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
  return [].concat(JSON.parse(raw)).map(p=>({pid:p.ProcessId,parent:p.ParentProcessId,name:p.Name,command:(p.ExecutablePath??'')+' '+(p.CommandLine??'')}));
}
function otherProcesses(processes){const own=new Set([process.pid]);let id=process.pid;for(let i=0;i<30;i++){const parent=processes.find(p=>p.pid===id)?.parent;if(!parent||own.has(parent))break;own.add(parent);id=parent;}return processes.filter(p=>!own.has(p.pid));}
function activity(processes,root,target){
  return otherProcesses(processes).filter(p=>{
    const command=key(slash(p.command??'')),project=key(slash(root)),candidate=key(slash(target));
    return command.includes(candidate)||(command.includes(project)&&/(?:scripts\/(?:verify|build|dev|desktop-smoke|catalog-download-smoke|launch)\.|tests\/|npm-cli\.js.*\b(?:test|verify|package|build|dev|start)\b)/i.test(command));
  }).map(p=>({pid:p.pid,name:p.name}));
}
async function entries(directory){const stat=await exists(directory);return stat?.isDirectory()&&!stat.isSymbolicLink()?fs.readdir(directory,{withFileTypes:true}):[];}
async function walk(directory,visit,relative=''){
  const stat=await fs.lstat(directory);await visit(relative,stat,directory);
  if(!stat.isDirectory()||stat.isSymbolicLink())return;
  for(const entry of await fs.readdir(directory))await walk(path.join(directory,entry),visit,path.join(relative,entry));
}
async function discover(root,options){
  const candidates=[];
  const protectedTargets=[];
  for(const name of ['src','tests','docs','assets','node_modules','dist','release/win-unpacked','release/rollback','.airoom','.airoom-data','.claude']){try{protectedTargets.push(await fs.realpath(path.join(root,name)));}catch(e){if(e.code!=='ENOENT')throw e;}}
  for(const entry of await fs.readdir(root,{withFileTypes:true}))if(entry.isSymbolicLink()){try{protectedTargets.push(await fs.realpath(path.join(root,entry.name)));}catch{/* A broken root link is left untouched. */}}
  const add=async(relative,days,reason)=>{const absolute=path.join(root,relative),s=await exists(absolute);if(s?.isDirectory()&&!s.isSymbolicLink()&&!protectedTargets.some(target=>same(absolute,target)||within(absolute,target)||within(target,absolute)))candidates.push({path:slash(relative),days,reason});};
  for(const name of ['.builder-temp','.electron-temp','.runtime-temp'])await add(name,options.tempDays,'过期构建临时目录');
  for(const name of ['.npm-cache','.electron-cache','.builder-cache'])await add(name,options.cacheDays,'过期可重新下载的构建缓存');
  for(const entry of await entries(path.join(root,'.test-cache/portable-temp'))){
    const rel=path.join('.test-cache/portable-temp',entry.name),dir=path.join(root,rel);
    if(await exists(path.join(dir,'AIROOM.exe'))&&await exists(path.join(dir,'resources/app/package.json'))||await exists(path.join(dir,'app-64.7z'))&&await exists(path.join(dir,'7z-out/AIROOM.exe')))await add(rel,options.tempDays,'便携版测试解压残留');
  }
  for(const entry of await entries(path.join(root,'.test-cache/test-profiles'))){
    if(!/^run-[A-Za-z0-9_-]+$/.test(entry.name))continue;
    for(const suffix of ['temp','user/AppData/Local/Temp','data/process-temp','data/electron/session/Cache'])await add(path.join('.test-cache/test-profiles',entry.name,suffix),options.tempDays,'隔离测试配置内的临时缓存');
  }
  // Historical full-project copies keep their sources, tests, docs and unique installers.
  for(const entry of await entries(path.join(root,'release'))){
    if(!/^[a-z][a-z0-9-]*-[a-f0-9]{7,40}$/i.test(entry.name)||entry.isSymbolicLink())continue;
    const rel=path.join('release',entry.name);let manifest;
    try{manifest=JSON.parse(await fs.readFile(path.join(root,rel,'package.json'),'utf8'));}catch{continue;}
    if(manifest.name!=='airoom'||!await exists(path.join(root,rel,'src')))continue;
    for(const suffix of ['node_modules','dist','.npm-cache','.electron-cache','.builder-cache','.builder-temp','.electron-temp','.runtime-temp','release/win-unpacked'])await add(path.join(rel,suffix),options.buildDays,'历史项目副本中可重新生成的依赖或构建产物');
  }
  return candidates.filter((c,i,all)=>!all.some((parent,j)=>i!==j&&within(path.join(root,parent.path),path.join(root,c.path))));
}

export async function planCleanup(input,options={}){
  const root=await validateRoot(input),now=options.now??Date.now(),settings={tempDays:1,cacheDays:14,buildDays:2,...options};
  for(const field of ['tempDays','cacheDays','buildDays'])if(!Number.isFinite(settings[field])||settings[field]<1)throw new Error('保留天数必须至少为1天。');
  const processes=settings.processes??runningProcesses(),tracked=trackedFiles(root);
  const plan={version:1,root,at:new Date(now).toISOString(),settings:{tempDays:settings.tempDays,cacheDays:settings.cacheDays,buildDays:settings.buildDays},candidates:[],files:[],directories:[],preserved:[],skipped:[],duplicateInstallers:[]};
  for(const candidate of await discover(root,settings)){
    const absolute=path.join(root,candidate.path),busy=activity(processes,root,absolute);let latest=0;
    const files=[],directories=[],links=[];
    await walk(absolute,async(rel,s)=>{latest=Math.max(latest,newest(s));const file=slash(path.join(candidate.path,rel));if(s.isSymbolicLink())links.push(file);else if(s.isDirectory())directories.push(file);else if(s.isFile())files.push({path:file,bytes:s.size,fingerprint:fingerprint(s),record:recordFile(rel)||tracked.has(key(file))});});
    if(busy.length||latest>now-candidate.days*DAY){plan.skipped.push({path:candidate.path,reason:busy.length?'有活动进程':'尚未过期',busy});continue;}
    plan.candidates.push(candidate);plan.skipped.push(...links.map(file=>({path:file,reason:'链接或联接，未跟随、未删除'})));
    plan.files.push(...files.filter(f=>!f.record||candidate.reason==='便携版测试解压残留'&&path.basename(f.path)==='app-64.7z').map(({record,...file})=>({...file,candidate:candidate.path})));
    plan.preserved.push(...files.filter(f=>f.record&&!(candidate.reason==='便携版测试解压残留'&&path.basename(f.path)==='app-64.7z')).map(({record,...file})=>file));plan.directories.push(...directories);
  }
  // Only byte-identical portable backups are redundant; all unique installers remain.
  const keep=[];
  for(const entry of await entries(path.join(root,'release')))if(entry.isFile()&&/^AIROOM.*\.exe$/i.test(entry.name))keep.push(slash(path.join('release',entry.name)));
  const rollback=path.join(root,'release/rollback');if(await exists(rollback))await walk(rollback,async(rel,s)=>{if(s.isFile()&&/\.exe$/i.test(rel))keep.push(slash(path.join('release/rollback',rel)));});
  const hashes=new Map();for(const rel of keep){try{const {target}=await safePath(root,rel);const digest=await hash(target);if(!hashes.has(digest))hashes.set(digest,rel);}catch(e){plan.skipped.push({path:rel,reason:e.message});}}
  const backupRoots=[];
  for(const e of await entries(path.join(root,'release')))if(/^[a-z][a-z0-9-]*-[a-f0-9]{7,40}$/i.test(e.name)&&!e.isSymbolicLink())backupRoots.push(path.join('release',e.name,'release'));
  for(const e of await entries(path.join(root,'.test-cache')))if(/-baseline-[a-f0-9]{7,40}$/i.test(e.name)&&!e.isSymbolicLink())backupRoots.push(path.join('.test-cache',e.name));
  for(const rel of backupRoots)for(const entry of await entries(path.join(root,rel))){
    if(!entry.isFile()||!/^AIROOM.*\.exe$/i.test(entry.name))continue;
    const file=slash(path.join(rel,entry.name)),s=await fs.lstat(path.join(root,file));
    if(newest(s)>now-settings.buildDays*DAY||tracked.has(key(file))||activity(processes,root,path.join(root,file)).length)continue;
    const digest=await hash(path.join(root,file)),retained=hashes.get(digest);
    if(retained){const item={path:file,bytes:s.size,fingerprint:fingerprint(s),sha256:digest,retained};plan.files.push(item);plan.duplicateInstallers.push(item);}
  }
  plan.bytes=plan.files.reduce((sum,f)=>sum+f.bytes,0);return plan;
}

export async function applyCleanup(plan,options={}){
  const root=await validateRoot(plan.root);if(plan.version!==1)throw new Error('清理计划格式无效。');
  const tracked=trackedFiles(root),allowed=await discover(root,plan.settings);
  let processes=options.processes??runningProcesses(),lastProcessRead=Date.now();
  const blocked=new Set(plan.candidates.filter(c=>activity(processes,root,path.join(root,c.path)).length).map(c=>c.path));
  const result={status:'complete',deleted:[],skipped:[],errors:[],bytes:0,removedEmptyDirectories:0};let cursor=0;
  const worker=async()=>{while(cursor<plan.files.length){
    if(options.shouldStop?.()){result.status='interrupted';return;}
    const file=plan.files[cursor++];
    try{
      if(!options.processes&&Date.now()-lastProcessRead>10000){processes=runningProcesses();lastProcessRead=Date.now();}
      const candidate=allowed.find(c=>c.path===file.candidate&&within(path.join(root,c.path),path.resolve(root,file.path)));
      const validDuplicate=file.retained&&/^(?:release\/[^/]+-[a-f0-9]{7,40}\/release|\.test-cache\/[^/]+-baseline-[a-f0-9]{7,40})\/AIROOM[^/]*\.exe$/i.test(file.path)&&/^release\/(?:AIROOM[^/]*\.exe|rollback\/.+\.exe)$/i.test(file.retained);
      const generatedArchive=candidate?.reason==='便携版测试解压残留'&&path.basename(file.path)==='app-64.7z';
      if(!candidate&&!validDuplicate||candidate&&recordFile(path.relative(candidate.path,file.path))&&!generatedArchive)throw new Error('文件不在允许删除范围内');
      if(tracked.has(key(file.path))||blocked.has(file.candidate)||activity(processes,root,path.join(root,file.path)).length){result.skipped.push({path:file.path,reason:'文件受保护或正在使用'});continue;}
      const {target,stat}=await safePath(root,file.path);
      if(!stat.isFile()||fingerprint(stat)!==file.fingerprint){result.skipped.push({path:file.path,reason:'预览后已发生变化'});continue;}
      if(file.retained){const retained=await safePath(root,file.retained);if(await hash(retained.target)!==file.sha256||await hash(target)!==file.sha256)throw new Error('重复备份的保留副本已经变化');}
      const final=await safePath(root,file.path);if(fingerprint(final.stat)!==file.fingerprint){result.skipped.push({path:file.path,reason:'删除前文件已经变化'});continue;}
      await fs.unlink(target);result.deleted.push(file.path);result.bytes+=file.bytes;
      if(result.deleted.length%5000===0)options.progress?.(result.deleted.length,result.bytes);
    }catch(e){if(e.code==='ENOENT')result.skipped.push({path:file.path,reason:'文件已不存在'});else result.errors.push({path:file.path,reason:e.message});}
  }};
  await Promise.all(Array.from({length:8},worker));
  if(result.status!=='interrupted')for(const relative of [...new Set(plan.directories)].sort((a,b)=>b.length-a.length)){
    try{const candidate=allowed.find(c=>relative===c.path||within(path.join(root,c.path),path.resolve(root,relative)));if(!candidate||recordFile(path.relative(candidate.path,relative))||blocked.has(candidate.path)||activity(processes,root,path.join(root,relative)).length)continue;const {target,stat}=await safePath(root,relative);if(stat.isDirectory()){await fs.rmdir(target);result.removedEmptyDirectories++;}}catch(e){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(e.code))result.skipped.push({path:relative,reason:e.message});}
  }
  // Retained evidence must still have its original content/metadata. It is never a deletion target.
  for(const file of plan.preserved){try{const {stat}=await safePath(root,file.path);if(fingerprint(stat)!==file.fingerprint)result.errors.push({path:file.path,reason:'保留记录在清理期间发生变化'});}catch(e){result.errors.push({path:file.path,reason:e.message});}}
  if(result.errors.length)result.status='partial';return result;
}

export async function main(args=process.argv.slice(2)){
  const options={},defaultRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');let root=defaultRoot,apply=false;
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(arg==='--apply')apply=true;
    else if(arg==='--preview')apply=false;
    else if(arg==='--root'){
      const value=args[++i];if(!value||value.startsWith('--'))throw new Error('--root 后必须提供完整项目目录。');root=value;
    }else if(['--temp-days','--cache-days','--build-days'].includes(arg)){
      options[{'--temp-days':'tempDays','--cache-days':'cacheDays','--build-days':'buildDays'}[arg]]=Number(args[++i]);
    }else if(arg==='--help'){
      console.log('node scripts/cleanup-project.mjs [--preview | --apply] [--root 项目目录] [--temp-days 1] [--build-days 2] [--cache-days 14]\n默认只预览。保留测试、交接、日志、截图、结果文件、唯一安装包及全部根目录回退包。');return 0;
    }else throw new Error('未知参数：'+arg);
  }
  root=await validateRoot(root);
  const reports=path.join(root,'.test-cache/cleanup-records');
  for(const relative of ['.test-cache','.test-cache/cleanup-records']){const target=path.join(root,relative),s=await exists(target);if(s&&(s.isSymbolicLink()||!s.isDirectory()||!same(await fs.realpath(target),target)))throw new Error('清理记录路径不能经过链接或联接。');}
  await fs.mkdir(reports,{recursive:true});
  if(!same(await fs.realpath(reports),reports))throw new Error('清理记录目录不能是链接或联接。');
  const lock=path.join(reports,'.running.lock');let handle;
  try{handle=await fs.open(lock,'wx');}catch(e){if(e.code==='EEXIST')throw new Error('已有清理任务或未完成的锁文件；本次没有删除文件。');throw e;}
  const reportDir=path.join(reports,new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8));await fs.mkdir(reportDir);
  let stopped=false;const stop=()=>{stopped=true;};process.on('SIGINT',stop);
  try{
    await handle.writeFile(JSON.stringify({pid:process.pid,started:new Date().toISOString()}));
    const plan=await planCleanup(root,options);await fs.writeFile(path.join(reportDir,'plan.json'),JSON.stringify(plan,null,2));
    console.log(`${apply?'执行清理':'仅预览'}：${root}\n候选 ${plan.files.length} 个文件，共 ${(plan.bytes/2**30).toFixed(2)} GiB；保留 ${plan.preserved.length} 个记录文件。\n清单：${reportDir}`);
    let result={status:'preview',bytes:0,deleted:[],skipped:[],errors:[]};
    if(apply)result=await applyCleanup(plan,{shouldStop:()=>stopped,progress:(count,bytes)=>console.log(`已删除 ${count} 个文件，${(bytes/2**30).toFixed(2)} GiB。`)});
    await fs.writeFile(path.join(reportDir,'result.json'),JSON.stringify(result,null,2));
    await fs.writeFile(path.join(reportDir,'报告.md'),`# AIROOM 项目清理记录\n\n时间：${new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'medium'}).format(new Date())}（北京时间）\n\n项目：${root}\n\n状态：${result.status}\n\n候选：${plan.files.length} 个文件，${(plan.bytes/2**30).toFixed(2)} GiB。实际删除：${result.deleted.length} 个文件，${(result.bytes/2**30).toFixed(2)} GiB（文件大小合计）。\n\n测试代码、交接资料、日志、截图、结果文件、唯一安装包及根目录 rollback 均保留；链接不跟随，项目外目录不清理。完整清单见 plan.json；删除、跳过和失败记录见 result.json。\n`);
    console.log(apply?`清理结果：${result.status}，删除 ${result.deleted.length} 个文件，共 ${(result.bytes/2**30).toFixed(2)} GiB。`:'预览完成，未删除文件。加 --apply 才执行清理。');
    return result.status==='partial'?1:result.status==='interrupted'?130:0;
  }finally{process.removeListener('SIGINT',stop);await handle.close();const checked=await safePath(root,path.relative(root,lock));await fs.unlink(checked.target);}
}
if(process.argv[1]&&same(process.argv[1],fileURLToPath(import.meta.url)))main().then(code=>{process.exitCode=code;}).catch(e=>{console.error('清理停止：'+e.message);process.exitCode=1;});
