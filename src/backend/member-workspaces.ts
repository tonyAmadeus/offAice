import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Store } from './store';
import type { Attachment, MemberProfile, Project, RoomHistory, RoomId, RoomMessage, RoomState, RoomSummary, RoomThread, Run, Session, Snapshot } from '../shared/types';
import type { DeskFolder, DeskTopic, MemberWork, PersonalRoom, PersonalRoomData } from '../shared/member-workspaces';
import { isWorkProject } from '../shared/member-workspaces';
import { isConversationSession } from '../shared/session-classification';
import { roomMarkdown } from '../shared/room';
import { ProjectWorkbench } from './project-workbench';
import type { FlowOperation, Task } from '../shared/project-flow';
import { redact } from './security';
import { folderPath } from './folder-path';
import {mergeMemberReports} from '../shared/member-report-history';

const now = () => new Date().toISOString();
const digest = (value:unknown) => createHash('sha256').update(JSON.stringify(value)??'null').digest('hex');
const active = (run:Run) => ['queued','running','waiting_user','stopping'].includes(run.status);
const reportEntities=['project_flows','flow_plans','flow_rounds','flow_tasks','flow_submissions','flow_reviews','flow_integrations','flow_acceptances','flow_requested_checks'];
type ExecutionData={runs:Run[];operations:FlowOperation[];sessions:Map<string,Session>};
interface Host {
  createSession(projectId:string,member:MemberProfile,title:string,write:boolean):Session;
  send(sessionId:string,text:string,attachments:Attachment[]):Promise<unknown>;
  reply(roomId:RoomId,member:MemberProfile,prompt:string,attachments:Attachment[],onRun:(runId:string)=>void,shouldStart:()=>boolean):Promise<{text:string;status:string;error?:string}>;
  stop(runId:string):Promise<unknown>;
  removeSession(sessionId:string):Promise<unknown>;
  resetSession(sessionId:string):Promise<unknown>;
  changed():void;
  track(task:Promise<unknown>):void;
}

