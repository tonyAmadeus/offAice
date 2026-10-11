import type { MemberReport } from './project-workbench';
import type { Approval, Project, RoomHistory, RoomId, RoomState, RoomThread, Run, Session, TimelineEvent } from './types';
import type { FlowOperation, Task } from './project-flow';

export const isWorkProject = (project: Pick<Project, 'kind'>) => !project.kind;
export const isPersonalRoom = (id: string): id is RoomId => id.startsWith('desk:') || id.startsWith('report:');
export interface PersonalRoom { id:RoomId; kind:'desk'|'report'; memberId:string; projectId?:string; createdAt:string }
/** The link is separate from Session: importing history never alters a native session or its work copy. */
export interface DeskTopic { id:string; memberId:string; sessionId:string; directory:string; direct:boolean; deletedAt?:string }
export interface DeskFolder { key:string; directory:string; label:string; personal:boolean; topicCount:number; unread:boolean; pending:boolean; active:boolean }
export interface PersonalRoomData extends RoomHistory {
  roomId:RoomId; state:RoomState; currentThreadId:string; threads:RoomThread[];
  sessionId?:string; directory?:string; direct?:boolean; personalFolder?:string; folderKey?:string; folders?:DeskFolder[];
}
export interface MemberWork {
  projectId:string; memberId:string; runs:Run[]; sessions:Session[]; operations:FlowOperation[];
  tasks:Task[]; approvals:Approval[]; events:TimelineEvent[]; reports:MemberReport[];
}
