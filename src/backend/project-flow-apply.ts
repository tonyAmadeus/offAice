import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Store } from './store';
import {assertProjectPaths,withProjectWrite,captureProjectBoundary,assertProjectBoundary} from './project-access';
import { resolveSafePath } from './security';
import { FlowArtifacts } from './project-flow-artifacts';
import { FlowError, type FlowArtifact } from '../shared/project-flow';

interface ApplyFile { path:string; before?:string; after?:string; applied:boolean }
export interface ApplyJournal { writeBoundary?:import('../shared/types').WriteBoundary;id:string; projectId:string; acceptanceId:string; artifactId:string; directory:string; state:'applying'|'applied'|'conflict'|'recovery_required'; files:ApplyFile[]; conflicts:{path:string;reason:string}[]; error?:string; at:string }
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function fileHash(root:string,name:string){try{return hash(await fs.readFile(resolveSafePath(root,name)));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}}
/** Persist the intent before touching files. A mixed disk state requires an explicit recovery call. */
export class FlowApply {
  private locked=new Set<string>();
  constructor(private store:Store,private artifacts:FlowArtifacts){for(const j of store.list<ApplyJournal>('flow_apply_journals'))if(j.state==='applying')store.put('flow_apply_journals',j.id,{...j,state:'recovery_required',error:'写入中断，需核对磁盘结果。'});}
  async apply(acceptanceId:string,artifact:FlowArtifact,directory:string):Promise<ApplyJournal>{assertProjectBoundary(this.store,artifact.projectId,this.store.get<{writeBoundary?:import('../shared/types').WriteBoundary}>('project_flows',artifact.flowId)?.writeBoundary);return withProjectWrite(this.store,artifact.projectId,directory,check=>this.applyReserved(acceptanceId,artifact,directory,check));}
  private async applyReserved(acceptanceId:string,artifact:FlowArtifact,directory:string,check:()=>void):Promise<ApplyJournal>{
    if(this.locked.has(artifact.projectId)||this.store.list<ApplyJournal>('flow_apply_journals').some(j=>j.projectId===artifact.projectId&&['applying','recovery_required'].includes(j.state)))throw new FlowError('RECOVERY_REQUIRED','项目还有未核对的应用操作。');
    this.locked.add(artifact.projectId);
    try{
      if(!artifact.baseArtifactId)throw new FlowError('INVALID_BASE','整合成果缺少项目基线。');
      const before=await this.artifacts.manifest(this.artifacts.get(artifact.baseArtifactId).root),after=await this.artifacts.manifest(artifact.root);const changes=this.artifacts.delta(before,after);assertProjectPaths(this.store,artifact.projectId,changes.map(c=>c.path));const files:ApplyFile[]=[],conflicts:ApplyJournal['conflicts']=[];
      for(const c of changes){const current=await fileHash(directory,c.path);if(current!==before[c.path]&&current!==after[c.path])conflicts.push({path:c.path,reason:'项目文件在检查点建立后发生了变化。'});files.push({path:c.path,before:current,after:after[c.path],applied:current===after[c.path]});}
      check();const journal:ApplyJournal={id:acceptanceId,acceptanceId,projectId:artifact.projectId,artifactId:artifact.id,directory,writeBoundary:captureProjectBoundary(this.store,artifact.projectId),state:conflicts.length?'conflict':'applying',files,conflicts,at:new Date().toISOString()};this.store.put('flow_apply_journals',journal.id,journal);if(conflicts.length)return journal;return await this.write(journal,artifact,check);
    }finally{this.locked.delete(artifact.projectId);}
  }
  async recover(id:string,mode:'reconcile'|'continue'):Promise<ApplyJournal>{const j=this.store.get<ApplyJournal>('flow_apply_journals',id);if(j?.state==='applied')return j;if(!j||j.state!=='recovery_required')throw new FlowError('NOT_FOUND','没有需要恢复的应用记录。');if(this.locked.has(j.projectId))throw new FlowError('RECOVERY_REQUIRED','正在核对这个项目。');assertProjectBoundary(this.store,j.projectId,j.writeBoundary);return withProjectWrite(this.store,j.projectId,j.directory,async check=>{this.locked.add(j.projectId);
    try{assertProjectPaths(this.store,j.projectId,j.files.map(f=>f.path));const artifact=this.artifacts.get(j.artifactId),conflicts:ApplyJournal['conflicts']=[];for(const f of j.files){const current=await fileHash(j.directory,f.path);if(current!==f.after&&current!==f.before)conflicts.push({path:f.path,reason:'中断后项目文件又被修改，不能自动覆盖。'});f.applied=current===f.after;}
      if(conflicts.length){const next={...j,conflicts,error:'中断后存在新的改动。'};this.store.put('flow_apply_journals',j.id,next);return next;}
      if(j.files.every(f=>f.applied)){const done={...j,state:'applied' as const,conflicts:[],error:undefined};this.store.put('flow_apply_journals',j.id,done);return done;}
      if(mode==='reconcile'){this.store.put('flow_apply_journals',j.id,j);return j;}return await this.write({...j,state:'applying',conflicts:[]},artifact,check);
    }finally{this.locked.delete(j.projectId);}});
  }
  private async write(j:ApplyJournal,artifact:FlowArtifact,check:()=>void):Promise<ApplyJournal>{
    try{
      check();assertProjectBoundary(this.store,j.projectId,j.writeBoundary);
      const actual=await import('./workspace').then(m=>m.workspaceFingerprint(artifact.root));if(actual!==artifact.fingerprint)throw new FlowError('STALE_VERSION','整合副本在应用前发生变化。');
      for(const f of j.files){if(f.applied)continue;check();assertProjectBoundary(this.store,j.projectId,j.writeBoundary);assertProjectPaths(this.store,j.projectId,[f.path]);const current=await fileHash(j.directory,f.path);if(current!==f.before&&current!==f.after)throw new FlowError('APPLY_CONFLICT','应用期间目标内容改变。');if(current===f.after){f.applied=true;continue;}
        this.store.put('flow_apply_journals',j.id,j);const target=resolveSafePath(j.directory,f.path);
        if(f.after===undefined){check();await fs.unlink(target);}else{await fs.mkdir(path.dirname(target),{recursive:true});resolveSafePath(j.directory,f.path);const temp=target+'.airoom-flow-'+j.id;const bytes=await fs.readFile(resolveSafePath(artifact.root,f.path));if(hash(bytes)!==f.after)throw new FlowError('STALE_VERSION','写入时成果内容改变。');await fs.writeFile(temp,bytes,{flag:'wx'}).catch(async error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST'||!(await fs.lstat(temp)).isFile()||hash(await fs.readFile(temp))!==f.after)throw error;});try{if(await fileHash(j.directory,f.path)!==f.before)throw new FlowError('APPLY_CONFLICT','写入前目标内容改变。');check();await fs.rename(temp,target);}finally{await fs.unlink(temp).catch(()=>{});}}
        f.applied=true;this.store.put('flow_apply_journals',j.id,j);
      }
      for(const f of j.files)if(await fileHash(j.directory,f.path)!==f.after)throw new FlowError('APPLY_CONFLICT','应用后的文件结果不一致。');j.state='applied';j.error=undefined;
    }catch(error){j.state='recovery_required';j.error=(error as Error).message;}
    this.store.put('flow_apply_journals',j.id,j);return j;
  }
}
