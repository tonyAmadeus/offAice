import { useEffect, useState } from 'react';
import { AlertCircle, LoaderCircle, Undo2 } from 'lucide-react';
import type { Session } from '../shared/types';
import type { UndoInfo } from '../backend/workspace-checkpoint';
import { Modal } from './modals';
import { errorText, type Invoke, type Notify } from './ui';

export function WorkspaceUndoDialog({session,invoke,notify,onClose,onDone}:{session:Session;invoke:Invoke;notify:Notify;onClose:()=>void;onDone:()=>void}){
  const [info,setInfo]=useState<UndoInfo>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let alive=true;void invoke<UndoInfo>('workspace.undo.info',{sessionId:session.id}).then(value=>{if(alive)setInfo(value);}).catch(error=>{if(alive)setError(errorText(error));});return ()=>{alive=false;};},[session.id,invoke]);
  async function undo(partial=false){
    if(!info?.canUndo||!info.runId||busy)return;setBusy(true);setError('');
    try{
      const result=await invoke<UndoInfo>('workspace.undo',{sessionId:session.id,runId:info.runId,restoreUnchanged:partial});
      if(result.status==='undone'){notify(info.projectUndo?'工作副本及未被再次修改的项目原文件已恢复。':'最近一轮的文件改动已在工作副本中撤销。');onDone();}
      else{setInfo(result);setError(result.reason||'文件状态已变化，请查看冲突后重试。');}
    }catch(error){setError(errorText(error));}finally{setBusy(false);}
  }
  return <Modal title="撤销最近一轮" subtitle="恢复这一轮开始时的副本文件，保留更早轮次的改动。" onClose={onClose}>
    <div className="modal-body">
      {!info&&!error?<p className="panel-muted"><LoaderCircle size={14} className="spin"/>正在检查本轮还原点和文件状态…</p>:<>
        <p className="panel-muted">{info?.projectUndo?'这轮已写回项目。撤销会直接恢复写回前的原文件，并恢复工作副本；之后仍可再次写回。':'这轮尚未写回项目，撤销只恢复工作副本。'}</p>
        {!!info?.projectUndo?.conflicts.length&&<div className="inline-notice error"><AlertCircle size={15}/><div><strong>以下原文件有后续变化，将保留当前内容</strong><ul>{info.projectUndo.conflicts.map(conflict=><li key={conflict.path}>{conflict.path}：{conflict.reason}</li>)}</ul></div></div>}
        {info?.runId&&<p className="undo-run-reference">对应轮次：<code>{info.runId}</code></p>}
        {info?.changes.length?<ul className="undo-file-list">{info.changes.map(change=><li key={change.path}><span>{change.kind==='added'?'移除新增文件':change.kind==='deleted'?'恢复删除文件':'恢复原内容'}</span><code>{change.path}</code></li>)}</ul>:<p className="panel-muted">{info?.reason||'没有文件内容改动；若暂存区发生变化，将恢复这一轮之前的暂存状态。'}</p>}
        {!!info?.conflicts.length&&<div className="inline-notice error"><AlertCircle size={15}/><div><strong>检测到后续改动，当前不能撤销</strong><ul>{info.conflicts.map(conflict=><li key={conflict.path}>{conflict.path}：{conflict.reason}</li>)}</ul></div></div>}
        {info?.reason&&!!info.changes.length&&<p className="inline-notice"><AlertCircle size={15}/>{info.reason}</p>}
      </>}
      {error&&<p className="inline-notice error"><AlertCircle size={15}/>{error}</p>}
    </div>
    <div className="modal-footer"><button type="button" className="button quiet" disabled={busy} onClick={onClose}>取消</button><button type="button" className="button secondary danger" disabled={busy||!info?.canUndo||!!info.projectUndo&&(info.projectUndo.status!=='applied'||!!info.projectUndo.conflicts.length&&!info.projectUndo.canRestoreUnchanged)} onClick={()=>void undo(!!info?.projectUndo?.conflicts.length)}>{busy?<LoaderCircle size={14} className="spin"/>:<Undo2 size={14}/>} {info?.projectUndo?.conflicts.length?'只恢复没变过的文件':'撤销本轮改动'}</button></div>
  </Modal>;
}
