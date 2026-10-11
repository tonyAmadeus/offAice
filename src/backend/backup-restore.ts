import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { renameWithWindowsRetry as rename } from './filesystem';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveSafePath } from './security';
import type { BackupEntry, BackupManifest, BackupPreview, RestorePreview, RestoreResult } from '../shared/backup';

const VALID_ID=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/;
const PAYLOAD=['airoom.sqlite','assets','attachments'];
// Logins belong to this computer, not to the backup's date. Never move them
// during replacement or rollback; native session references are cleared instead.
const LOCAL_LOGIN=['native','secrets','deepseek.secret'];
const REPLACED=[...PAYLOAD,'airoom.sqlite-wal','airoom.sqlite-shm'];
// Older builds may have moved logins before dying. Accept those journals and
// recover a missing login, without ever replacing a currently present one.
const JOURNAL_NAMES=[...REPLACED,...LOCAL_LOGIN];
const STAGE_LIFETIME=30*60_000;
const exists=async(file:string)=>{try{await lstat(file);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}};

export function backupDirectory(dataDirectory:string){return path.join(path.dirname(path.resolve(dataDirectory)),'backups');}
type RestoreJournal={dataDirectory:string;stage:string;rollback:string;original:string[];payload:string[];phase:'replacing'|'committed'};
function journalPath(dataDirectory:string){return path.join(path.dirname(dataDirectory),`.restore-journal-${createHash('sha256').update(dataDirectory.toLowerCase()).digest('hex').slice(0,20)}.json`);}
async function saveJournal(file:string,journal:RestoreJournal){const temporary=file+'.tmp';await writeFile(temporary,JSON.stringify(journal),'utf8');await rename(temporary,file,{replaceExisting:true});}
export class RestoreFailure extends Error{constructor(message:string,readonly requiresRepair=false){super(message);}}
/** A killed process may leave a multi-file replacement incomplete. Recover the
 * previous payload before opening SQLite or starting any native member. */
