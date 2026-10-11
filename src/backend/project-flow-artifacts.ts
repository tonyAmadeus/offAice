import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workspaceFiles, workspaceFingerprint, readArtifact } from './workspace';
import { resolveSafePath } from './security';
import {withProjectSnapshot} from './project-access';
import {folderPath} from './folder-path';
import type { Store } from './store';
import { FlowError, type FlowArtifact, type FileChange, type VersionRef } from '../shared/project-flow';

export type Manifest=Record<string,string>;
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export class FlowArtifacts {
  constructor(private store:Store){}
  get(id:string){const item=this.store.get<FlowArtifact>('flow_artifacts',id);if(!item||item.status!=='ready')throw new FlowError('STALE_VERSION','成果副本尚未准备好或已清理。');const expected=path.join(this.store.dataDirectory,'workspaces','flow-'+id);if(!/^[0-9a-f-]{36}$/i.test(id)||path.resolve(item.root).toLowerCase()!==path.resolve(expected).toLowerCase())throw new FlowError('UNSAFE_ARTIFACT','无法核对成果副本归属。');resolveSafePath(path.join(this.store.dataDirectory,'workspaces'),'flow-'+id);return item;}
  version(item:FlowArtifact):VersionRef{return {artifactId:item.id,fingerprint:item.fingerprint,baselineId:item.baselineId};}
  async manifest(root:string):Promise<Manifest>{const result:Manifest={};let size=0;for(const item of await workspaceFiles(root)){size+=item.size;if(size>1024**3||item.size>128*1024**2)throw new FlowError('ARTIFACT_LIMIT','成果超过复制上限。');result[item.relativePath.replaceAll('\\','/')]=hash(await fs.readFile(resolveSafePath(root,item.relativePath)));}return result;}
  async changes(base:string,current:string):Promise<FileChange[]>{const before=await this.manifest(base),after=await this.manifest(current);return this.delta(before,after);}
  delta(before:Manifest,after:Manifest):FileChange[]{const changes:FileChange[]=[];for(const name of new Set([...Object.keys(before),...Object.keys(after)])){if(before[name]===after[name])continue;changes.push({path:name,kind:!after[name]?'deleted':!before[name]?'added':'modified'});}return changes;}
  async diff(before:FlowArtifact,after:FlowArtifact){const changes=await this.changes(before.root,after.root),parts:string[]=[];let remaining=40000;
    for(const change of changes){if(remaining<=0){parts.push('其余差异已截断，请逐个预览文件。');break;}let content:string;
      try{const old=change.kind==='added'?'':(await readArtifact(before.root,change.path)).content,next=change.kind==='deleted'?'':(await readArtifact(after.root,change.path)).content;content=`--- a/${change.path}\n+++ b/${change.path}\n@@ 内容版本对比 @@\n${old.split('\n').map(l=>'-'+l).join('\n')}\n${next.split('\n').map(l=>'+'+l).join('\n')}`;}catch(error){content=`${change.kind} ${change.path}：${(error as Error).message}`;}parts.push(content.slice(0,remaining));remaining-=content.length;
    }return {changes,text:parts.join('\n\n')||'两个版本的文件内容一致。'};
  }
  async capture(flow:{id:string;projectId:string},source:string,purpose:FlowArtifact['purpose'],baseArtifactId?:string,expected?:string,transient=false):Promise<FlowArtifact>{
    const project=this.store.get<{directory:string}>('projects',flow.projectId);
    if(project&&folderPath(source).key===folderPath(project.directory).key)return withProjectSnapshot(this.store,flow.projectId,project.directory,async check=>{const result=await this.captureCopy(flow,source,purpose,baseArtifactId,expected,transient);try{check();return result;}catch(error){await this.remove(result);throw error;}});
    return this.captureCopy(flow,source,purpose,baseArtifactId,expected,transient);
  }
  private async captureCopy(flow:{id:string;projectId:string},source:string,purpose:FlowArtifact['purpose'],baseArtifactId?:string,expected?:string,transient=false):Promise<FlowArtifact>{
    const id=randomUUID(),root=path.join(this.store.dataDirectory,'workspaces','flow-'+id),at=new Date().toISOString();
    const item:FlowArtifact={id,flowId:flow.id,projectId:flow.projectId,schemaVersion:1,revision:1,createdAt:at,updatedAt:at,purpose,root,fingerprint:'',baselineId:baseArtifactId??id,baseArtifactId,transient,status:'capturing'};
    this.store.put('flow_artifacts',id,item);await fs.mkdir(root,{recursive:true});
    try{
      const version=await workspaceFingerprint(source);if(expected&&version!==expected)throw new FlowError('STALE_VERSION','复制前成果版本已改变。');
      for(const file of await workspaceFiles(source)){const target=resolveSafePath(root,file.relativePath);await fs.mkdir(path.dirname(target),{recursive:true});resolveSafePath(root,file.relativePath);await fs.copyFile(resolveSafePath(source,file.relativePath),target);}
      // Preserve tracked ignored files, while subsequent build output follows the source ignore rules.
      if(await fs.stat(path.join(source,'.git')).then(()=>true,()=>false)){
        const exec=promisify(execFile);await exec('git',['init','--quiet','--template=',root],{windowsHide:true});await exec('git',['-C',root,'add','-f','--','.'],{windowsHide:true,maxBuffer:16*1024*1024});
      }
      if(await workspaceFingerprint(source)!==version||await workspaceFingerprint(root)!==version)throw new FlowError('STALE_VERSION','复制期间成果版本改变，未使用这个副本。');
      const baseline=baseArtifactId?await this.manifest(this.get(baseArtifactId).root):await this.manifest(root);
      await fs.mkdir(path.join(root,'.airoom'),{recursive:true});
      const project=this.store.get<{directory:string}>('projects',flow.projectId)!;
      await fs.writeFile(path.join(root,'.airoom','baseline.json'),JSON.stringify({directory:project.directory,files:baseline}));
      const ready={...item,fingerprint:version,status:'ready' as const};this.store.put('flow_artifacts',id,ready);return ready;
    }catch(error){await this.remove(item);throw error;}
  }
  async remove(item:FlowArtifact){const parent=await fs.realpath(path.join(this.store.dataDirectory,'workspaces'));const target=path.resolve(item.root);if(path.dirname(target)!==parent||!path.basename(target).startsWith('flow-'))throw new FlowError('UNSAFE_ARTIFACT','无法核对临时副本目录。');try{const actual=await fs.realpath(target);if(actual!==target)throw new FlowError('UNSAFE_ARTIFACT','临时副本目录包含链接。');await fs.rm(target,{recursive:true,force:true});}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}this.store.put('flow_artifacts',item.id,{...item,status:'removed',revision:item.revision+1});}
  async merge(target:string,source:FlowArtifact):Promise<{path:string;reason:string}[]>{
    if(!source.baseArtifactId)throw new FlowError('INVALID_BASE','提交缺少基线版本。');
    if(await workspaceFingerprint(source.root)!==source.fingerprint)throw new FlowError('STALE_VERSION','提交快照已变化。');
    const before=await this.manifest(this.get(source.baseArtifactId).root),after=await this.manifest(source.root),current=await this.manifest(target),changes=this.delta(before,after);
    const conflicts=changes.filter(c=>current[c.path]!==before[c.path]&&current[c.path]!==after[c.path]).map(c=>({path:c.path,reason:'目标内容与提交基线不一致。'}));if(conflicts.length)return conflicts;
    for(const c of changes){if(current[c.path]===after[c.path])continue;const dest=resolveSafePath(target,c.path);if(c.kind==='deleted')await fs.unlink(dest);else{await fs.mkdir(path.dirname(dest),{recursive:true});resolveSafePath(target,c.path);await fs.copyFile(resolveSafePath(source.root,c.path),dest);}}return [];
  }
}
