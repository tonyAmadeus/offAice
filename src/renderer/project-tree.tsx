import {useRef,useState} from 'react';
import type {Project,Snapshot} from '../shared/types';
import {descendantIds,projectRows} from '../shared/project-tree';
import {FolderOpen,LoaderCircle} from 'lucide-react';
import {Modal} from './modals';
import type {Invoke} from './ui';
import './project-tree.css';

export function ProjectHierarchyModal({mode,target,snapshot,invoke,onClose,onCreate,onSaved}:{mode:'child'|'move';target:Project;snapshot:Snapshot;invoke:Invoke;onClose:()=>void;onCreate:(p:{name:string;directory:string;parentId:string;writeScopes:string[];requestId:string})=>Promise<void>;onSaved:()=>Promise<void>}){
  const creating=mode==='child',blocked=new Set(descendantIds(snapshot.projects,target.id));
  const [name,setName]=useState(''),[directory,setDirectory]=useState(target.directory),[parentId,setParentId]=useState(target.parentId??''),[order,setOrder]=useState(String(target.order??0)),[scopes,setScopes]=useState((creating?['.']:target.writeScopes??['.']).join('\n')),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const request=useRef<{signature:string;id:string}|undefined>(undefined);
  async function browse(){try{const directory=await invoke<string|null>('dialog.directory');if(directory)setDirectory(directory);}catch(e){setError((e as Error).message);}}
  async function save(){
    setBusy(true);setError('');
    try{
      const writeScopes=scopes.split(/\r?\n/).map(s=>s.trim()).filter(Boolean),body=creating?{name:name.trim(),directory:directory.trim(),parentId:target.id,writeScopes}:{projectId:target.id,parentId:parentId||null,order:Number(order),writeScopes,expectedRevision:target.hierarchyRevision??0},signature=JSON.stringify(body);
      if(request.current?.signature!==signature)request.current={signature,id:crypto.randomUUID()};
      if(creating)await onCreate({...body as {name:string;directory:string;parentId:string;writeScopes:string[]},requestId:request.current!.id});
      else{await invoke('project.move',{...body,requestId:request.current!.id});await onSaved();}
      onClose();
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <Modal title={creating?'添加子项目':'项目归属与修改范围'} subtitle={target.name} onClose={onClose}>
    <div className="modal-body project-hierarchy-form">
      {creating?<>
        <label className="field">子项目名称<input value={name} onChange={e=>setName(e.target.value)} maxLength={120}/></label>
        <label className="field">工作文件夹<input value={directory} onChange={e=>setDirectory(e.target.value)} spellCheck={false}/></label>
        <button type="button" className="button secondary small" disabled={busy} onClick={()=>void browse()}><FolderOpen size={15}/>选择文件夹</button>
        <p className="task-meta">归属：{target.name}。可以选择子文件夹，也可以共用父项目文件夹；子项目有自己的成员、会议室和工作流程。</p>
      </>:<>
        <label className="field">归属项目<select aria-label="归属项目" value={parentId} onChange={e=>setParentId(e.target.value)}><option value="">独立项目</option>{projectRows(snapshot.projects).filter(r=>!blocked.has(r.project.id)).map(r=><option key={r.project.id} value={r.project.id}>{r.path.join(' / ')}</option>)}</select></label>
        <label className="field">同级顺序<input type="number" min={0} max={1000000} value={order} onChange={e=>setOrder(e.target.value)}/></label>
        <label className="field">工作文件夹<input value={target.directory} readOnly/></label>
        <p className="task-meta">调整归属只改变项目树，文件仍保留在这个文件夹中。</p>
      </>}
      <label className="field">允许修改的文件或目录<textarea aria-label="允许修改的文件或目录" value={scopes} onChange={e=>setScopes(e.target.value)} rows={4} spellCheck={false} placeholder="每行一个相对路径，例如 报告.md 或 资料"/></label>
      <p className="task-meta">每行一个相对路径，点号 . 表示整个文件夹。后台核对任务范围和写回文件；共享文件夹只有实际修改范围不重叠时才能并行，范围重叠则需串行。修改范围需先结束本项目工作。</p>
      {error&&<p role="alert" className="round-results-error">{error}</p>}
    </div>
    <div className="modal-footer"><button type="button" className="button quiet" onClick={onClose}>取消</button><button type="button" className="button primary" disabled={busy||!scopes.trim()||creating&&(!name.trim()||!directory.trim())||!creating&&!order.trim()} onClick={()=>void save()}>{busy&&<LoaderCircle size={14} className="spin"/>}{creating?'添加子项目':'保存归属与范围'}</button></div>
  </Modal>;
}
