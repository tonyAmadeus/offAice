import {useEffect,useState} from 'react';
import type {Project} from '../shared/types';
import type {ProjectRecord} from '../shared/project-workbench';
import {Modal} from './modals';
import {Markdown} from './Markdown';
import type {Invoke} from './ui';
export function ProjectRecordView({project,flowId,invoke,onClose}:{project:Project;flowId:string;invoke:Invoke;onClose:()=>void}){
  const [record,setRecord]=useState<ProjectRecord>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const load=()=>invoke<ProjectRecord>('projectFlow.record',{projectId:project.id,flowId}).then(setRecord);
  useEffect(()=>{let alive=true;void invoke<ProjectRecord>('projectFlow.record',{projectId:project.id,flowId}).then(r=>{if(alive)setRecord(r);}).catch(e=>{if(alive)setError((e as Error).message);});return()=>{alive=false;};},[project.id,flowId]);
  async function write(){setBusy(true);try{await invoke('projectFlow.record.write',{requestId:crypto.randomUUID(),projectId:project.id,flowId});await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <Modal title="项目记录" subtitle="根据保存的方案、汇报、验收和决策生成。" onClose={onClose}>
    <div className="modal-body project-record">{error&&<p role="alert">{error}</p>}{record?<><p>{record.status==='completed'?'已完成':record.status==='cancelled'?'已取消':'进行中 · 当前记录预览'}</p><Markdown text={record.markdown}/>{record.receipt&&<p role="status">项目文件保存：{record.receipt.state} · {record.receipt.path}{record.receipt.error&&' · '+record.receipt.error}</p>}</>:<p>正在读取记录…</p>}</div>
    <div className="modal-footer"><label className="project-record-setting" title="默认关闭；每段工作完成或取消后新建一份，不覆盖已有文件"><input type="checkbox" checked={project.projectRecordToFolder===true} onChange={e=>void invoke('project.update',{projectId:project.id,projectRecordToFolder:e.target.checked}).catch(err=>setError((err as Error).message))}/>完成或取消后，自动保存到项目的 docs/airoom/</label><button className="button" disabled={!record||busy} onClick={()=>record&&void invoke('file.save',{name:record.title+'.md',content:record.markdown}).catch(e=>setError((e as Error).message))}>导出 Markdown</button>{project.projectRecordToFolder&&record&&['completed','cancelled'].includes(record.status)&&record.receipt?.state!=='written'&&<button className="button" disabled={busy} onClick={()=>void write()}>写入项目文件夹{record.receipt?.state==='failed'?'（重试）':''}</button>}<button className="button quiet" onClick={onClose}>关闭</button></div>
  </Modal>;
}