/** One-person rooms own their messages and cursors, never the project dispatch loop. */
export class MemberWorkspaces {
  private refreshing=false;
  private projected=new Map<string,string>();
  private replying=new Set<RoomId>();
  private deleting=new Set<RoomId>();
  private generations=new Map<string,number>();
  private compressions=new Map<RoomId,{threadId:string;runId?:string}>();
  private reportStamps=new Map<string,string>();
  private workbench:ProjectWorkbench;
  constructor(private store:Store,private host:Host){
    this.workbench=new ProjectWorkbench(store);
    for(const member of store.members())this.ensureMember(member.id);
    this.refresh();
  }
  /** Only an ID-derived managed child may be created or removed; junctions are never followed. */
  folder(memberId:string,create=false){
    if(!/^[A-Za-z0-9_-]{1,100}$/.test(memberId))throw new Error('成员标识不能用作个人文件夹名称');
    const root=path.join(this.store.dataDirectory,'desks'),target=path.join(root,memberId);
    if(path.relative(root,target)!==memberId)throw new Error('个人文件夹路径超出数据目录');
    for(const directory of [root,target]){
      if(existsSync(directory)){
        const info=lstatSync(directory);
        if(!info.isDirectory()||info.isSymbolicLink())throw new Error('个人文件夹不能是文件、链接或目录联接');
      }else if(create)mkdirSync(directory,{recursive:true});
    }
    if(existsSync(target)&&path.relative(realpathSync(root),realpathSync(target))!==memberId)throw new Error('个人文件夹实际路径超出管理范围');
    return target;
  }
  ensureMember(memberId:string){
    this.member(memberId);this.folder(memberId,true);
    const id:RoomId=`desk:${memberId}`;
    if(!this.store.get<PersonalRoom>('personal_rooms',id))this.store.put('personal_rooms',id,{id,kind:'desk',memberId,createdAt:now()} satisfies PersonalRoom);
    this.view(this.room(id));
    return id;
  }
  private member(id:string){const member=this.store.members().find(m=>m.id===id);if(!member)throw new Error('这位成员已不在团队中，历史记录仍可阅读');return member;}
  private room(id:RoomId){const room=this.store.get<PersonalRoom>('personal_rooms',id);if(!room)throw new Error('个人聊天不存在');return room;}
  private view(room:PersonalRoom){
    let view=this.store.get<{directory:string;key:string}>('desk_views',room.id);
    if(!view){view=folderPath(this.folder(room.memberId));this.store.put('desk_views',room.id,view);}
    return view;
  }
  private folderCursor(roomId:RoomId,key:string){return `${roomId}:${key}`;}
  private threads(room:PersonalRoom){return this.store.roomThreads(room.id).filter(thread=>room.kind!=='desk'||this.topicInFolder(room,thread.id));}
  private topicInFolder(room:PersonalRoom,threadId:string){
    const topic=this.store.get<DeskTopic>('desk_topics',threadId);
    return Boolean(topic&&!topic.deletedAt&&topic.memberId===room.memberId&&folderPath(topic.directory).key===this.view(room).key);
  }
  private scopedThread(room:PersonalRoom,threadId:string){
    const thread=this.store.roomThread(threadId,room.id);
    if(room.kind==='desk'&&!this.topicInFolder(room,threadId))throw new Error('话题不属于当前文件夹，请先切换文件夹');
    return thread;
  }
  private current(room:PersonalRoom){const id=this.store.get<{id:string}>('room_cursors',room.id)?.id;return id?this.scopedThread(room,id):undefined;}
  private requiredCurrent(room:PersonalRoom){const thread=this.current(room);if(!thread)throw new Error('当前文件夹还没有话题，请先开新话题');return thread;}
  private bump(roomId:RoomId){this.store.put('room_states',roomId,this.store.roomState(roomId));}
  private remember(room:PersonalRoom,id:string){this.store.put('desk_folder_cursors',this.folderCursor(room.id,this.view(room).key),{id});this.store.put('room_cursors',room.id,{id});}
  private restoreCursor(room:PersonalRoom){
    const view=this.view(room),threads=this.threads(room),saved=this.store.get<{id:string}>('desk_folder_cursors',this.folderCursor(room.id,view.key));
    const selected=threads.find(t=>t.id===saved?.id)??threads.sort((a,b)=>{
      const at=(t:RoomThread)=>{const topic=this.store.get<DeskTopic>('desk_topics',t.id),session=topic&&this.store.get<Session>('sessions',topic.sessionId);return session?.updatedAt??t.createdAt;};
      return at(b).localeCompare(at(a))||b.id.localeCompare(a.id);
    })[0];
    const old=this.store.get<{id:string}>('room_cursors',room.id)?.id;
    if(old===selected?.id&&(!selected||saved?.id===selected.id))return;
    if(selected)this.remember(room,selected.id);else this.store.delete('room_cursors',room.id);
    if(old!==selected?.id)this.bump(room.id);
  }
  private unread(roomId:RoomId,threadId:string){const messages=this.ordered(threadId,roomId);return messages.length>0&&this.token(threadId,roomId,messages)!==this.store.get<{fingerprint:string}>('personal_read',`${roomId}:${threadId}`)?.fingerprint;}
  private folders(room:PersonalRoom):DeskFolder[]{
    const candidates=new Map<string,{directory:string;key:string;label:string;personal:boolean}>();
    const add=(directory:string,label:string,personal=false)=>{const value=folderPath(directory),old=candidates.get(value.key);if(!old||personal)candidates.set(value.key,{...value,label,personal});};
    add(this.folder(room.memberId),'个人文件夹',true);
    for(const p of this.store.list<Project>('projects').filter(isWorkProject))add(p.directory,p.name);
    for(const f of this.store.list<{roomId:RoomId;directory:string}>('desk_folders').filter(f=>f.roomId===room.id))add(f.directory,path.basename(f.directory));
    const topics=this.store.list<DeskTopic>('desk_topics').filter(t=>t.memberId===room.memberId&&!t.deletedAt);
    for(const t of topics)add(t.directory,path.basename(t.directory));
    add(this.view(room).directory,path.basename(this.view(room).directory));
    const pendingIds=new Set(this.store.list<{runId:string;state:string}>('approvals').filter(a=>a.state==='pending').map(a=>a.runId));
    const runs=this.store.list<Run>('runs');
    return [...candidates.values()].map(f=>{const matching=topics.filter(t=>folderPath(t.directory).key===f.key),sessions=new Set(matching.map(t=>t.sessionId)),ownRuns=runs.filter(r=>sessions.has(r.sessionId));return {...f,topicCount:matching.length,unread:matching.some(t=>this.unread(room.id,t.id)),pending:ownRuns.some(r=>pendingIds.has(r.id)),active:ownRuns.some(active)};});
  }
  async switchFolder(memberId:string,p:Record<string,unknown>){
    const roomId:RoomId=`desk:${memberId}`,room=this.room(roomId);this.refresh();
    let directory:string;
    if(p.personal===true)directory=this.folder(memberId);
    else if(p.projectId){const project=this.store.get<Project>('projects',String(p.projectId));if(!project||!isWorkProject(project))throw new Error('请选择登记的工作项目');directory=project.directory;}
    else{if(typeof p.directory!=='string'||!path.isAbsolute(p.directory))throw new Error('请选择绝对目录');directory=p.directory;}
    const view=folderPath(directory);
    // A missing historical project remains readable, but arbitrary missing paths are not registered.
    if(!this.folders(room).some(f=>f.key===view.key)&&!(await stat(view.directory)).isDirectory())throw new Error('请选择文件夹');
    if(this.view(room).key!==view.key){
      const previous=this.current(room);if(previous)this.remember(room,previous.id);
      this.store.put('desk_views',roomId,view);this.store.put('desk_folders',this.folderCursor(roomId,view.key),{roomId,directory:view.directory});
      this.restoreCursor(room);this.bump(roomId);
    }
    const selected=this.current(room);if(selected)this.select(roomId,selected.id);
    this.host.changed();return this.get(roomId);
  }
  ensureReport(projectId:string,memberId:string):RoomId {
    const project=this.store.get<Project>('projects',projectId);
    if(!project||!isWorkProject(project))throw new Error('工作项目不存在');
    const id:RoomId=`report:${projectId}:${memberId}`,existing=this.store.get<PersonalRoom>('personal_rooms',id);
    if(existing?.kind==='report'&&existing.projectId===projectId&&existing.memberId===memberId)return id;
    const roster=this.workbench.memberReports({projectId,limit:1}).members;
    if(!roster.some(m=>m.id===memberId))throw new Error('这位成员没有参与当前项目');
    if(!this.store.get('personal_rooms',id)){
      const thread:RoomThread={id:randomUUID(),roomId:id,projectId,title:'个人汇报',createdAt:now()};
      this.store.transaction(()=>{this.store.put('personal_rooms',id,{id,kind:'report',projectId,memberId,createdAt:now()} satisfies PersonalRoom);this.store.put('room_threads',thread.id,thread);this.store.put('room_cursors',id,{id:thread.id});this.store.put('room_states',id,{roomId:id,active:false,mode:'chat'});});
    }
    return id;
  }
  /** Idempotent positive migration. The old Session, Run and executor records remain byte-for-byte unchanged. */
  private migrate(){
    const runs=this.store.list<Run>('runs');
    // A legacy producer may assign its positive internal ownership after creation. Remove only
    // the accidental presentation mapping; native sessions, runs and events stay untouched.
    for(const topic of this.store.list<DeskTopic>('desk_topics').filter(t=>!t.deletedAt)){
      const session=this.store.get<Session>('sessions',topic.sessionId),project=session&&this.store.get<Project>('projects',session.projectId);
      if(!session||isConversationSession(session,runs)&&project?.kind!=='lounge')continue;
      const roomId:RoomId=`desk:${topic.memberId}`;
      this.store.clearRoomThread(topic.id,roomId);this.store.delete('room_threads',topic.id);this.store.delete('desk_topics',topic.id);this.store.delete('desk_session_links',topic.sessionId);
      this.store.deleteEntitiesWhere('desk_folder_cursors',value=>(value as {id:string}).id===topic.id);this.bump(roomId);
    }
    for(const session of this.store.list<Session>('sessions')){
      if(!isConversationSession(session,runs)||this.store.get('desk_session_links',session.id)||this.store.get<DeskTopic>('desk_topics',`desk-topic-${session.id}`)?.deletedAt)continue;
      const memberId=session.memberId??session.provider,member=this.store.members().find(m=>m.id===memberId),project=this.store.get<Project>('projects',session.projectId);
      if(!member||!project||project.kind==='lounge')continue;
      const roomId=this.ensureMember(memberId),id=`desk-topic-${session.id}`;
      const topic:DeskTopic={id,memberId,sessionId:session.id,directory:project.directory,direct:session.workspaceKind==='original'&&project.kind==='desk'};
      this.store.transaction(()=>{
        this.store.put('desk_topics',id,topic);this.store.put('desk_session_links',session.id,{id});
        this.store.put('room_threads',id,{id,roomId,title:session.title,createdAt:session.createdAt,...(session.archived?{archivedAt:session.updatedAt}:{})} satisfies RoomThread);
        if(!this.store.get('room_states',roomId))this.store.put('room_states',roomId,{roomId,active:false,mode:'chat'});
      });
    }
    for(const room of this.store.list<PersonalRoom>('personal_rooms').filter(r=>r.kind==='desk')){
      const legacy=this.store.get<{id:string}>('room_cursors',room.id)?.id,topic=legacy&&this.store.get<DeskTopic>('desk_topics',legacy);
      if(topic&&!topic.deletedAt){const key=folderPath(topic.directory).key,id=this.folderCursor(room.id,key);if(!this.store.get('desk_folder_cursors',id))this.store.put('desk_folder_cursors',id,{id:topic.id});}
      this.restoreCursor(room);
    }
  }
  private putMessage(message:RoomMessage){
    const old=this.store.get<RoomMessage>('room_messages',message.id);
    const next={...message,...(old?.reactions?{reactions:old.reactions}:{}),...(old?.replyTo&&!message.replyTo?{replyTo:old.replyTo}:{})};
    if(digest(old)!==digest(next))this.store.put('room_messages',message.id,next);
  }
  private projectTopic(topic:DeskTopic){
    if(topic.deletedAt)return;
    const session=this.store.get<Session>('sessions',topic.sessionId);if(!session)return;
    const runs=this.store.list<Run>('runs').filter(r=>r.sessionId===session.id).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
    const signature=digest([this.store.eventWatermark(session.id),session.title,runs]);
    if(this.projected.get(topic.id)===signature)return;this.projected.set(topic.id,signature);
    const roomId:RoomId=`desk:${topic.memberId}`,thread=this.store.get<RoomThread>('room_threads',topic.id);
    if(!thread)return;
    const cleared=this.store.get<{runIds:string[]}>('desk_cleared',topic.id)?.runIds??[];
    const events=this.store.listEvents(session.id);
    for(const run of runs.filter(r=>!cleared.includes(r.id))){
      const messages=events.filter(e=>e.runId===run.id);
      const finals=messages.filter(e=>e.kind==='message'&&(e.data as {role?:string})?.role!=='user');
      const text=finals.map(e=>e.text).join('\n\n')||messages.filter(e=>e.kind==='delta').map(e=>e.text).join('');
      const warnings=messages.filter(e=>['warning','error'].includes(e.kind)).map(e=>e.text);
      const saved=this.store.get<{messageId:string;text:string}>('personal_run_inputs',run.id);
      this.putMessage({id:saved?.messageId??`desk-user-${run.id}`,roomId,threadId:topic.id,author:'user',text:saved?.text??run.input,at:run.createdAt,...(run.attachments?.length?{attachments:run.attachments}:{})});
      if(active(run)||text||run.error||['failed','unknown','interrupted','stopped','rate_limited'].includes(run.status))this.putMessage({id:`desk-reply-${run.id}`,roomId,threadId:topic.id,author:topic.memberId,runId:run.id,text,at:run.completedAt??run.createdAt,status:active(run)?'speaking':run.status==='ended'||run.status==='completed'?'done':run.status==='stopped'?'stopped':'failed',...(run.error||warnings.length?{error:[run.error,...warnings].filter(Boolean).join('\n')}:{}) ,...(run.generatedImages?.length?{generatedImages:run.generatedImages}:{})});
    }
  }
  /** Fact versions are append-only. A later task status cannot move or rewrite an older chat message. */
  private projectReports(projectId:string){
    let cursor:string|undefined;
    do{
      const page=this.workbench.memberReports({projectId,limit:100,cursor});cursor=page.cursor;
      for(const report of [...page.items].reverse()){
        const roomId=this.ensureReport(projectId,report.memberId),thread=this.store.currentRoomThread(roomId);
        const version=digest({...report,at:undefined}),key=`${roomId}:${report.id}`;
        const previous=this.store.get<{version:string}>('member_report_versions',key);
        if(previous?.version===version)continue;
        const id=`member-report-${randomUUID()}`;
        this.putMessage({id,roomId,threadId:thread.id,author:report.memberId,authorName:report.memberName,at:previous?now():report.at,text:report.summary.join('\n\n')||report.title,status:'done',memberReport:redact(report)});
        this.store.put('member_report_versions',key,{version});
      }
    }while(cursor);
  }
  private refreshReports(project:Project,facts=reportEntities.map(entity=>this.store.list<{projectId:string}>(entity)),names=this.store.members().map(m=>[m.id,m.name])){
    const stamp=digest([project.memberIds,names,...facts.map(rows=>rows.filter(r=>r.projectId===project.id))]);
    if(this.reportStamps.get(project.id)!==stamp){this.projectReports(project.id);this.reportStamps.set(project.id,stamp);}
  }
  private executionData():ExecutionData{return {runs:this.store.list<Run>('runs'),operations:this.store.list<FlowOperation>('flow_operations'),sessions:new Map(this.store.list<Session>('sessions').map(s=>[s.id,s]))};}
  private refreshRoom(room:PersonalRoom,data:ExecutionData){
    const running=this.roomRuns(room,data).find(active),old=this.store.roomState(room.id);
    const compression=this.compressions.get(room.id),compressing=compression&&compression.threadId===this.current(room)?.id?room.memberId:undefined;
    const next={...old,roomId:room.id,active:Boolean(running||this.replying.has(room.id)),mode:'chat' as const,speaking:running?room.memberId:undefined,compressing};
    if(old.active!==next.active||old.speaking!==next.speaking||old.compressing!==next.compressing)this.store.put('room_states',room.id,next);
  }
  refresh(){
    return this.store.readScope(()=>this.refreshFacts());
  }
  private refreshFacts(){
    if(this.refreshing)return;this.refreshing=true;
    try{
      this.migrate();
      for(const topic of this.store.list<DeskTopic>('desk_topics'))this.projectTopic(topic);
      const facts=reportEntities.map(entity=>this.store.list<{projectId:string}>(entity));
      const names=[...this.store.members(),...this.store.historicalMembers()].map(m=>[m.id,m.name]);
      for(const project of this.store.list<Project>('projects').filter(isWorkProject)){
        this.refreshReports(project,facts,names);
      }
      const data=this.executionData();
      for(const room of this.store.list<PersonalRoom>('personal_rooms'))this.refreshRoom(room,data);
    }finally{this.refreshing=false;}
  }
  private roomRuns(room:PersonalRoom,data=this.executionData()){
    const id=this.store.get<{id:string}>('room_cursors',room.id)?.id;
    const topic=id?this.store.get<DeskTopic>('desk_topics',id):undefined;
    const compression=this.compressions.get(room.id);
    return data.runs.filter(r=>r.sessionId===topic?.sessionId||(room.kind==='report'?data.sessions.get(r.sessionId)?.roomId===room.id:Boolean(compression&&compression.threadId===id&&compression.runId===r.id)));
  }
  private ordered(threadId:string,roomId:RoomId){return this.store.allRoomMessages(threadId,roomId).sort((a,b)=>a.at.localeCompare(b.at)||Number(a.author!=='user')-Number(b.author!=='user'));}
  private token(threadId:string,roomId:RoomId,messages=this.ordered(threadId,roomId)){return digest(messages.map(m=>[m.id,m.status,m.text,m.error]));}
  history(roomId:RoomId,threadId?:string,before?:string,limit=100):RoomHistory {
    const room=this.room(roomId);threadId??=this.current(room)?.id;
    if(!threadId)return {threadId:'',messages:[],hasMore:false};
    this.scopedThread(room,threadId);
    const raw=this.ordered(threadId,roomId),messages=room.kind==='report'?mergeMemberReports(raw):raw,byId=new Map(messages.map(m=>[m.id,m]));
    // A report may acquire a newer saved version while an older page is open.
    for(const message of messages)for(const version of message.memberReportVersions??[])byId.set(version.messageId,message);
    let ids=messages.map(m=>m.id),end=ids.length;
    if(before){
      try{const pos=JSON.parse(Buffer.from(before,'base64url').toString());if(before.length>2_000_000||pos.v!==1||pos.scope!==threadId||!Array.isArray(pos.ids)||pos.ids.length>50000||new Set(pos.ids).size!==pos.ids.length||pos.ids.some((id:unknown)=>typeof id!=='string'||!byId.has(id as string))||!Number.isSafeInteger(pos.end)||pos.end<0||pos.end>pos.ids.length)throw Error();ids=pos.ids;end=pos.end;}
      catch{throw new Error('历史分页位置已失效或不属于这个话题');}
    }
    const count=Math.max(1,Math.min(200,Number.isFinite(limit)?Math.floor(limit):100)),start=Math.max(0,end-count),readToken=this.token(threadId,roomId,raw);
    this.store.put('personal_read_tokens',`${roomId}:${readToken}`,{roomId,threadId,token:readToken});
    return {threadId,messages:ids.slice(start,end).flatMap(id=>byId.has(id)?[byId.get(id)!]:[]),hasMore:start>0,before:start>0?Buffer.from(JSON.stringify({v:1,scope:threadId,ids,end:start})).toString('base64url'):undefined,readToken};
  }
  async get(roomId:RoomId):Promise<PersonalRoomData>{
    return this.store.readScope(()=>this.getView(roomId));
  }
  private getView(roomId:RoomId):PersonalRoomData{
    const room=this.room(roomId);
    if(room.kind==='report'){
      const project=room.projectId&&this.store.get<Project>('projects',room.projectId);if(!project||!isWorkProject(project))throw new Error('工作项目不存在');
      this.refreshReports(project);this.refreshRoom(room,this.executionData());
    }else this.refresh();
    const current=this.current(room),topic=current&&this.store.get<DeskTopic>('desk_topics',current.id);
    return {...this.history(roomId),roomId,state:this.store.roomState(roomId),currentThreadId:current?.id??'',threads:this.threads(room),...(topic?{sessionId:topic.sessionId,direct:topic.direct}:{}),...(room.kind==='desk'?{directory:this.view(room).directory,folderKey:this.view(room).key,personalFolder:this.folder(room.memberId),folders:this.folders(room)}:{})};
  }
  overviews():NonNullable<Snapshot['rooms']>{
    const data=this.executionData(),topics=this.store.list<DeskTopic>('desk_topics'),pendingIds=new Set(this.store.list<{runId:string;state:string}>('approvals').filter(a=>a.state==='pending').map(a=>a.runId));
    return this.store.list<PersonalRoom>('personal_rooms').map(room=>{
      const current=this.current(room),state=this.store.roomState(room.id),topic=current&&this.store.get<DeskTopic>('desk_topics',current.id);
      const threads=this.store.roomThreads(room.id);
      const unread=threads.some(t=>this.unread(room.id,t.id));
      const topicSessions=new Set(topics.filter(t=>t.memberId===room.memberId&&!t.deletedAt).map(t=>t.sessionId));
      const reportRunIds=room.kind==='report'?this.executionScope(room.projectId!,room.memberId,data).runIds:new Set<string>();
      const pending=data.runs.some(r=>pendingIds.has(r.id)&&(room.kind==='desk'?topicSessions.has(r.sessionId):data.sessions.get(r.sessionId)?.roomId===room.id||reportRunIds.has(r.id)));
      return {roomId:room.id,kind:room.kind,memberId:room.memberId,projectId:room.projectId,revision:state.revision??0,currentThreadId:current?.id??'',state,unread,pending,...(topic?{sessionId:topic.sessionId}:{}),...(room.kind==='desk'?{folder:this.view(room).directory,folderKey:this.view(room).key}:{})};
    });
  }
  private idle(roomId:RoomId){if(this.replying.has(roomId)||this.roomRuns(this.room(roomId)).some(active)||this.store.roomState(roomId).compressing)throw new Error('请先停止当前话题并等运行结束');}
  async newTopic(roomId:RoomId,p:Record<string,unknown>){
    const room=this.room(roomId);if(room.kind!=='desk')throw new Error('个人汇报使用固定对话');this.idle(roomId);
    const member=this.member(room.memberId),personal=this.folder(member.id,true);
    const view=this.view(room),directory=view.directory;
    const requested=p.projectId?this.store.get<Project>('projects',String(p.projectId))?.directory:p.directory;
    if((p.projectId||p.directory)&&(typeof requested!=='string'||folderPath(requested).key!==view.key))throw new Error('请先切换文件夹，再在当前文件夹开新话题');
    if(!(await stat(directory)).isDirectory())throw new Error('当前文件夹不可用，历史保留；请选择可用文件夹');
    const direct=view.key===folderPath(personal).key;
    let project=this.store.list<Project>('projects').find(p=>isWorkProject(p)&&folderPath(p.directory).key===view.key);
    if(!project){const id=`desk-work-${digest([member.id,view.key]).slice(0,24)}`;project=this.store.get<Project>('projects',id)??{id,name:`${member.name} 的工位`,directory,createdAt:now(),collaborationPaused:false,kind:'desk'};this.store.put('projects',id,project);}
    const title=String(p.title??'当前话题').trim().slice(0,80)||'当前话题';
    const current=this.store.get<{id:string}>('room_cursors',roomId)?.id,previous=current?this.store.get<RoomThread>('room_threads',current):undefined;
    if(p.inherit===true&&!previous?.summary)throw new Error('请先压缩当前话题再延续摘要');
    const created=this.host.createSession(project.id,member,title,true),session={...created,...(direct?{workspace:personal,workspaceKind:'original' as const}:{})};
    this.store.put('sessions',session.id,session);
    // createSession may broadcast and migrate it before returning; use the same deterministic mapping.
    const id=`desk-topic-${session.id}`,topic:DeskTopic={id,memberId:member.id,sessionId:session.id,directory,direct};
    this.store.transaction(()=>{
      if(previous)this.store.put('room_threads',previous.id,{...previous,archivedAt:now()});
      this.store.put('desk_topics',id,topic);this.store.put('desk_session_links',session.id,{id});
      this.store.put('room_threads',id,{id,roomId,title,autoTitle:!String(p.title??'').trim(),createdAt:session.createdAt,...(p.inherit===true&&previous?.summary?{inherited:{threadId:previous.id,title:previous.title,text:previous.summary.text}}:{})} satisfies RoomThread);
      this.remember(room,id);this.store.put('room_states',roomId,{roomId,active:false,mode:'chat'});
    });
    this.host.changed();return this.store.roomThread(id,roomId);
  }
  select(roomId:RoomId,threadId:string){
    const room=this.room(roomId);if(room.kind!=='desk')throw new Error('个人汇报使用固定对话');
    const thread=this.scopedThread(room,threadId),topic=this.store.get<DeskTopic>('desk_topics',threadId);
    if(!topic||topic.deletedAt)throw new Error('话题已经删除');
    const current=this.current(room),same=current?.id===threadId;if(!same)this.idle(roomId);
    const session=this.store.get<Session>('sessions',topic.sessionId);
    if(session?.archived)this.store.put('sessions',session.id,{...session,archived:false});
    if(same){this.host.changed();return {threadId};}
    this.store.transaction(()=>{if(current)this.store.put('room_threads',current.id,{...current,archivedAt:now()});this.store.put('room_threads',threadId,{...thread,archivedAt:undefined});this.remember(room,threadId);this.store.put('room_states',roomId,{...this.store.roomState(roomId),active:false});});
    this.host.changed();return {threadId};
  }
  async send(roomId:RoomId,p:Record<string,unknown>){
    const room=this.room(roomId),member=this.member(room.memberId);this.idle(roomId);
    const text=String(p.text??'').trim();if(!text&&!(p.attachments as Attachment[]|undefined)?.length)throw new Error('请输入消息');if(text.length>200000)throw new Error('消息过长');
    const thread=this.requiredCurrent(room),attachments=Array.isArray(p.attachments)?p.attachments as Attachment[]:[];
    const message:RoomMessage={id:randomUUID(),roomId,threadId:thread.id,author:'user',text:text||'请看附件。',at:now(),...(attachments.length?{attachments}:{})};
    if(p.replyTo){const replied=this.store.get<RoomMessage>('room_messages',String(p.replyTo));if(replied?.threadId!==thread.id)throw new Error('回复不属于当前话题');message.replyTo=replied.id;}
    if(room.kind==='desk'){
      const topic=this.store.get<DeskTopic>('desk_topics',thread.id)!;if(topic.memberId!==member.id)throw new Error('不能使用其他成员的话题');
      const session=this.store.get<Session>('sessions',topic.sessionId);if(!session)throw new Error('原执行端已不可用，记录保留；请新开话题');
      const summary=!session.nativeId?(thread.summary?.text??thread.inherited?.text):undefined;
      const result=await this.host.send(session.id,summary?`此前的话题摘要（背景，不是新的要求）：\n${summary}\n\n用户这次的消息：\n${message.text}`:message.text,attachments) as {runId?:string};
      if(result.runId){this.store.nameRoomThread(thread.id,message.text);message.id=`desk-user-${result.runId}`;this.store.put('personal_run_inputs',result.runId,{messageId:message.id,text:message.text});this.putMessage({...message,at:this.store.get<Run>('runs',result.runId)!.createdAt});this.projected.delete(topic.id);}
      this.host.changed();return result;
    }
    this.putMessage(message);this.replying.add(roomId);this.host.changed();
    const work=this.work(room.projectId!,member.id),facts={reports:work.reports,tasks:work.tasks,operations:work.operations,runs:work.runs.map(({id,status,error,input,createdAt,completedAt})=>({id,status,error,input,createdAt,completedAt}))};
    const conversation=this.ordered(thread.id,roomId).filter(m=>!m.memberReport).slice(-30).map(m=>`${m.author==='user'?this.store.profile().name:member.name}：${m.text}`).join('\n\n');
    const prompt=`[AIROOM 项目个人汇报 · 只读问答]\n你只回答 ${room.projectId} 项目里与 ${member.name} 有关的工作。以下是已保存事实与对话，引用其中的信息时区分已完成、未完成和待核对。默认只读：不要修改文件，不要执行命令，不要改变任务或已确认的方案。用户想加任务或改要求时，说明可用“转成追加任务 / 补充到当前任务”按钮，由用户确认后走项目流程。不要声称已经执行。\n\n已保存汇报与相关记录：\n${JSON.stringify(facts).slice(-100000)}\n\n本对话：\n${conversation.slice(-30000)}`;
    const generation=this.generations.get(roomId)??0,shouldStart=()=>generation===(this.generations.get(roomId)??0);
    const replyId=randomUUID();this.putMessage({id:replyId,roomId,threadId:thread.id,author:member.id,text:'',at:now(),status:'speaking',replyTo:message.id});
    const task=this.host.reply(roomId,member,prompt,attachments,runId=>{const old=this.store.get<RoomMessage>('room_messages',replyId)!;this.putMessage({...old,runId});this.host.changed();},shouldStart).then(result=>{
      const old=this.store.get<RoomMessage>('room_messages',replyId)!;this.putMessage({...old,text:result.text,at:now(),status:result.status==='done'?'done':result.status==='stopped'?'stopped':'failed',...(result.error?{error:result.error}:{})});
    }).catch(error=>{const old=this.store.get<RoomMessage>('room_messages',replyId)!;this.putMessage({...old,status:'failed',error:redact((error as Error).message)});}).finally(()=>{this.replying.delete(roomId);this.host.changed();});
    this.host.track(task);return {messageId:message.id};
  }
  private executionScope(projectId:string,memberId:string,data=this.executionData()){
    const operations=data.operations.filter(op=>{const session=op.sessionId&&data.sessions.get(op.sessionId);return op.projectId===projectId&&session&&(session.memberId??session.provider)===memberId;});
    const ids=new Set(operations.flatMap(op=>[op.id]));
    const ownedRuns=new Set(operations.flatMap(op=>[op.runId,op.correctionRunId]).filter(Boolean));
    const runs=data.runs.filter(run=>run.projectId===projectId&&(ids.has(run.flowOperationId??'')||ownedRuns.has(run.id))&&(data.sessions.get(run.sessionId)?.memberId??run.provider)===memberId);
    const sessionIds=new Set(runs.map(r=>r.sessionId)),runIds=new Set(runs.map(r=>r.id));
    return {operations,runs,sessionIds,runIds};
  }
  work(projectId:string,memberId:string):MemberWork {
    this.ensureReport(projectId,memberId);
    const {operations,runs,sessionIds,runIds}=this.executionScope(projectId,memberId);
    const reports=[] as MemberWork['reports'];let cursor:string|undefined;
    do{const page=this.workbench.memberReports({projectId,memberId,limit:100,cursor});reports.push(...page.items);cursor=page.cursor;}while(cursor);
    return {projectId,memberId,runs,sessions:this.store.list<Session>('sessions').filter(s=>sessionIds.has(s.id)),operations,tasks:this.store.list<Task>('flow_tasks').filter(t=>t.projectId===projectId&&t.memberId===memberId),approvals:this.store.list<MemberWork['approvals'][number]>('approvals').filter(a=>runIds.has(a.runId)),events:this.store.liveEvents().filter(e=>runIds.has(e.runId)),reports};
  }
  preserveMemberFolder(memberId:string){
    return {folder:this.folder(memberId),kept:true};
  }
  cancelPending(memberId?:string){for(const room of this.store.list<PersonalRoom>('personal_rooms').filter(room=>!memberId||room.memberId===memberId)){const key=this.compressions.get(room.id)?.threadId??room.id;this.generations.set(key,(this.generations.get(key)??0)+1);}}
  sessionRemoved(sessionId:string){
    const link=this.store.get<{id:string}>('desk_session_links',sessionId),topic=link&&this.store.get<DeskTopic>('desk_topics',link.id);
    if(!topic)return;
    const roomId:RoomId=`desk:${topic.memberId}`;
    this.store.clearRoomThread(topic.id,roomId);this.store.delete('room_threads',topic.id);
    this.store.put('desk_topics',topic.id,{...topic,deletedAt:now()});
    this.store.deleteEntitiesWhere('desk_folder_cursors',value=>(value as {id:string}).id===topic.id);
    if(this.store.get<{id:string}>('room_cursors',roomId)?.id===topic.id)this.store.delete('room_cursors',roomId);
    this.bump(roomId);
  }
  projectRemoved(projectId:string){
    for(const room of this.store.list<PersonalRoom>('personal_rooms').filter(r=>r.projectId===projectId)){
      for(const thread of this.store.roomThreads(room.id)){this.store.clearRoomThread(thread.id,room.id);this.store.delete('room_threads',thread.id);}
      for(const entity of ['personal_rooms','room_cursors','room_states'])this.store.delete(entity,room.id);
    }
  }
  projectBusy(projectId:string){return this.store.list<PersonalRoom>('personal_rooms').some(r=>r.projectId===projectId&&this.replying.has(r.id));}
  async invoke(method:string,p:Record<string,unknown>,roomId:RoomId):Promise<unknown>{
    const room=this.room(roomId);
    if(this.deleting.has(roomId)&&!['room.get','room.history','room.export','room.read','room.stop'].includes(method))throw new Error('话题正在删除，请稍后操作。');
    switch(method){
      case 'room.get':return this.get(roomId);
      case 'room.history':return this.history(roomId,p.threadId?String(p.threadId):undefined,p.before?String(p.before):undefined,Number(p.limit)||100);
      case 'room.send':return this.send(roomId,p);
      case 'room.archive':return this.newTopic(roomId,p);
      case 'room.select':return this.select(roomId,String(p.threadId));
      case 'room.read':{const token=String(p.readToken??''),known=this.store.get<{roomId:RoomId;threadId:string}>('personal_read_tokens',`${roomId}:${token}`);if(!known||known.threadId!==this.current(room)?.id)throw new Error('阅读位置不属于当前话题');this.store.put('personal_read',`${roomId}:${known.threadId}`,{fingerprint:token});this.host.changed();return {read:true};}
      case 'room.stop':{const compression=this.compressions.get(roomId),key=room.kind==='desk'?this.current(room)?.id:roomId;if(key)this.generations.set(key,(this.generations.get(key)??0)+1);for(const run of this.roomRuns(room).filter(active))await this.host.stop(run.id);if(compression?.threadId===key)this.bump(roomId);this.host.changed();return {stopped:true};}
      case 'room.rename':{if(room.kind!=='desk')throw new Error('个人汇报使用固定对话');const thread=this.scopedThread(room,String(p.threadId)),title=String(p.title??'').trim().slice(0,80);if(!title)throw new Error('话题名称不能为空');this.store.put('room_threads',thread.id,{...thread,title,autoTitle:false});const topic=this.store.get<DeskTopic>('desk_topics',thread.id);if(topic){const session=this.store.get<Session>('sessions',topic.sessionId);if(session)this.store.put('sessions',session.id,{...session,title,autoTitle:false});}this.host.changed();return {title};}
      case 'room.delete':{if(room.kind!=='desk')throw new Error('汇报记录不能删除');this.idle(roomId);const thread=this.scopedThread(room,String(p.threadId)),topic=this.store.get<DeskTopic>('desk_topics',thread.id)!;if(this.compressions.get(roomId)?.threadId===thread.id)throw new Error('请先停止这个话题的压缩');this.deleting.add(roomId);try{await this.host.removeSession(topic.sessionId);this.store.transaction(()=>{this.store.put('desk_topics',topic.id,{...topic,deletedAt:now()});if(this.store.get('room_threads',thread.id)){this.store.clearRoomThread(thread.id,roomId);this.store.delete('room_threads',thread.id);this.bump(roomId);}this.restoreCursor(room);});const next=this.current(room);if(next){this.select(roomId,next.id);if(next.archivedAt)this.store.put('room_threads',next.id,{...next,archivedAt:undefined});}this.host.changed();return {deleted:true};}finally{this.deleting.delete(roomId);}}
      case 'room.clear':{if(room.kind!=='desk')throw new Error('汇报记录不能清空');this.idle(roomId);const thread=this.requiredCurrent(room),topic=this.store.get<DeskTopic>('desk_topics',thread.id)!;await this.host.resetSession(topic.sessionId);this.store.put('desk_cleared',topic.id,{runIds:this.roomRuns(room).map(r=>r.id)});this.store.clearRoomThread(thread.id,roomId);this.store.put('room_threads',thread.id,{...thread,summary:undefined,inherited:undefined});this.projected.delete(topic.id);this.host.changed();return {cleared:true};}
      case 'room.uninherit':{this.idle(roomId);const thread=this.requiredCurrent(room);this.store.put('room_threads',thread.id,{...thread,inherited:undefined});this.host.changed();return {removed:true};}
      case 'room.export':{const thread=this.scopedThread(room,String(p.threadId??this.requiredCurrent(room).id)),names=new Map([...this.store.historicalMembers(),...this.store.members()].map(m=>[m.id,m.name]));return {title:thread.title,content:roomMarkdown(thread,this.ordered(thread.id,roomId),id=>id==='user'?this.store.profile().name:names.get(id)??id)};}
      case 'room.compress':return this.compress(roomId,String(p.threadId??this.requiredCurrent(room).id));
      default:throw new Error('个人聊天不支持这个操作');
    }
  }
  private async compress(roomId:RoomId,threadId:string){
    const room=this.room(roomId);if(room.kind!=='desk')throw new Error('个人汇报保持事实记录，不压缩');this.idle(roomId);
    if(this.compressions.has(roomId))throw new Error('另一个文件夹的话题正在压缩，请等待完成');
    const thread=this.scopedThread(room,threadId);if(thread.id!==this.requiredCurrent(room).id)throw new Error('请先打开要压缩的话题');
    const member=this.member(room.memberId),topic=this.store.get<DeskTopic>('desk_topics',thread.id)!;
    if(this.store.get<Session>('sessions',topic.sessionId)?.restoredHistoryOnly)throw new Error('这份话题仅保留历史；继续工作请新开话题');
    const compression={threadId:thread.id} as {threadId:string;runId?:string};this.compressions.set(roomId,compression);
    this.store.put('room_states',roomId,{...this.store.roomState(roomId),compressing:member.id});this.host.changed();
    const generation=this.generations.get(threadId)??0,shouldStart=()=>generation===(this.generations.get(threadId)??0);
    try{
      const messages=this.ordered(thread.id,roomId),transcript=messages.map(m=>`${m.author==='user'?this.store.profile().name:member.name}：${m.text}`).join('\n\n');
      const result=await this.host.reply(roomId,member,`[AIROOM 话题压缩]\n只整理以下对话，不用工具，不读写文件。用不超过 800 字保留目标、要求、结论、未完成工作及未知结果。不要把未完成说成已完成。\n此前摘要：${thread.summary?.text??thread.inherited?.text??'无'}\n\n${transcript.slice(-60000)}`,[],runId=>{compression.runId=runId;this.host.changed();},shouldStart);
      if(!shouldStart()||result.status!=='done'||!result.text.trim())throw new Error(result.error??'压缩未完成');
      await this.host.resetSession(topic.sessionId);
      const summary:RoomSummary={text:result.text.slice(0,8000),by:member.id,byName:member.name,at:now(),count:messages.length,upTo:messages.at(-1)?.id};
      this.store.put('room_threads',thread.id,{...this.store.roomThread(thread.id,roomId),summary});return summary;
    }finally{this.compressions.delete(roomId);this.store.put('room_states',roomId,{...this.store.roomState(roomId),compressing:undefined});this.host.changed();}
  }
}
