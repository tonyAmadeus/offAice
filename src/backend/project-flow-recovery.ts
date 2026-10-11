import type {Store} from './store';
import type {Run} from '../shared/types';
import type {FlowOperation,OperationResult} from '../shared/project-flow';

export function finishedFlowReply(store:Store,operation:FlowOperation):OperationResult|undefined {
  const runId=operation.correctionRunId??operation.runId,run=runId?store.get<Run>('runs',runId):undefined;
  if(!run||run.flowOperationId!==operation.id||!['ended','completed'].includes(run.status)||!['sent','confirmed'].includes(run.delivery))return;
  // Keep exactly the same event selection and concatenation as Engine.waitForReply.
  const events=store.runEvents(run.id).filter(e=>!(e.data as {role?:string}|undefined)?.role),deltas=events.filter(e=>e.kind==='delta').map(e=>e.text).join('');
  const text=(deltas||events.filter(e=>e.kind==='message').map(e=>e.text).join('\n\n')).trim();if(!text)return;
  return {runId:run.id,status:run.status,text};
}
export function operationNotDelivered(store:Store,operation:FlowOperation){
  if(operation.kind==='supplement-delivery')return false;
  const runId=operation.correctionRunId??operation.runId;if(!runId)return true;
  const run=store.get<Run>('runs',runId);return Boolean(run&&['prepared','withdrawn'].includes(run.delivery)&&!['ended','completed'].includes(run.status));
}
