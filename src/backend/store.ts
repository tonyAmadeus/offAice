import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {RoomId, AcpExecutor, TimelineEvent, Run, Approval, Collaboration, Project, Snapshot, Settings, ProviderInfo, MemberProfile, UserProfile, RoomMessage, RoomState, RoomThread, RoomHistory } from '../shared/types';
import { scopedRoomStore } from './room-store';
import { BUILTIN_MEMBERS, DEFAULT_PROFILE, DEFAULT_SETTINGS } from '../shared/defaults';
import { DEFAULT_ROOM_THREAD, ROOM_PAGE_SIZE, firstMessageTitle, isRoomPass, roomReaction, toggleReaction } from '../shared/room';
import { redact } from './security';
import {callUsage} from '../shared/call-usage';
import {roundtableContextMessage} from '../shared/roundtable';
const attentionReferenceFields:Partial<Record<string,'projectId'|'sessionId'|'runId'|'threadId'|'roomId'>>={projects:'projectId',sessions:'sessionId',runs:'runId',room_threads:'threadId',personal_rooms:'roomId'};

export class Store {
  readonly dataDirectory:string;
  private readonly db:DatabaseSync;
  private entityRead?:StatementSync;
  private entityList?:StatementSync;
  private roomsReady=false;
  private readCache?:Map<string,unknown>;
  /** Reuse decoded facts during one synchronous projection; every write invalidates them. */
  readScope<T>(action:()=>T):T {
    if(this.readCache)return action();
    this.readCache=new Map();try{return action();}finally{this.readCache=undefined;}
  }
  private cachedRead<T>(key:string,read:()=>T):T {
    if(!this.readCache)return read();
    if(!this.readCache.has(key))this.readCache.set(key,read());
    return this.readCache.get(key) as T;
  }
  constructor(dataDirectory:string) {
    this.dataDirectory=path.resolve(dataDirectory);
    mkdirSync(this.dataDirectory,{recursive:true});
    mkdirSync(path.join(this.dataDirectory,'logs'),{recursive:true});
    this.db=new DatabaseSync(path.join(this.dataDirectory,'airoom.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS entities (entity TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(entity,id));
      CREATE INDEX IF NOT EXISTS entities_kind_order ON entities(entity);
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL, session_id TEXT NOT NULL,run_id TEXT NOT NULL,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id,sequence);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id,sequence);
      CREATE INDEX IF NOT EXISTS room_thread_messages ON entities(COALESCE(json_extract(value,'$.threadId'),'room-main')) WHERE entity='room_messages';
      CREATE INDEX IF NOT EXISTS room_speaking_runs ON entities(json_extract(value,'$.runId')) WHERE entity='room_messages' AND json_extract(value,'$.status')='speaking';`);
    try{
      this.migrateRoomHistory();this.roomsReady=true;
      for(const project of this.list<Project>('projects').filter(p=>!p.kind))this.ensureProjectRoom(project.id);
    }catch(error){this.db.close();throw error;}
  }
  private migrateRoomHistory() {
    if(this.get('room_migrations','rooms-v1'))return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.list<RoomThread>('room_threads').length) {
        const messages = this.list<RoomMessage>('room_messages');
        this.put('room_threads', DEFAULT_ROOM_THREAD, { id: DEFAULT_ROOM_THREAD, title: '当前话题', createdAt: messages[0]?.at ?? new Date().toISOString() });
      }
      const unscoped=this.list<RoomMessage>('room_messages').find(message=>!message.threadId);
      if(unscoped&&!this.get('room_threads',DEFAULT_ROOM_THREAD))this.put('room_threads',DEFAULT_ROOM_THREAD,{id:DEFAULT_ROOM_THREAD,title:'历史记录',createdAt:unscoped.at,archivedAt:new Date().toISOString()});
      const current = this.get<{ id: string }>('room', 'current');
      const thread = current && this.get<RoomThread>('room_threads', current.id);
      const active = thread && !thread.archivedAt ? thread : this.list<RoomThread>('room_threads').find(item => !item.archivedAt);
      if (!active) throw new Error('聊天室缺少当前话题');
      for(const thread of this.list<RoomThread>('room_threads'))this.put('room_threads',thread.id,{...thread,roomId:'global'});
      this.put('room_cursors','global',{id:active.id});
      this.put('room_states','global',{...this.get<RoomState>('room','state')??{active:false,mode:'chat'},roomId:'global',revision:1});
      this.db.prepare("UPDATE entities SET value=json_set(value,'$.threadId',?) WHERE entity='room_messages' AND json_extract(value,'$.threadId') IS NULL").run(DEFAULT_ROOM_THREAD);
      this.put('room_migrations','rooms-v1',{at:new Date().toISOString(),legacyCurrent:current?.id,globalThreadId:active.id});
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  transaction<T>(action:()=>T):T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=action();this.db.exec('COMMIT');return result; }
    catch(error) { this.db.exec('ROLLBACK');this.readCache?.clear();throw error; }
  }
  get<T>(entity:string,id:string):T|undefined {
    if(this.roomsReady&&entity==='room'&&(id==='state'||id==='current')){entity=id==='state'?'room_states':'room_cursors';id='global';}
    const bytes=this.cachedRead('get:'+JSON.stringify([entity,id]),()=>{
      const query=this.entityRead??=this.db.prepare('SELECT value FROM entities WHERE entity=? AND id=?');
      return (query.get(entity,id) as {value:string}|undefined)?.value;
    });
    // Each caller still receives its own object; mutating a read is never a write.
    return bytes===undefined?undefined:JSON.parse(bytes) as T;
  }
  list<T>(entity:string):T[] {
    return [...this.cachedRead('list:'+entity,()=>((this.entityList??=this.db.prepare('SELECT value FROM entities WHERE entity=? ORDER BY rowid')).all(entity) as {value:string}[]).map(row=>JSON.parse(row.value) as T))];
  }
  put(entity:string,id:string,value:unknown):void {
    if(this.roomsReady&&entity==='room'&&(id==='state'||id==='current')){entity=id==='state'?'room_states':'room_cursors';id='global';}
    if(entity==='room_states'){const old=this.get<RoomState>(entity,id);value={...(value as RoomState),roomId:id,revision:(old?.revision??0)+1};}
    if(this.roomsReady&&entity==='room_threads')value={...(value as RoomThread),roomId:(value as RoomThread).roomId??this.get<RoomThread>(entity,id)?.roomId??'global'};
    if(this.roomsReady&&entity==='room_messages'){
      const message=value as RoomMessage;
      if(message.author==='user'&&(message.roomId??'global')==='global'&&!message.system&&!message.contextOnly&&!message.discussionControl)this.nameRoomThread(message.threadId??DEFAULT_ROOM_THREAD,message.text);
    }
    this.db.prepare('INSERT INTO entities(entity,id,value) VALUES(?,?,?) ON CONFLICT(entity,id) DO UPDATE SET value=excluded.value').run(entity,id,JSON.stringify(redact(value)));
    this.readCache?.clear();
    if(this.roomsReady&&(entity==='room_threads'||entity==='room_messages')){const roomId=entity==='room_threads'?(value as RoomThread).roomId:this.get<RoomThread>('room_threads',(value as RoomMessage).threadId??DEFAULT_ROOM_THREAD)?.roomId;if(roomId)this.put('room_states',roomId,this.roomState(roomId));}
  }
  /** Legacy empty default topics may opt in; existing named topics remain untouched. */
  nameRoomThread(threadId:string,text:string){
    const thread=this.get<RoomThread>('room_threads',threadId),roomId=thread?.roomId??'global';
    if(!thread||roomId!=='global'&&!roomId.startsWith('desk:')||thread.autoTitle===false||thread.autoTitle!==true&&thread.title!=='当前话题')return;
    if(thread.autoTitle!==true&&this.db.prepare("SELECT 1 FROM entities WHERE entity='room_messages' AND COALESCE(json_extract(value,'$.threadId'),'room-main')=? AND json_extract(value,'$.author')='user' AND COALESCE(json_extract(value,'$.system'),0)=0 AND COALESCE(json_extract(value,'$.contextOnly'),0)=0 AND COALESCE(json_extract(value,'$.discussionControl'),0)=0 LIMIT 1").get(threadId)){this.put('room_threads',threadId,{...thread,autoTitle:false});return;}
    const title=firstMessageTitle(text,this.members());if(!title)return;
    this.put('room_threads',threadId,{...thread,title,autoTitle:false});
    if(roomId.startsWith('desk:')){
      const topic=this.get<{sessionId:string}>('desk_topics',threadId),session=topic&&this.get<import('../shared/types').Session>('sessions',topic.sessionId);
      if(session)this.put('sessions',session.id,{...session,title,autoTitle:false});
    }
  }
  putMany(items:{entity:string;id:string;value:unknown}[]):void {
    const write=()=>{for(const item of items)this.put(item.entity,item.id,item.value);};
    if(this.db.isTransaction)write();else this.transaction(write);
  }
  /** Bounded operational history; no need to decode the entire entity on every snapshot. */
  recent<T>(entity:string,limit=40,system?:boolean):T[]{
    const count=Math.max(1,Math.min(2000,Math.floor(limit)));
    const query=`SELECT value FROM entities WHERE entity=?${system===undefined?'':" AND COALESCE(json_extract(value,'$.system'),0)=?"} ORDER BY rowid DESC LIMIT ?`;
    const rows=(system===undefined?this.db.prepare(query).all(entity,count):this.db.prepare(query).all(entity,system?1:0,count)) as {value:string}[];return rows.map(row=>JSON.parse(row.value));
  }
  pruneHistory(entity:string,keep:number,system=false){this.db.prepare("DELETE FROM entities WHERE entity=? AND id IN (SELECT id FROM entities WHERE entity=? AND COALESCE(json_extract(value,'$.system'),0)=? AND json_extract(value,'$.status')<>'running' ORDER BY rowid DESC LIMIT -1 OFFSET ?)").run(entity,entity,system?1:0,Math.max(1,keep));this.readCache?.clear();}
  private clearAttentionReferences(field:'projectId'|'sessionId'|'runId'|'threadId'|'roomId',id:string){
    this.db.prepare("DELETE FROM entities WHERE entity='attention_dismissals' AND json_extract(value,?)=?").run('$.'.concat(field),id);
  }
  delete(entity:string,id:string):void {
    this.readCache?.clear();
    if(entity==='room_threads')this.db.prepare("DELETE FROM entities WHERE entity='composer_drafts' AND json_extract(value,'$.threadId')=?").run(id);
    const field=attentionReferenceFields[entity],remove=()=>{this.db.prepare('DELETE FROM entities WHERE entity=? AND id=?').run(entity,id);if(field)this.clearAttentionReferences(field,id);};
    if(field&&!this.db.isTransaction)this.transaction(remove);else remove();
  }
  deleteEntitiesWhere(entity:string,match:(value:unknown)=>boolean):void {
    for (const row of this.db.prepare('SELECT id,value FROM entities WHERE entity=?').all(entity) as {id:string;value:string}[]) if (match(JSON.parse(row.value))) this.delete(entity,row.id);
  }
  deleteSessionEvents(sessionId:string):void { this.db.prepare('DELETE FROM events WHERE session_id=?').run(sessionId); }
  /** The newest quota report per executor, so the usage meter works without shipping every event. */
  private latestUsage=new Map<string,{sequence:number;event:TimelineEvent}>();
  private usageLoaded=false;
  private rememberUsage(event:TimelineEvent,sequence:number){
    const data=event.data as {rateLimits?:{primary?:unknown};rateLimit?:unknown}|undefined;
    if(!data||typeof data!=='object'||!(data.rateLimits?.primary||data.rateLimit))return;
    const known=this.latestUsage.get(event.provider);if(!known||known.sequence<sequence)this.latestUsage.set(event.provider,{sequence,event});
  }
  private loadUsage(){
    if(this.usageLoaded)return;this.usageLoaded=true;
    // One pass at startup; afterwards appendEvent keeps it current.
    const rows=this.db.prepare("SELECT sequence,value FROM events WHERE value LIKE '%\"rateLimit%' ORDER BY sequence").all() as {sequence:number;value:string}[];
    for(const row of rows)this.rememberUsage(JSON.parse(row.value),row.sequence);
  }
  /** Live runs, replies still handing their text to the room, and the latest usage. Other history loads on demand. */
  liveEvents():TimelineEvent[]{
    this.loadUsage();
    // Native completion precedes the coordinator's final message write. Keep its existing text across that gap.
    const speaking=new Set((this.db.prepare("SELECT json_extract(value,'$.runId') AS runId FROM entities WHERE entity='room_messages' AND json_extract(value,'$.status')='speaking' AND json_type(value,'$.runId')='text'").all() as {runId:string}[]).map(row=>row.runId));
    const active=this.list<Run>('runs').filter(run=>speaking.has(run.id)||!run.completedAt&&['queued','running','waiting_user','stopping','rate_limited'].includes(run.status)).map(run=>run.id);
    const rows=active.length?this.db.prepare(`SELECT sequence,value FROM events WHERE run_id IN (${active.map(()=>'?').join(',')}) ORDER BY sequence`).all(...active) as {sequence:number;value:string}[]:[];
    const usage=[...this.latestUsage.values()].filter(item=>!rows.some(row=>row.sequence===item.sequence));
    return [...usage,...rows.map(row=>({sequence:row.sequence,event:JSON.parse(row.value) as TimelineEvent}))].sort((a,b)=>a.sequence-b.sequence).map(item=>item.event);
  }
  appendEvent(event:TimelineEvent):void {
    const safe=redact(event);
    // Persistent event IDs make retries idempotent; never log a second duplicate.
    const inserted=this.db.prepare('INSERT OR IGNORE INTO events(id,session_id,run_id,value) VALUES(?,?,?,?)').run(safe.id,safe.sessionId,safe.runId,JSON.stringify(safe));
    const date=/^\d{4}-\d{2}-\d{2}T/.test(safe.at)?safe.at.slice(0,10):new Date().toISOString().slice(0,10);
    if (inserted.changes) this.rememberUsage(safe,Number(inserted.lastInsertRowid));
    if (inserted.changes) appendFileSync(path.join(this.dataDirectory,'logs',`${date}.jsonl`),JSON.stringify(safe)+'\n','utf8');
  }
  listEvents(sessionId?:string):TimelineEvent[] {
    const query=sessionId ? this.db.prepare('SELECT value FROM events WHERE session_id=? ORDER BY sequence') : this.db.prepare('SELECT value FROM events ORDER BY sequence');
    const rows=(sessionId ? query.all(sessionId) : query.all()) as {value:string}[];
    return rows.map(row=>JSON.parse(row.value) as TimelineEvent);
  }
  /** Indexed by the requested runs, without decoding unrelated session or project history. */
  eventsForRuns(runIds: readonly (string | undefined)[]): TimelineEvent[] {
    const ids = [...new Set(runIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
    if (!ids.length) return [];
    const rows = this.db.prepare('SELECT value FROM events WHERE run_id IN (SELECT value FROM json_each(?)) ORDER BY sequence').all(JSON.stringify(ids)) as { value: string }[];
    return rows.map(row => JSON.parse(row.value) as TimelineEvent);
  }
  runEvents(runId:string):TimelineEvent[] {return this.eventsForRuns([runId]);}
  /** Notification routing needs references, never every historical reply body. */
  roomMessageReferences(): Array<Pick<RoomMessage, 'id'> & Partial<Pick<RoomMessage, 'runId' | 'threadId' | 'at' | 'discussionControl' | 'link'>>> {
    return [...this.cachedRead('room-message-references', () => {
      const rows = this.db.prepare(`SELECT id,
        json_extract(value,'$.runId') AS runId,
        json_extract(value,'$.threadId') AS threadId,
        json_extract(value,'$.at') AS at,
        json_extract(value,'$.discussionControl') AS discussionControl,
        json_extract(value,'$.link') AS link
        FROM entities WHERE entity='room_messages' ORDER BY rowid`).all() as {
          id: string; runId: string | null; threadId: string | null; at: string | null;
          discussionControl: number | null; link: string | null;
        }[];
      return rows.map(row => ({
        id: row.id, runId: row.runId ?? undefined, threadId: row.threadId ?? undefined, at: row.at ?? undefined,
        discussionControl: row.discussionControl === null ? undefined : Boolean(row.discussionControl),
        link: row.link === null ? undefined : JSON.parse(row.link) as RoomMessage['link'],
      }));
    })];
  }
  /** Log-only pagination: a global sequence can have gaps between these runs. It is not a message cursor. */
  eventWatermark(sessionId?:string):number {const query=this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM events'+(sessionId?' WHERE session_id=?':''));return Number(((sessionId?query.get(sessionId):query.get()) as {n:number}).n);}
  eventPage(runIds:string[],after:number,through:number,limit:number):{sequence:number;event:TimelineEvent}[] {
    const rows=this.db.prepare('SELECT sequence,value FROM events WHERE run_id IN (SELECT value FROM json_each(?)) AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').all(JSON.stringify(runIds),after,through,limit) as {sequence:number;value:string}[];
    return rows.map(row=>({sequence:row.sequence,event:JSON.parse(row.value)}));
  }
  /** Bounded native command records, retaining both the beginning and end of a long run. */
  nativeToolEventWindow(runId:string,limit=12):{total:number;events:TimelineEvent[]} {
    const size=Math.max(2,Math.min(40,Math.floor(limit))),where="run_id=? AND json_extract(value,'$.fidelity')='native' AND json_extract(value,'$.kind') IN ('tool','output')";
    const total=Number((this.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${where}`).get(runId) as {n:number}).n);
    const head=this.db.prepare(`SELECT sequence,value FROM events WHERE ${where} ORDER BY sequence LIMIT ?`).all(runId,Math.ceil(size/2)) as {sequence:number;value:string}[];
    const tail=this.db.prepare(`SELECT sequence,value FROM events WHERE ${where} ORDER BY sequence DESC LIMIT ?`).all(runId,Math.floor(size/2)) as {sequence:number;value:string}[];
    const rows=[...new Map([...head,...tail].map(row=>[row.sequence,row])).values()].sort((a,b)=>a.sequence-b.sequence);
    return {total,events:rows.map(row=>JSON.parse(row.value) as TimelineEvent)};
  }
  recover(bootId:string):void {
    const now=new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const run of this.list<Run>('runs')) {
        if (run.bootId===bootId || run.completedAt || !['queued','running','waiting_user','rate_limited','stopping'].includes(run.status)) continue;
        const mightBeDelivered=['sent','confirmed','unknown'].includes(run.delivery);
        this.put('runs',run.id,{...run,status:mightBeDelivered?'unknown':'interrupted',delivery:mightBeDelivered?'unknown':'withdrawn',updatedAt:now,error:mightBeDelivered?'上次任务的投递或执行结果尚未核对，未自动重发。':'上次进程已结束，任务未自动恢复。'});
        this.put('blocked_sessions',run.sessionId,{runId:run.id,reason:'重启后等待明确的新任务，不自动继续旧队列',createdAt:now});
      }
      for (const row of this.db.prepare('SELECT id,value FROM entities WHERE entity=?').all('outbox') as {id:string;value:string}[]) {
        const entry=JSON.parse(row.value) as {runId?:string;delivery?:string;kind?:string};
        const run=entry.runId?this.get<Run>('runs',entry.runId):undefined;
        if (!['prepared','sent'].includes(entry.delivery??'') && !(entry.delivery==='confirmed' && run?.status==='unknown')) continue;
        const delivery=entry.delivery==='prepared'&&entry.kind!=='steer'?'withdrawn':'unknown';
        this.put('outbox',row.id,{...entry,delivery,updatedAt:now});
      }
      for (const approval of this.list<Approval>('approvals')) if (approval.state==='pending') this.put('approvals',approval.id,{...approval,state:'expired'});
      for (const collaboration of this.list<Collaboration>('collaborations')) if (collaboration.status==='running') {
        this.put('collaborations',collaboration.id,{...collaboration,status:'paused',stage:'重启后暂停，等待用户继续'});
        const project=this.get<Project>('projects',collaboration.projectId);
        if (project) this.put('projects',project.id,{...project,collaborationPaused:true});
      }
      // Room scheduling lives in memory. A restart retains history but never resumes its old speaking order.
      for (const message of this.list<RoomMessage>('room_messages')) if (message.status==='speaking') {
        const run=message.runId?this.get<Run>('runs',message.runId):undefined;
        if (message.discussionId) {
          this.put('room_messages',message.id,{...message,text:'',status:run?.status==='stopped'?'stopped':'failed',error:'讨论发言在重启前未完成核对，请查看活动记录；未自动重发。'});
          continue;
        }
        const events=run?this.runEvents(run.id).filter(event=>!(event.data as {role?:string}|undefined)?.role):[];
        const deltas=events.filter(event=>event.kind==='delta').map(event=>event.text).join('');
        const text=message.text||(deltas||events.filter(event=>event.kind==='message').map(event=>event.text).join('\n\n')).trim();
        const done=run?.status==='ended'||run?.status==='completed';
        const reaction=done?roomReaction(text):undefined,pass=done&&(isRoomPass(text)||Boolean(reaction)),passed=pass&&message.allowPass;
        const target=passed&&reaction&&message.replyTo?this.get<RoomMessage>('room_messages',message.replyTo):undefined;
        if(target)this.put('room_messages',target.id,{...target,reactions:toggleReaction(target.reactions,reaction!,message.author,true)});
        this.put('room_messages',message.id,{...message,text:pass?'':done?(text||'（没有说话）'):text,status:passed?'passed':pass?'failed':done?'done':run?.status==='stopped'?'stopped':'failed',reaction:passed?reaction:undefined,error:pass&&!passed?'本轮要求回答，但成员选择了不发言；重启后未自动重试。':done?undefined:'上次发言已中断；结果尚未核对，未自动重发。'});
      }
      for(const room of this.list<RoomState>('room_states')) {
      if (room?.mode==='discuss' && room.discussion && room.discussion.phase!=='idle') {
        const d=room.discussion;
        const related=[...this.list<RoomMessage>('room_messages').filter(m=>m.discussionId===d.id).map(m=>m.runId),...Object.values(d.handRound?.ballots??{}).map(b=>b.runId),...(d.unknownRunIds??[]),d.unknownRunId];
        const unknownRunIds=[...new Set(related.filter((id):id is string=>Boolean(id&&!d.acknowledgedRunIds?.includes(id))).filter(id=>{const run=this.get<Run>('runs',id);return run?.status==='unknown'||run?.delivery==='unknown'||d.unknownRunIds?.includes(id)||d.unknownRunId===id;}))];
        const handRound=d.handRound?.status==='collecting'?{...d.handRound,status:'stopped' as const,ballots:Object.fromEntries(Object.entries(d.handRound.ballots).map(([id,b])=>[id,b.status==='pending'?{...b,status:'stopped' as const,error:'重启后未自动恢复举手请求'}:b]))}:d.handRound;
        const needsMinutes=Boolean(d.meetingMinutes&&!['done','stale'].includes(d.meetingMinutes.status));
        d.mentionQueue=[];d.workWaiting=false;
        this.put('room_states',room.roomId!,{...room,active:false,speaking:undefined,compressing:undefined,generatingImage:undefined,discussion:{...d,phase:d.phase==='paused'?'paused':unknownRunIds.length?'blocked':['talking','raising','closing','summarizing'].includes(d.phase)?'paused':d.phase,proposal:needsMinutes?d.proposal:undefined,meetingMinutes:d.meetingMinutes?.status==='running'?{...d.meetingMinutes,status:'stopped'}:d.meetingMinutes,handRound,unknownRunId:unknownRunIds[0],unknownRunIds:unknownRunIds.length?unknownRunIds:undefined,reason:'重启后已暂停讨论，请核对进展后继续；不会自动重发旧轮次。'}});
      } else if (room?.active||room?.speaking||room?.compressing||room?.generatingImage) this.put('room_states',room.roomId!,{...room,active:false,speaking:undefined,compressing:undefined,generatingImage:undefined});
      }
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Built-in members with any saved card applied, then the user's own members in the order they joined. */
  members():MemberProfile[] {
    const saved=this.list<MemberProfile>('members');
    const removed=new Set(this.list<MemberProfile>('removed_members').map(member=>member.id));
    const builtIns=BUILTIN_MEMBERS.filter(member=>!removed.has(member.id)).map(member=>({...member,...saved.find(item=>item.id===member.id),id:member.id,executor:member.executor,builtIn:true}));
    return [...builtIns,...saved.filter(item=>!BUILTIN_MEMBERS.some(member=>member.id===item.id)).sort((a,b)=>(a.createdAt??'').localeCompare(b.createdAt??''))];
  }
  historicalMembers():MemberProfile[] {
    return this.list<MemberProfile>('removed_members').map(({id,executor,name,color,portrait,avatar,portraitScale,portraitOffset,face,avatarFace,builtIn})=>({id,executor,name,color,portrait,avatar,portraitScale,portraitOffset,face,avatarFace,builtIn}));
  }
  /** Programs connected over ACP, in the order they were added. */
  executors():AcpExecutor[] { return this.list<AcpExecutor>('executors').sort((a,b)=>a.createdAt.localeCompare(b.createdAt)); }
  profile():UserProfile { return {...DEFAULT_PROFILE,...this.get<UserProfile>('profile','main')}; }
  validateRoomId(value:unknown='global'):RoomId {
    if(value==='global')return value;
    if(typeof value==='string'&&value.startsWith('roundtable:')){if(!this.get('roundtable_topics',value.slice(11)))throw new Error('圆桌议题不存在，请刷新');return value as RoomId;}
    if(typeof value==='string'&&(value.startsWith('desk:')||value.startsWith('report:'))){
      if(!this.get('personal_rooms',value))throw new Error('个人聊天不存在，请先打开成员工位或汇报');
      return value as RoomId;
    }
    if(typeof value!=='string'||!value.startsWith('project:'))throw new Error('房间标识无效');
    const project=this.get<Project>('projects',value.slice(8));
    if(!project||project.kind)throw new Error('项目会议室不存在，请刷新项目');
    return value as RoomId;
  }
  ensureProjectRoom(projectId:string,withinTransaction=false):RoomThread {
    const roomId=this.validateRoomId(`project:${projectId}`),current=this.get<{id:string}>('room_cursors',roomId);
    if(current)return this.roomThread(current.id,roomId);
    const create=()=>{const thread:RoomThread={id:randomUUID(),title:'项目会议室',createdAt:new Date().toISOString(),roomId,projectId};this.put('room_threads',thread.id,thread);this.put('room_cursors',roomId,{id:thread.id});this.put('room_states',roomId,{active:false,mode:'chat'});return thread;};
    // ProjectTree creates the project, room and idempotency receipt in one existing transaction.
    return withinTransaction?create():this.transaction(create);
  }
  roomThread(threadId:string,roomId:RoomId='global'):RoomThread {
    const thread=this.get<RoomThread>('room_threads',threadId);
    if(!thread||(thread.roomId??'global')!==roomId)throw new Error('所选话题不属于这个房间，请刷新');
    return thread;
  }
  roomScope(roomId:RoomId='global'):Store {this.validateRoomId(roomId);this.currentRoomThread(roomId);return scopedRoomStore(this,roomId);}
  currentRoomThread(roomId:RoomId='global'):RoomThread {
    const cursor=this.get<{id:string}>('room_cursors',roomId);if(!cursor)throw new Error('会议室尚未创建，请先初始化项目会议室');return this.roomThread(cursor.id,roomId);
  }
  roomThreads(roomId:RoomId='global'):RoomThread[] {
    const counts=this.cachedRead('room-thread-counts',()=>new Map((this.db.prepare("SELECT COALESCE(json_extract(value,'$.threadId'),'room-main') AS thread, COUNT(*) AS count FROM entities WHERE entity='room_messages' AND COALESCE(json_extract(value,'$.system'),0)=0 GROUP BY thread").all() as {thread:string;count:number}[]).map(row=>[row.thread,row.count])));
    return this.list<RoomThread>('room_threads').filter(thread=>(thread.roomId??'global')===roomId).map(thread=>({...thread,count:counts.get(thread.id)??0})).sort((a,b)=>Number(Boolean(a.archivedAt))-Number(Boolean(b.archivedAt))||(b.archivedAt??b.createdAt).localeCompare(a.archivedAt??a.createdAt));
  }
  roomHistory(threadId?:string,before?:string,limit=ROOM_PAGE_SIZE,roomId:RoomId='global'):RoomHistory {
    threadId??=this.currentRoomThread(roomId).id;this.roomThread(threadId,roomId);
    const count=Math.max(1,Math.min(1000,Math.floor(limit)));
    let cursor=Number.MAX_SAFE_INTEGER;
    if (before) {
      const row=this.db.prepare("SELECT rowid AS position FROM entities WHERE entity='room_messages' AND id=? AND COALESCE(json_extract(value,'$.threadId'),'room-main')=?").get(before,threadId) as {position:number}|undefined;
      if (!row) throw new Error('历史分页位置已失效，请重新打开话题');
      cursor=row.position;
    }
    const rows=this.db.prepare("SELECT value FROM entities WHERE entity='room_messages' AND COALESCE(json_extract(value,'$.threadId'),'room-main')=? AND rowid<? ORDER BY rowid DESC LIMIT ?").all(threadId,cursor,count+1) as {value:string}[];
    const messages=rows.slice(0,count).reverse().map(row=>roundtableContextMessage(JSON.parse(row.value) as RoomMessage,roomId));
    const hasMore=rows.length>count;
    return {threadId,messages,hasMore,before:hasMore?messages[0]?.id:undefined};
  }
  roomMessages(limit=300,threadId?:string,roomId:RoomId='global'):RoomMessage[] { return this.roomHistory(threadId,undefined,limit,roomId).messages; }
  allRoomMessages(threadId:string,roomId:RoomId='global'):RoomMessage[] {
    this.roomThread(threadId,roomId);
    return [...this.cachedRead('room-messages:'+JSON.stringify([roomId,threadId]),()=>(this.db.prepare("SELECT value FROM entities WHERE entity='room_messages' AND COALESCE(json_extract(value,'$.threadId'),'room-main')=? ORDER BY rowid").all(threadId) as {value:string}[]).map(row=>roundtableContextMessage(JSON.parse(row.value) as RoomMessage,roomId)))];
  }
  archiveRoom(title?:string,inherited?:RoomThread['inherited']):RoomThread {
    const current=this.currentRoomThread(),at=new Date().toISOString();
    if(inherited)this.roomThread(inherited.threadId);
    const next:RoomThread={id:randomUUID(),title:'当前话题',autoTitle:true,createdAt:at,roomId:'global',...(inherited?{inherited}:{})};
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.put('room_threads',current.id,{...current,title:title??current.title,...(title!==undefined?{autoTitle:false}:{}),archivedAt:at});
      this.put('room_threads',next.id,next);this.put('room','current',{id:next.id});
      this.db.exec('COMMIT');return next;
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  clearRoomThread(threadId:string,roomId:RoomId='global') {
    this.readCache?.clear();
    this.roomThread(threadId,roomId);
    const clear=()=>{this.db.prepare("DELETE FROM entities WHERE entity='room_messages' AND COALESCE(json_extract(value,'$.threadId'),'room-main')=?").run(threadId);this.db.prepare("DELETE FROM entities WHERE entity='composer_drafts' AND json_extract(value,'$.threadId')=?").run(threadId);this.clearAttentionReferences('threadId',threadId);};
    if(this.db.isTransaction)clear();else this.transaction(clear);
  }
  removeArchivedRoomThread(threadId:string,removeRecords?:()=>void) {
    const thread=this.get<RoomThread>('room_threads',threadId);
    if(!thread?.archivedAt||threadId===this.currentRoomThread().id)throw new Error('只能删除已归档的话题');
    this.db.exec('BEGIN IMMEDIATE');
    try { this.clearRoomThread(threadId);removeRecords?.();this.delete('room_threads',threadId);this.db.exec('COMMIT'); }
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  roomState(roomId:RoomId='global'):RoomState { return this.get<RoomState>('room_states',roomId)??{active:false,mode:'chat',roomId,revision:0}; }
  roomView(roomId:RoomId='global') {this.validateRoomId(roomId);const history=this.roomHistory(undefined,undefined,ROOM_PAGE_SIZE,roomId),state=this.roomState(roomId),d=state.discussion;return {...history,roomId,state:d?{...state,discussion:{...d,callUsage:callUsage(this.list<Run>('runs').filter(run=>run.origin?.discussionId===d.id))}}:state,currentThreadId:history.threadId,threads:this.roomThreads(roomId)};}
  roomOverviews():NonNullable<Snapshot['rooms']> {
    const projects=new Set(this.list<Project>('projects').filter(p=>!p.kind).map(p=>p.id));
    return this.list<RoomState>('room_states').filter(s=>s.roomId==='global'||s.roomId?.startsWith('roundtable:')&&this.get('roundtable_topics',s.roomId.slice(11))||projects.has(s.roomId?.slice(8)??'')).map(s=>({
      roomId:s.roomId!,...(s.roomId?.startsWith('project:')?{projectId:s.roomId.slice(8)}:{}),revision:s.revision??0,currentThreadId:this.currentRoomThread(s.roomId).id,
      state:{active:s.active,mode:s.mode,speaking:s.speaking,compressing:s.compressing,generatingImage:s.generatingImage},
    }));
  }
  snapshot(options:{providers?:ProviderInfo[];settings?:Settings;backendReady?:boolean;deepseekKeyConfigured?:boolean}={}):Snapshot {
    return {projects:this.list('projects'),sessions:this.list('sessions'),runs:this.list('runs'),approvals:this.list('approvals'),collaborations:this.list('collaborations'),events:this.liveEvents(),providers:options.providers??[],settings:options.settings??this.get<Settings>('settings','main')??DEFAULT_SETTINGS,dataDirectory:this.dataDirectory,...(this.get<{at:string}>('restore_info','main')?.at?{restoreEpoch:this.get<{at:string}>('restore_info','main')!.at}:{}),backendReady:options.backendReady??true,deepseekKeyConfigured:options.deepseekKeyConfigured??false,members:this.members(),removedMembers:this.historicalMembers(),executors:this.executors(),profile:this.profile(),room:this.roomView(),rooms:this.roomOverviews()};
  }
  close():void { this.db.close(); }
}