export async function recoverInterruptedRestore(dataDirectory:string){
  dataDirectory=path.resolve(dataDirectory);const file=journalPath(dataDirectory);if(!await exists(file))return;
  const journal=JSON.parse(await readFile(file,'utf8')) as RestoreJournal,parent=path.dirname(dataDirectory);
  if(journal.dataDirectory!==dataDirectory||typeof journal.rollback!=='string'||path.dirname(journal.rollback)!==parent||!/^\.restore-rollback-[a-f0-9-]{36}$/.test(path.basename(journal.rollback))||typeof journal.stage!=='string'||path.dirname(journal.stage)!==path.join(parent,'.restore-previews')||!/^[a-f0-9-]{36}$/.test(path.basename(journal.stage))||!Array.isArray(journal.original)||!Array.isArray(journal.payload)||journal.original.some(name=>!JOURNAL_NAMES.includes(name))||journal.payload.some(name=>!PAYLOAD.includes(name)))throw new RestoreFailure('恢复现场的路径不完整，请保留恢复记录后再启动。',true);
  const safeRollback=resolveSafePath(parent,path.relative(parent,journal.rollback));
  if(journal.phase!=='replacing'&&journal.phase!=='committed')throw new RestoreFailure('恢复现场的状态无法核对，请保留记录。',true);
  const recoverLocalLogin=async()=>{
    for(const name of LOCAL_LOGIN){
      if(!journal.original.includes(name))continue;
      const current=path.join(dataDirectory,name);
      if(await exists(current))continue;
      const previous=resolveSafePath(safeRollback,name);
      if(await exists(previous))await rename(previous,resolveSafePath(dataDirectory,name));
    }
  };
  if(journal.phase==='committed'){await recoverLocalLogin();await rm(file,{force:true});return;}
  for(const name of [...REPLACED].reverse()){
    const original=path.join(safeRollback,name),current=resolveSafePath(dataDirectory,name);
    if(await exists(original)){
      if(await exists(current))await rename(current,path.join(safeRollback,`uncommitted-${name}`));
      await rename(original,current);
    }else if(!journal.original.includes(name)&&journal.payload.includes(name)&&!await exists(path.join(journal.stage,name))&&await exists(current))await rename(current,path.join(safeRollback,`uncommitted-${name}`));
  }
  await recoverLocalLogin();
  await rm(file,{force:true});
}
async function digest(file:string){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
function payloadPath(value:string){
  return value==='airoom.sqlite'||/^(?:assets|attachments)\//.test(value)&&!value.split('/').some(part=>!part||part==='.'||part==='..')&&!/[\\:\0]/.test(value);
}
function manifestOf(value:unknown):BackupManifest{
  const item=value as BackupManifest;
  if(!item||item.formatVersion!==1||!['deploy','manual','before-restore'].includes(item.reason)||!Number.isFinite(Date.parse(item.createdAt))||!Array.isArray(item.files)||item.files.length>200000)throw new Error('备份格式不受支持或内容清单不完整。');
  if(typeof item.createdAt!=='string'||item.appVersion!==undefined&&typeof item.appVersion!=='string'||item.sourceCommit!==undefined&&typeof item.sourceCommit!=='string')throw new Error('备份版本或时间记录无效。');
  const seen=new Set<string>();
  for(const file of item.files){
    if(!file||typeof file.path!=='string'||!payloadPath(file.path)||!Number.isSafeInteger(file.size)||file.size<0||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(file.sha256)||seen.has(file.path.toLowerCase()))throw new Error('备份含无效、重复或越界的文件记录。');
    seen.add(file.path.toLowerCase());
  }
  if(!seen.has('airoom.sqlite')||!item.counts||Object.values(item.counts).some(count=>!Number.isSafeInteger(count)||count<0))throw new Error('备份缺少数据库或数量记录。');
  for(const key of ['threads','messages','members','sessions','runs'] as const)if(!Number.isSafeInteger(item.counts[key]))throw new Error('备份数量记录不完整。');
  return item;
}
async function checkedRoot(root:string){await mkdir(root,{recursive:true});if((await lstat(root)).isSymbolicLink())throw new Error('备份目录不能是链接，请先核对存储位置。');return root;}
async function readManifest(directory:string){
  const file=resolveSafePath(directory,'manifest.json');
  if((await lstat(file)).isSymbolicLink()||(await stat(file)).size>32*1024*1024)throw new Error('备份清单异常，未读取。');
  return manifestOf(JSON.parse(await readFile(file,'utf8')));
}
async function checkedFile(root:string,relative:string){
  const file=resolveSafePath(root,relative);
  let current=root;
  for(const segment of relative.split('/')){current=path.join(current,segment);if((await lstat(current)).isSymbolicLink())throw new Error('备份文件包含链接，未恢复。');}
  if(!(await lstat(file)).isFile())throw new Error(`备份文件不存在或不是文件：${relative}`);
  return file;
}
async function verifyFiles(root:string,files:BackupManifest['files']){
  for(const file of files){const target=await checkedFile(root,file.path);if((await stat(target)).size!==file.size||await digest(target)!==file.sha256.toLowerCase())throw new Error(`备份文件校验失败：${file.path}。当前数据没有被替换。`);}
}
function inspectDatabase(file:string){
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    const check=db.prepare('PRAGMA quick_check').all() as Record<string,string>[];
    if(check.length!==1||Object.values(check[0])[0]!=='ok')throw new Error('备份数据库完整性检查失败。');
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('entities','events')").all();
    if(tables.length!==2||db.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger','view')").all().length)throw new Error('备份数据库结构与当前版本不兼容。');
    const rows=db.prepare('SELECT entity,id,value FROM entities').all() as {entity:string;id:string;value:string}[];
    const counts={threads:0,messages:0,members:0,sessions:0,runs:0},memberNames:string[]=[];let historyOnlySessions=0;
    const countKeys:Record<string,keyof typeof counts>={room_threads:'threads',room_messages:'messages',members:'members',sessions:'sessions',runs:'runs'};
    const identified=new Set(['projects','sessions','runs','members','room_threads','room_messages','approvals','timed_jobs','timed_occurrences','collaborations','executors']);
    for(const row of rows){
      const value=JSON.parse(row.value);if(!value||typeof value!=='object')throw new Error('备份中的记录格式不完整。');
      if(identified.has(row.entity)&&(typeof value.id!=='string'||value.id!==row.id))throw new Error('备份中的记录编号不完整，请保留原备份。');
      if(countKeys[row.entity])counts[countKeys[row.entity]]++;
      if(row.entity==='members'&&typeof value.name==='string')memberNames.push(value.name);
      if(row.entity==='sessions')historyOnlySessions++;
    }
    db.prepare('SELECT id,session_id,run_id,value FROM events LIMIT 1').all();
    return {counts,memberNames,historyOnlySessions};
  }finally{db.close();}
}
function sanitizeRestoredDatabase(file:string,targetDirectory:string,backupId:string){
  const db=new DatabaseSync(file),at=new Date().toISOString();
  try{
    db.exec('BEGIN IMMEDIATE');
    const rows=db.prepare('SELECT entity,id,value FROM entities').all() as {entity:string;id:string;value:string}[];
    const update=db.prepare('UPDATE entities SET value=? WHERE entity=? AND id=?');
    const roomProjects=new Set(rows.filter(row=>row.entity==='projects'&&JSON.parse(row.value).kind==='lounge').map(row=>row.id));
    const removedEntities=new Set(['providers','quotas','room_sessions','blocked_sessions','automatic_reservations','workspace_conflicts']);
    for(const row of rows){
      let value=JSON.parse(row.value);
      if(removedEntities.has(row.entity)){db.prepare('DELETE FROM entities WHERE entity=? AND id=?').run(row.entity,row.id);continue;}
      if(row.entity==='sessions'){
        const {nativeId:_native,nativeHome:_home,workspace:_workspace,workspaceKind:_kind,workspaceSource:_source,...rest}=value;
        value={...rest,restoredHistoryOnly:!roomProjects.has(value.projectId),updatedAt:at};
      }else if(row.entity==='runs'){
        if(!value.completedAt&&['queued','running','waiting_user','rate_limited','stopping'].includes(value.status))value={...value,status:['sent','confirmed','unknown'].includes(value.delivery)?'unknown':'interrupted',completedAt:at,updatedAt:at,error:'备份恢复后保留为历史，未自动重发。'};
        if(value.workspaceUndo)value.workspaceUndo={status:'unavailable',reason:'备份不包含工作副本和还原点，本记录仅供查看。'};
      }else if(row.entity==='roundtable_topics')value={...value,status:'ended',archivedAt:value.archivedAt??at,restoredHistoryOnly:true,error:'备份不包含圆桌工作副本，保留议题和真实讨论记录，只供阅读。'};
      else if(row.entity==='flow_joint_reviews')value={...value,status:'cancelled',dispatchMode:'paused',error:'备份恢复后只保留历史；未自动继续评审，工作副本不在备份内。'};
      else if(row.entity==='collaborations')value={...value,status:'paused',stage:'备份恢复后仅保留协作记录，请明确新建任务。',restoredHistoryOnly:true};
      else if(row.entity==='workflows'){const {workspaceResult:_result,...rest}=value;value=rest;}
      else if(row.entity==='approvals'&&value.state==='pending')value={...value,state:'expired'};
      else if(row.entity==='outbox'&&['prepared','sent'].includes(value.delivery))value={...value,delivery:value.delivery==='prepared'&&value.kind!=='steer'?'withdrawn':'unknown',updatedAt:at};
      else if(row.entity==='settings'&&row.id==='main')value={...value,automationPolicies:Object.fromEntries(Object.entries(value.automationPolicies??{}).map(([key,policy])=>[key,{...(policy as object),enabled:false}]))};
      else if(row.entity==='timed_jobs')value={...value,enabled:false,pausedReason:'备份恢复后未自动启用，请核对后重新设置。'};
      else if(row.entity==='timed_occurrences'&&value.status==='running')value={...value,status:'unknown',finishedAt:at,reason:'备份恢复后未自动重发。'};
      else if(row.entity==='room_states'||row.entity==='room'&&row.id==='state')value={...value,active:false,speaking:undefined,compressing:undefined,generatingImage:undefined,...(value.discussion?{discussion:{...value.discussion,phase:row.id.startsWith('roundtable:')?'idle':'paused',pausedByUser:true,mentionQueue:[],workWaiting:false,proposal:undefined,handRound:undefined,meetingMinutes:undefined,reason:'已恢复话题记录，等待明确新话题；未自动继续原讨论。'}}:{})};
      else if(row.entity==='room_messages'&&value.status==='speaking')value={...value,status:'failed',text:'',error:'这条发言在备份时未结束，恢复后未重发。'};
      else if(row.entity==='projects'){value={...value,collaborationPaused:true,...(value.kind==='roundtable'?{directory:path.join(targetDirectory,'roundtable',value.id.replace(/^roundtable-/,''),'material')}:value.kind==='lounge'?{directory:path.join(targetDirectory,value.roomId&&value.roomId!=='global'?path.join('lounges',`room-lounge-${createHash('sha256').update(value.roomId).digest('hex').slice(0,24)}`):'lounge')}:{})};}
      update.run(JSON.stringify(value),row.entity,row.id);
    }
    db.prepare('INSERT INTO entities(entity,id,value) VALUES(?,?,?) ON CONFLICT(entity,id) DO UPDATE SET value=excluded.value').run('automation_state','main',JSON.stringify({paused:true,at}));
    db.prepare('INSERT INTO entities(entity,id,value) VALUES(?,?,?) ON CONFLICT(entity,id) DO UPDATE SET value=excluded.value').run('restore_info','main',JSON.stringify({at,backupId,historyOnly:true}));
    db.exec('COMMIT');
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
}

type Preparation={preview:RestorePreview;directory:string;files:BackupManifest['files']};
export class BackupRestorer{
  private pending=new Map<string,Preparation>();
  readonly root:string;
  constructor(readonly dataDirectory:string){this.dataDirectory=path.resolve(dataDirectory);this.root=backupDirectory(this.dataDirectory);}
  private async source(id:string){if(!VALID_ID.test(id)||id==='.'||id==='..')throw new Error('备份编号无效。');await checkedRoot(this.root);const source=resolveSafePath(this.root,id);if((await lstat(source)).isSymbolicLink()||!(await stat(source)).isDirectory())throw new Error('备份目录无效。');return source;}
  async list():Promise<BackupEntry[]>{
    await checkedRoot(this.root);const entries:BackupEntry[]=[];
    for(const item of await readdir(this.root,{withFileTypes:true})){
      if(!item.isDirectory()||!VALID_ID.test(item.name)||item.name.startsWith('.'))continue;
      try{const manifest=await readManifest(await this.source(item.name));entries.push({id:item.name,manifest,bytes:manifest.files.reduce((sum,file)=>sum+file.size,0)});}catch(error){entries.push({id:item.name,bytes:0,error:error instanceof Error?error.message:String(error)});}
    }
    return entries.sort((a,b)=>(b.manifest?.createdAt??b.id).localeCompare(a.manifest?.createdAt??a.id));
  }
  async preview(id:string):Promise<BackupPreview>{
    const source=await this.source(id),manifest=await readManifest(source);await verifyFiles(source,manifest.files);
    const details=inspectDatabase(path.join(source,'airoom.sqlite'));
    for(const key of Object.keys(details.counts) as (keyof typeof details.counts)[])if(details.counts[key]!==manifest.counts[key])throw new Error('备份数量与数据库不一致，请核对备份清单。');
    return {id,manifest,bytes:manifest.files.reduce((sum,file)=>sum+file.size,0),memberNames:details.memberNames,historyOnlySessions:details.historyOnlySessions};
  }
  assertRemovable(id:string){
    if([...this.pending.values()].some(entry=>entry.preview.backup.id===id))throw new Error('这份备份正在准备恢复，请先取消恢复。');
  }
  async remove(id:string):Promise<{deleted:true}>{
    this.assertRemovable(id);
    const directory=await this.source(id);
    if(path.dirname(path.resolve(directory))!==path.resolve(this.root))throw new Error('备份删除路径无效。');
    // Check every descendant before deletion. A junction must never lead deletion outside this backup.
    const inspect=async(folder:string):Promise<void>=>{
      for(const entry of await readdir(folder,{withFileTypes:true})){
        const file=resolveSafePath(directory,path.relative(directory,path.join(folder,entry.name))),info=await lstat(file);
        if(info.isSymbolicLink())throw new Error('备份含目录或文件链接，未删除，请先核对存储位置。');
        if(info.isDirectory())await inspect(file);else if(!info.isFile())throw new Error('备份含不支持的文件，未删除。');
      }
    };
    await inspect(directory);
    await rm(directory,{recursive:true,force:false});
    return {deleted:true};
  }
  async prepare(id:string):Promise<RestorePreview>{
    const backup=await this.preview(id),source=await this.source(id),stageRoot=path.join(path.dirname(this.dataDirectory),'.restore-previews');await checkedRoot(stageRoot);
    const token=randomUUID(),directory=resolveSafePath(stageRoot,token);await mkdir(directory);
    try{
      for(const file of backup.manifest.files){const target=resolveSafePath(directory,file.path);await mkdir(path.dirname(target),{recursive:true});await copyFile(await checkedFile(source,file.path),target);}
      await verifyFiles(directory,backup.manifest.files);inspectDatabase(path.join(directory,'airoom.sqlite'));
      sanitizeRestoredDatabase(path.join(directory,'airoom.sqlite'),this.dataDirectory,id);
      const files=[];for(const file of backup.manifest.files){const target=path.join(directory,file.path);files.push({...file,size:(await stat(target)).size,sha256:await digest(target)});}
      const preview={token,backup,expiresAt:new Date(Date.now()+STAGE_LIFETIME).toISOString()};this.pending.set(token,{preview,directory,files});return preview;
    }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
  }
  private preparation(token:string){const entry=this.pending.get(token);if(!entry||Date.parse(entry.preview.expiresAt)<Date.now())throw new Error('恢复预览已过期，请重新选择并校验备份。');return entry;}
  async verifyPrepared(token:string){const entry=this.preparation(token);await verifyFiles(entry.directory,entry.files);inspectDatabase(path.join(entry.directory,'airoom.sqlite'));return entry.preview;}
  async cancel(token:string){const entry=this.pending.get(token);if(!entry)return;this.pending.delete(token);await rm(entry.directory,{recursive:true,force:true});}
  /** Caller must close the execution worker and create a before-restore backup first. */
  async apply(token:string,beforeBackupId:string,move=rename):Promise<RestoreResult>{
    const entry=this.preparation(token);await this.verifyPrepared(token);
    const before=await this.preview(beforeBackupId);if(before.manifest.reason!=='before-restore')throw new Error('替换前的当前数据备份尚未确认，未开始恢复。');
    await checkedRoot(this.dataDirectory);
    const parent=path.dirname(this.dataDirectory),rollbackDirectory=path.join(parent,`.restore-rollback-${randomUUID()}`);await mkdir(rollbackDirectory);
    const old:string[]=[],installed:string[]=[],file=journalPath(this.dataDirectory);
    if(await exists(file))throw new RestoreFailure('上一份恢复现场尚未核对，请先重新启动工作台。',true);
    const original=[];for(const name of REPLACED)if(await exists(path.join(this.dataDirectory,name)))original.push(name);
    const payload=[];for(const name of PAYLOAD)if(await exists(path.join(entry.directory,name)))payload.push(name);
    const journal:RestoreJournal={dataDirectory:this.dataDirectory,stage:entry.directory,rollback:rollbackDirectory,original,payload,phase:'replacing'};
    await saveJournal(file,journal);
    try{
      for(const name of REPLACED){const source=resolveSafePath(this.dataDirectory,name);if(!await exists(source))continue;if((await lstat(source)).isSymbolicLink())throw new Error('当前数据包含目录链接，请先核对后再恢复。');await move(source,path.join(rollbackDirectory,name));old.push(name);}
      for(const name of PAYLOAD){const source=path.join(entry.directory,name);if(!await exists(source))continue;await move(source,resolveSafePath(this.dataDirectory,name));installed.push(name);}
      await mkdir(path.join(this.dataDirectory,'lounge'),{recursive:true});
      await saveJournal(file,{...journal,phase:'committed'});
    }catch(error){
      const failures:unknown[]=[];
      for(const name of [...installed].reverse())try{await rename(path.join(this.dataDirectory,name),path.join(entry.directory,name));}catch(e){failures.push(e);}
      for(const name of [...old].reverse())try{await rename(path.join(rollbackDirectory,name),path.join(this.dataDirectory,name));}catch(e){failures.push(e);}
      if(failures.length)throw new RestoreFailure(`恢复没有完成，自动回退也未全部完成。旧数据保存在 ${rollbackDirectory}，请保留现场。`,true);
      await rm(file,{force:true});
      throw new RestoreFailure(`恢复没有完成，当前数据已恢复原状：${error instanceof Error?error.message:String(error)}`);
    }
    await rm(file,{force:true}).catch(()=>{});
    this.pending.delete(token);await rm(entry.directory,{recursive:true,force:true}).catch(()=>{});
    return {restored:true,beforeBackupId,rollbackDirectory,detail:'已恢复聊天与人物资料，当前成员登录已保留。旧项目会话仅供查看，请新建任务；自动功能保持暂停。'};
  }
}
