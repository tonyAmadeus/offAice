import {existsSync,realpathSync,statSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {Store} from './store';
import type {Project,Run,Session,WriteBoundary} from '../shared/types';
import {FlowError,type ProjectFlow,type FlowOperation} from '../shared/project-flow';
import type {JointReview} from '../shared/joint-review';
import type {ApplyJournal} from './project-flow-apply';
import {scopePath} from '../shared/project-flow-protocol';
import {resolveSafePath} from './security';
import {folderPath} from './folder-path';
interface Claim {projectId:string;directory:string;keys:string[];reason:string;kind:'execution'|'journal'|'write'|'removal';journalState?:ApplyJournal['state']}
interface Lease extends Claim {lockKeys:string[];id:string;state:'pending'|'running';run:()=>Promise<unknown>;resolve:(v:unknown)=>void;reject:(e:unknown)=>void}
const leases=new WeakMap<Store,Map<string,Lease>>(),removals=new WeakMap<Store,Set<string>>();
export function markProjectRemoving(store:Store,id:string,value:boolean){let ids=removals.get(store);if(!ids){ids=new Set();removals.set(store,ids);}if(value)ids.add(id);else ids.delete(id);}
const leaseMap=(store:Store)=>{let map=leases.get(store);if(!map){map=new Map();leases.set(store,map);}return map;};
const contains=(a:string,b:string)=>{const rel=path.relative(a,b);return rel===''||rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
export const keysOverlap=(a:string[],b:string[])=>a.some(x=>b.some(y=>contains(x,y)||contains(y,x)));
export const directoriesOverlap=(a:string,b:string)=>keysOverlap([folderPath(a).key],[folderPath(b).key]);
function physicalPath(project:Project,value:string){
  const target=resolveSafePath(project.directory,value==='.'?'':value);let ancestor=target;
  while(!existsSync(ancestor)){const parent=path.dirname(ancestor);if(parent===ancestor)throw new FlowError('INVALID_SCOPE','无法核对文件路径。');ancestor=parent;}
  const actual=path.join(realpathSync.native(ancestor),path.relative(ancestor,target));return process.platform==='win32'?actual.toLowerCase():actual;
}
export function normalizeWriteScopes(directory:string,value:unknown){
  if(!Array.isArray(value)||!value.length||value.length>100||value.some(v=>typeof v!=='string'))throw new FlowError('INVALID_SCOPE','修改范围须为 1 至 100 个明确的相对文件或目录。');
  const scopes=[...new Set((value as string[]).map(v=>scopePath(v.trim())))];for(const s of scopes)resolveSafePath(directory,s==='.'?'':s);return scopes;
}
const project=(store:Store,id:string)=>{const p=store.get<Project>('projects',id);if(!p)throw new FlowError('NOT_FOUND','项目不存在。');return p;};
export function captureProjectBoundary(store:Store,id:string):WriteBoundary{
  const p=project(store,id);try{
    if(!statSync(p.directory).isDirectory())throw Error('不是文件夹');
    const writeScopes=normalizeWriteScopes(p.directory,p.writeScopes??['.']).sort();
    return {directoryKey:folderPath(p.directory).key,writeScopes,scopeKeys:[...new Set(writeScopes.map(s=>physicalPath(p,s)))].sort()};
  }catch(e){if(e instanceof FlowError)throw e;throw new FlowError('INVALID_SCOPE','无法核对项目文件夹或修改范围：'+(e as Error).message);}
}
function validBoundary(b:WriteBoundary|undefined){return b&&typeof b.directoryKey==='string'&&path.isAbsolute(b.directoryKey)&&Array.isArray(b.scopeKeys)&&b.scopeKeys.length>0&&b.scopeKeys.every(k=>typeof k==='string'&&path.isAbsolute(k))&&Array.isArray(b.writeScopes)&&b.writeScopes.length>0;}
export function assertProjectBoundary(store:Store,id:string,b?:WriteBoundary){
  if(!b)return;const current=captureProjectBoundary(store,id);
  if(!validBoundary(b)||JSON.stringify(current)!==JSON.stringify(b))throw new FlowError('STALE_SCOPE','项目的实际文件夹或修改范围已改变，已停止派发或写回，请先核对。');
}
export function assertProjectPaths(store:Store,projectId:string,paths:string[]){
  const p=project(store,projectId),scopes=p.writeScopes??['.'];try{
    const allowed=scopes.map(s=>physicalPath(p,s));for(const value of paths){const target=physicalPath(p,scopePath(value));if(!allowed.some(root=>contains(root,target)))throw new FlowError('OUT_OF_SCOPE','任务或改动超出项目声明的修改范围：'+value);}
  }catch(error){if(error instanceof FlowError)throw error;throw new FlowError('INVALID_SCOPE','无法安全核对项目目录或修改范围：'+(error as Error).message);}
}
/** A missing historical boundary keeps the whole directory reserved. Invalid live paths never free a claim. */
function claimedKeys(p:Project,b?:WriteBoundary){
  const root=folderPath(p.directory).key;if(!validBoundary(b))return [root];
  try{return [...new Set([...b!.scopeKeys,...captureKeys(p)])];}catch{return [...new Set([...b!.scopeKeys,root])];}
}
function captureKeys(p:Project){return (p.writeScopes??['.']).map(s=>physicalPath(p,s));}
export function projectClaims(store:Store):Claim[]{
  const projects=new Map(store.list<Project>('projects').map(p=>[p.id,p])),claims:Claim[]=[];
  const add=(id:string,reason:string,b?:WriteBoundary,kind:Claim['kind']='execution')=>{const p=projects.get(id);if(p)claims.push({projectId:id,directory:p.directory,keys:kind==='removal'?[folderPath(p.directory).key]:claimedKeys(p,b),reason,kind});};
  for(const f of store.list<ProjectFlow>('project_flows'))if(!['completed','cancelled'].includes(f.status))add(f.projectId,'工作流程尚未结束',f.writeBoundary);
  for(const r of store.list<JointReview>('flow_joint_reviews'))if(!['completed','cancelled','stale'].includes(r.status))add(r.projectId,'共同评审或比稿尚未结束',r.writeBoundary);
  for(const run of store.list<Run>('runs')){
    const s=store.get<Session>('sessions',run.sessionId);if(!s?.writeMode||s.restoredHistoryOnly)continue;
    const op=run.flowOperationId?store.get<FlowOperation>('flow_operations',run.flowOperationId):undefined,unknown=run.status==='unknown'||run.delivery==='unknown',resolved=op&&(op.recovery==='completed'||(op.result as {abandoned?:boolean;continued?:boolean}|undefined)?.abandoned||(op.result as {continued?:boolean}|undefined)?.continued);
    if(['queued','running','waiting_user','stopping'].includes(run.status)||unknown&&(op?!resolved:Boolean(store.get('blocked_sessions',s.id))&&run.revision===s.revision))add(run.projectId,unknown?'执行结果仍待核对':'成员仍在执行或排队',run.writeBoundary);
  }
  for(const j of store.list<ApplyJournal>('flow_apply_journals'))if(['applying','recovery_required'].includes(j.state)){
    const p=projects.get(j.projectId),roots=validBoundary(j.writeBoundary)?[...j.writeBoundary!.scopeKeys]:[folderPath(j.directory).key];
    if(p)roots.push(...claimedKeys(p,j.writeBoundary));claims.push({projectId:j.projectId,directory:j.directory,keys:[...new Set(roots)],reason:'写回结果仍待核对',kind:'journal',journalState:j.state});
  }
  for(const id of removals.get(store)??[])add(id,'项目正在移除',undefined,'removal');
  return [...claims,...leaseMap(store).values()];
}
export function assertProjectAdmission(store:Store,id:string,includeOwn=false,requestedKeys?:string[],queueWrite=false){
  const p=project(store,id);if(removals.get(store)?.has(id))throw new FlowError('PROJECT_ACTIVE','项目正在移除，请稍后操作。');
  const keys=requestedKeys??captureProjectBoundary(store,id).scopeKeys,map=leaseMap(store);
  const conflict=projectClaims(store).find(c=>{
    if(!includeOwn&&c.projectId===id)return false;
    if(queueWrite&&c.kind==='write')return false;
    // An active write owns its applying journal. Wait for its lease, then recheck persisted recovery state.
    if(queueWrite&&c.kind==='journal'&&c.journalState==='applying'&&[...map.values()].some(l=>l.projectId===c.projectId&&l.state==='running'&&keysOverlap(l.keys,c.keys)))return false;
    return keysOverlap(keys,c.keys);
  });
  if(conflict){const other=store.get<Project>('projects',conflict.projectId);throw new FlowError('PROJECT_DIRECTORY_BUSY',`修改范围与「${other?.name??'待核对的项目'}」重叠，需串行执行：${conflict.reason}。请先结束或核对该工作。`);}
  return p;
}
/** Kept for M5 callers; M6 admits only disjoint, verified physical scopes. */
export const assertProjectSerial=assertProjectAdmission;
export function assertProjectIdle(store:Store,id:string){if(projectClaims(store).some(c=>c.projectId===id))throw new FlowError('PROJECT_ACTIVE','请先结束项目工作、运行和待核对的写回，再修改文件范围或移除项目。');}
function pump(store:Store){
  const map=leaseMap(store),active=[...map.values()].filter(l=>l.state==='running').map(l=>l.lockKeys),blocked:string[][]=[];
  for(const lease of map.values()){
    if(lease.state!=='pending')continue;
    if([...active,...blocked].some(keys=>keysOverlap(keys,lease.lockKeys))){blocked.push(lease.lockKeys);continue;}
    lease.state='running';active.push(lease.lockKeys);
    Promise.resolve().then(lease.run).then(value=>{map.delete(lease.id);pump(store);lease.resolve(value);},error=>{map.delete(lease.id);pump(store);lease.reject(error);});
  }
}
/** Reserve before awaiting. Physical directories (including nested aliases) queue in arrival order. Snapshot reads share the same barrier. */
export async function withProjectWrite<T>(store:Store,id:string,directory:string,job:(check:()=>void)=>Promise<T>,includeOwn=false,metadataPaths?:string[],snapshot=false):Promise<T>{
  const p=project(store,id),boundary=captureProjectBoundary(store,id),directoryKey=folderPath(directory).key;
  if(boundary.directoryKey!==directoryKey)throw new FlowError('INVALID_PROJECT_DIRECTORY','写回目录与项目工作文件夹不一致，请核对项目记录。');
  const keys=metadataPaths?metadataPaths.map(s=>physicalPath(p,s)):boundary.scopeKeys;
  const check=()=>{assertProjectBoundary(store,id,boundary);if(folderPath(directory).key!==directoryKey||metadataPaths&&JSON.stringify(metadataPaths.map(s=>physicalPath(project(store,id),s)))!==JSON.stringify(keys))throw new FlowError('STALE_SCOPE','等待写入期间实际路径已改变，请核对后重试。');assertProjectAdmission(store,id,includeOwn,keys,true);};
  check();
  return new Promise<T>((resolve,reject)=>{const lease:Lease={id:randomUUID(),projectId:id,directory,keys,lockKeys:[directoryKey],kind:'write',reason:snapshot?'项目文件正在建立快照':'项目文件正在写入或等待写入',state:'pending',run:async()=>{check();return job(check);},resolve:value=>resolve(value as T),reject};leaseMap(store).set(lease.id,lease);pump(store);});
}
export const withProjectSnapshot=<T>(store:Store,id:string,directory:string,job:(check:()=>void)=>Promise<T>)=>withProjectWrite(store,id,directory,job,false,undefined,true);
