import type { Store } from './store';
import { FlowError, type FlowDiscussionContext } from '../shared/project-flow';
import type { RoomId, RoomMessage } from '../shared/types';

/** Capture actual room material before planning; later edits or clearing the room cannot change it. */
export function captureFlowDiscussion(store:Store,projectId:string,params:Record<string,unknown>,after?:string):FlowDiscussionContext {
  const roomId=`project:${projectId}` as RoomId,thread=store.currentRoomThread(roomId);
  if(params.threadId!==undefined&&params.threadId!==thread.id)throw new FlowError('INVALID_PROJECT','方案讨论的话题不属于当前项目会议室。');
  const all=store.allRoomMessages(thread.id,roomId).filter(message=>!after||message.at>after),discussion=store.roomState(roomId).discussion;
  const completed=(message:RoomMessage)=>(message.status==='done'||message.author==='user'&&message.status===undefined)&&!message.system&&!message.discussionControl&&!message.discussionStale&&!message.flowReport&&!message.flowPlan&&!message.flowDecision&&Boolean(message.text.trim());
  const requested=params.minutesMessageId;
  const minutesId=requested??(discussion?.meetingMinutes?.status==='done'?discussion.meetingMinutes.messageId:undefined);
  const minutes=minutesId?all.find(message=>message.id===minutesId):undefined;
  if(requested!==undefined&&(!minutes||minutes.kind!=='summary'||!completed(minutes)))throw new FlowError('INVALID_REQUEST','所选会议纪要尚未完成、已失效，或不属于当前项目会议室。');
  const usableMinutes=minutes?.kind==='summary'&&completed(minutes)?minutes:undefined;
  const summary=thread.summary&&(!after||all.some(message=>message.id===thread.summary!.upTo&&completed(message)))?thread.summary:undefined;
  const cut=usableMinutes?all.findIndex(message=>message.id===usableMinutes.id):summary?.upTo?all.findIndex(message=>message.id===summary.upTo):-1;
  const context:FlowDiscussionContext={roomId,threadId:thread.id,capturedAt:new Date().toISOString(),
    ...(usableMinutes?{minutesMessageId:usableMinutes.id,minutes:{id:usableMinutes.id,author:usableMinutes.authorName??usableMinutes.author,text:usableMinutes.text}}:{}),
    ...(!usableMinutes&&summary?{background:summary.text}:{}),
    messages:all.slice(cut+1).filter(completed).map(message=>({id:message.id,author:message.authorName??message.author,text:message.text}))};
  // Too long: keep minutes/summary and the newest talk, drop the oldest, then cut the head of the last message. Copies only; chat is untouched.
  const size=()=>JSON.stringify(context).length,limit=60000;
  if(size()<=limit)return context;
  context.contextLimitNote='讨论记录超出长度上限，已保留纪要或摘要与最新发言，省略较早内容。';
  while(context.messages.length>1&&size()>limit)context.messages.shift();
  // Drop the oldest tenth of the one remaining message until it fits.
  while(context.messages[0]?.text&&size()>limit){const m=context.messages[0];context.messages[0]={...m,text:m.text.slice(Math.ceil(m.text.length/10))};}
  if(size()>limit)throw new FlowError('CONTEXT_TOO_LARGE','方案讨论记录较长，请先压缩项目会议话题或选择已完成的会议纪要，再起草方案。');
  return context;
}
