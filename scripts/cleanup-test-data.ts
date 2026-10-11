import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {Engine} from '../src/backend/engine';
import {fullProfileCopy} from './full-profile-copy';
import type {Adapter,ProviderId} from '../src/shared/types';
import {descendantIds} from '../src/shared/project-tree';
type CleanupRow={entity:string;id:string;value:string};
type Candidate={key:string;entity:string;id:string;title:string;createdAt:string;fingerprint:string;evidence:string[];eligible:boolean};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const testName=/(?:验收|补测|测试|smoke|acceptance|fixture|S\d{1,2}[-_ :])/i;
/** Read-only preview, including dependencies whose names do not look like test data. */
export function testCleanupPreflight(rows:CleanupRow[],selected:{entity:string;id:string}[]){
  const values=rows.map(row=>({...JSON.parse(row.value),entity:row.entity,id:row.id}));
  const projects=values.filter(v=>v.entity==='projects');
  return selected.map(candidate=>{
    const children=candidate.entity==='projects'?descendantIds(projects,candidate.id).slice(1).map(id=>{const p=projects.find(p=>p.id===id)!;return {id,name:p.name,parentId:p.parentId};}):[];
    const blockers:{entity:string;id:string;status?:string;resolution:string}[]=[];
    const add=(v:any,resolution:string)=>blockers.push({entity:v.entity,id:v.id,status:v.status??v.state,resolution});
    if(candidate.entity==='projects'){
      const reports=new Set(values.filter(v=>v.entity==='personal_rooms'&&v.projectId===candidate.id).map(v=>v.id));
      const sessions=new Set(values.filter(v=>v.entity==='sessions'&&(v.projectId===candidate.id||reports.has(v.roomId))).map(v=>v.id));
      for(const v of values){
        if(v.entity==='runs'&&(v.projectId===candidate.id||sessions.has(v.sessionId))){
          if(v.status==='unknown'||v.delivery==='unknown')add(v,'先在 AIROOM 核对未知结果并处理会话阻塞；不要自动重发。');
          else if(['queued','running','waiting_user','stopping'].includes(v.status))add(v,'先在 AIROOM 停止运行并等待结束。');
        }
        if(v.projectId!==candidate.id)continue;
        if(v.entity==='project_flows'&&!['completed','cancelled'].includes(v.status))add(v,'先在会议室结束或取消项目流程。');
        if(v.entity==='flow_joint_reviews'&&!['completed','cancelled','stale'].includes(v.status))add(v,'先结束或取消共同评审、比稿。');
        if(v.entity==='flow_apply_journals'&&['applying','recovery_required'].includes(v.state))add(v,'先在 AIROOM 核对并恢复待确认的写回。');
        if(v.entity==='collaborations'&&v.status==='running')add(v,'先暂停协作并等待结束。');
      }
    }
    if(candidate.entity==='attention_items')blockers.push({entity:candidate.entity,id:candidate.id,resolution:'提醒应随对应项目或话题删除，不单独猜测归属。'});
    return {key:candidate.entity+':'+candidate.id,children,childResolution:children.length?'先把子项目移为独立项目或其他归属；如需删除子项目，须另外核对和逐项确认，再重新预览。':undefined,blockers,ready:!children.length&&!blockers.length};
  });
}
export function assertTestCleanupReady(rows:CleanupRow[],selected:{entity:string;id:string}[]){
  const blocked=testCleanupPreflight(rows,selected).filter(p=>!p.ready);
  if(blocked.length)throw new Error('清理预检未通过，尚未复制或删除资料：'+JSON.stringify(blocked));
}
export function testDataCandidates(rows:{entity:string;id:string;value:string}[],evidence:{file:string;text:string}[],from:string,to:string):Candidate[]{
  return rows.flatMap(row=>{
    const value=JSON.parse(row.value),title=String(value.name??value.title??value.text??''),createdAt=String(value.createdAt??value.at??'');
    const refs=evidence.filter(e=>e.text.includes(row.id)).map(e=>e.file);
    if(!testName.test(title)&&!refs.length)return [];
    const dated=createdAt>=from&&createdAt<to;
    const ownedElsewhere=row.entity==='projects'&&['lounge','roundtable','desk'].includes(value.kind)||row.entity==='room_threads'&&value.roomId?.startsWith('roundtable:');
    return [{key:row.entity+':'+row.id,entity:row.entity,id:row.id,title:title.slice(0,200),createdAt,fingerprint:hash(row.value),evidence:refs,eligible:!ownedElsewhere&&testName.test(title)&&dated&&refs.length>0}];
  });
}
function assertClosed(){const result=execFileSync('powershell.exe',['-NoProfile','-Command',"@(Get-CimInstance Win32_Process -Filter \"Name='AIROOM.exe' OR Name='electron.exe'\" | Where-Object { $_.Name -eq 'AIROOM.exe' -or $_.CommandLine -match 'AIROOM' }).Count"],{encoding:'utf8',windowsHide:true}).trim();if(result!=='0')throw new Error('请从托盘正常退出 AIROOM 后再执行已确认的清理。');}
export async function fullTestCleanupBackup(data:string){
  const destination=path.join(path.dirname(data),'test-cleanup-backups',new Date().toISOString().replaceAll(':','-')+'-'+randomUUID());
  await fs.mkdir(destination,{recursive:true});
  await fullProfileCopy(data,destination);
  await fs.writeFile(path.join(destination,'README.txt'),'Full pre-cleanup copy including desks, roundtable manuscripts and native login directories. Contains private data. Not a normal rotating AIROOM backup.\n');
  return destination;
}
async function main(){
  const args=process.argv.slice(2),arg=(key:string)=>args[args.indexOf(key)+1],has=(key:string)=>args.includes(key);
  const data=path.resolve(has('--data')?arg('--data'):path.join(process.env.USERPROFILE!,'.airoom','data'));
  const db=new DatabaseSync(path.join(data,'airoom.sqlite'),{readOnly:true});
  const rows=db.prepare('SELECT entity,id,value FROM entities').all() as CleanupRow[];db.close();
  if(!has('--apply-plan')){
    const evidence:{file:string;text:string}[]=[];
    const folder=path.resolve('docs/records');for(const file of await fs.readdir(folder)){if(!file.endsWith('.md')&&!file.endsWith('.json'))continue;evidence.push({file:path.join(folder,file),text:await fs.readFile(path.join(folder,file),'utf8')});}
    for(let i=0;i<args.length;i++)if(args[i]==='--evidence'){const file=path.resolve(args[++i]);evidence.push({file,text:await fs.readFile(file,'utf8')});}
    const candidates=testDataCandidates(rows.filter(r=>['projects','room_threads','roundtable_topics','attention_items'].includes(r.entity)),evidence,has('--from')?arg('--from'):'2026-10-05',has('--to')?arg('--to'):'2026-10-11');
    const preflight=testCleanupPreflight(rows,candidates);
    const plan={version:1,data,createdAt:new Date().toISOString(),candidates,preflight};
    const output=path.resolve(has('--out')?arg('--out'):'.test-cache/test-cleanup-plan.json');await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(plan,null,2));
    console.log(JSON.stringify({plan:output,candidates,preflight,note:'只列候选，没有删除。eligible=false 的记录必须先核对名称、日期和验收证据。请先处理 preflight 中的子项目和遗留状态，再重新预览。删除必须逐项确认 ID，且先做完整备份。'},null,2));return;
  }
  const plan=JSON.parse(await fs.readFile(path.resolve(arg('--apply-plan')),'utf8'));
  if(plan.version!==1||path.resolve(plan.data)!==data||!has('--confirm')||!has('--app-closed'))throw new Error('请指定同一数据目录、候选计划、逐项确认的 ID 和 --app-closed；不支持全部删除。');
  const selected=[...new Set(arg('--confirm').split(',').filter(Boolean))].map(key=>{const c=(plan.candidates as Candidate[]).find(c=>c.key===key);if(!c?.eligible)throw new Error('未核对的测试候选：'+key);const current=rows.find(r=>r.entity===c.entity&&r.id===c.id);if(!current||hash(current.value)!==c.fingerprint)throw new Error('候选状态已变化，请重新列出：'+key);return c;});
  if(!selected.length)throw new Error('没有逐项确认的候选。');
  assertTestCleanupReady(rows,selected);
  assertClosed();const backup=await fullTestCleanupBackup(data);assertClosed();
  const factory=(id:ProviderId):Adapter=>({probe:async()=>({id,name:id,available:false,auth:'none',detail:'offline maintenance',capabilities:{steer:false,cancel:'process',streaming:false,write:false,history:false}}),start:async()=>{throw new Error('清理不允许调用模型');},stop:async()=>{}});
  const engine=new Engine(data,()=>{},()=>{},factory,{maintenanceOnly:true});const removed=[];
  try{for(const candidate of selected){
    if(candidate.entity==='roundtable_topics'){const topic=engine.store.get<any>('roundtable_topics',candidate.id);await engine.invoke('roundtable.delete',{topicId:topic.id,expectedRevision:topic.revision});}
    else if(candidate.entity==='projects')await engine.invoke('project.remove',{projectId:candidate.id,discardWorkspaces:true});
    else if(candidate.entity==='room_threads'){const thread=engine.store.get<any>('room_threads',candidate.id);if(thread)await engine.invoke('room.delete',{roomId:thread.roomId,threadId:thread.id});}
    else throw new Error('提醒应随对应项目或话题删除；不单独猜测其归属。');
    removed.push({entity:candidate.entity,id:candidate.id});
  }}finally{await engine.close();await fs.writeFile(path.join(backup,'cleanup-result.json'),JSON.stringify({removed,at:new Date().toISOString()},null,2));}
  console.log(JSON.stringify({removed,fullBackup:backup},null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
