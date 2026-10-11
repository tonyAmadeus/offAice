import type { Store } from './store';
import { FlowError, type Acceptance, type ProjectFlow, type Review, type Round, type Task } from '../shared/project-flow';
import {roundLead} from '../shared/project-flow';
import type { RoomId, RoomMessage, Session } from '../shared/types';

const visible=(message:RoomMessage)=>!message.taskRequest&&!message.system&&!message.discussionControl&&!message.discussionStale&&(message.status==='done'||message.author==='user'&&message.status===undefined)&&Boolean(message.text.trim())&&!message.flowPlan&&!message.flowReport&&!message.flowDecision;
const messageView=(message:RoomMessage)=>({id:message.id,author:message.author,name:message.authorName,text:message.text,at:message.at,intent:message.intent});
function roomMessages(store:Store,roomId:RoomId){return store.allRoomMessages(store.currentRoomThread(roomId).id,roomId).filter(visible);}
function activeFlow(store:Store,roomId:RoomId){return roomId==='global'?undefined:store.list<ProjectFlow>('project_flows').find(flow=>flow.roomId===roomId&&!['completed','cancelled'].includes(flow.status));}
export function workingRoomMember(store:Store,roomId:RoomId,memberId:string){
  const flow=activeFlow(store,roomId);if(!flow)return false;
  const rounds=store.list<Round>('flow_rounds').filter(round=>round.flowId===flow.id&&round.planId===flow.activePlanId&&!['accepted','pending'].includes(round.status));
  if(flow.leadMemberId===memberId&&flow.status==='planning'||rounds.some(round=>roundLead(flow,round)===memberId))return true;
  return store.list<Task>('flow_tasks').some(task=>task.flowId===flow.id&&task.planId===flow.activePlanId&&task.memberId===memberId&&!['accepted','cancelled'].includes(task.status)&&(rounds.some(round=>round.id===task.roundId)||Boolean(task.earlyDecisionId)))||store.list<{flowId:string;state:string;sessionId?:string}>('flow_operations').some(operation=>operation.flowId===flow.id&&['prepared','running'].includes(operation.state)&&operation.sessionId&&store.get<Session>('sessions',operation.sessionId)?.memberId===memberId);
}
export function roomTaskStatus(store:Store,roomId:RoomId,memberId:string){
  const flow=activeFlow(store,roomId);if(!flow)return {tasks:[]};
  const tasks=store.list<Task>('flow_tasks').filter(task=>task.flowId===flow.id&&task.planId===flow.activePlanId&&(task.memberId===memberId||task.reviewerMemberId===memberId));
  const current=flow.currentRoundId?store.get<Round>('flow_rounds',flow.currentRoundId):undefined;return {flowId:flow.id,flowStatus:flow.status,dispatchMode:flow.dispatchMode,role:roundLead(flow,current)===memberId?'lead':'member',tasks:tasks.map(task=>{
    const review=store.list<Review>('flow_reviews').filter(review=>review.taskId===task.id).at(-1);
    return {id:task.id,title:task.title,status:task.status,lastActivity:task.lastActivity,blockedReason:task.blockedReason,latestReview:review?{status:review.status,verdict:review.verdict,findings:review.findings,at:review.updatedAt}:undefined};
  })};
}
interface MemberRead {throughId?:string;readIds:string[]}
function memberRead(store:Store,roomId:RoomId,memberId:string){return store.get<MemberRead>('room_member_reads',`${roomId}:${memberId}`)??{readIds:[]};}
function unread(store:Store,roomId:RoomId,memberId:string,messages:RoomMessage[]){const cursor=memberRead(store,roomId,memberId),all=roomMessages(store,roomId),through=all.findIndex(message=>message.id===cursor.throughId),seen=new Set([...all.slice(0,through+1).map(message=>message.id),...cursor.readIds]);return messages.filter(message=>!seen.has(message.id));}
/** Sparse mention reads cannot skip the ordinary messages that precede the mention. */
export function markRoomRead(store:Store,roomId:RoomId,memberId:string,ids:string[]){
  if(roomId==='global'||!ids.length)return;
  const all=roomMessages(store,roomId),cursor=memberRead(store,roomId,memberId),through=all.findIndex(message=>message.id===cursor.throughId),seen=new Set([...cursor.readIds,...ids]);
  let end=through;while(end+1<all.length&&seen.has(all[end+1].id))end++;
  const remaining=all.slice(end+1).filter(message=>seen.has(message.id)).map(message=>message.id);
  store.put('room_member_reads',`${roomId}:${memberId}`,{throughId:all[end]?.id,readIds:remaining});
}
export function acceptedMeetingBackground(store:Store,flow:ProjectFlow,memberId:string){
  const accepted=store.list<Acceptance>('flow_acceptances').filter(item=>item.flowId===flow.id&&item.status==='accepted'&&item.acceptedAt).map(item=>item.acceptedAt!).sort().at(-1);
  if(!accepted)return {messages:[] as ReturnType<typeof messageView>[]};
  const roomId=flow.roomId as RoomId,thread=store.currentRoomThread(roomId),messages=unread(store,roomId,memberId,roomMessages(store,roomId).filter(message=>message.at>=flow.createdAt&&message.at<=accepted));
  const context={background:thread.summary?.text,messages:messages.map(messageView)};if(JSON.stringify(context).length>60000)throw new FlowError('CONTEXT_TOO_LARGE','待补读的会议记录较长，请先压缩项目会议话题，再继续任务。');return context;
}
export function roundMeetingMaterial(store:Store,round:Round){
  const flow=store.get<ProjectFlow>('project_flows',round.flowId)!,all=roomMessages(store,flow.roomId as RoomId).filter(message=>message.at>=(round.startedAt??round.createdAt));
  const context={messages:all.filter(message=>!round.meetingReadIds?.includes(message.id)).map(messageView),pendingUserMessages:all.filter(message=>message.author==='user'&&message.intent!=='readonly-question'&&!round.meetingHandledIds?.includes(message.id)).map(messageView),previousResponses:round.meetingResponses??[]};
  if(JSON.stringify(context).length>60000)throw new FlowError('CONTEXT_TOO_LARGE','本轮未处理的会议记录过长，请先暂停并整理需求或修改方案；没有忽略发言。');return context;
}
