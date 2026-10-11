import type { Store } from './store';
import type { ProjectFlow } from '../shared/project-flow';
import type { RoomMessage, RoomThread } from '../shared/types';
import type { PersonalRoom } from '../shared/member-workspaces';

/** A saved user request may originate in the project's meeting or in the target member's report room. */
export function projectRequestSource(store:Store,flow:ProjectFlow,messageId:string,memberId:string,currentMeeting=true):'meeting'|'report'|undefined {
  const message=store.get<RoomMessage>('room_messages',messageId);
  if(!message||message.author!=='user'||message.system||message.discussionControl||message.discussionStale||message.flowPlan||message.flowReport||message.flowDecision||message.memberReport||!message.threadId||message.status&&message.status!=='done')return;
  const thread=store.get<RoomThread>('room_threads',message.threadId);
  if(thread?.roomId===flow.roomId&&(!currentMeeting||thread.id===flow.threadId))return 'meeting';
  const room=thread?.roomId&&store.get<PersonalRoom>('personal_rooms',thread.roomId);
  if(room&&room.kind==='report'&&room.projectId===flow.projectId&&room.memberId===memberId&&store.currentRoomThread(room.id).id===thread?.id)return 'report';
}
