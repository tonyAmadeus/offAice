import { useState } from 'react';
import { StopCircle } from 'lucide-react';
import type { RunSummary } from '../shared/types';
import type { Invoke } from './ui';
/** Both task details and personal reports use the same stop request and confirmation. */
export function FlowRunStop({run,invoke}:{run:Pick<RunSummary,'id'|'status'>;invoke:Invoke}){
  const [busy,setBusy]=useState(false);
  if(!['queued','running','waiting_user','stopping'].includes(run.status))return null;
  async function stop(){if(!window.confirm('停止这次运行？已保存的记录和工作副本会保留，停止后需要核对这次尝试。'))return;setBusy(true);try{await invoke('run.stop',{runId:run.id},'已请求停止这次运行，记录和工作副本保留。');}catch{}finally{setBusy(false);}}
  return <button type="button" className="button small stop-button" disabled={busy||run.status==='stopping'} onClick={()=>void stop()}><StopCircle size={14}/>{run.status==='stopping'?'正在停止':'停止这次运行'}</button>;
}
