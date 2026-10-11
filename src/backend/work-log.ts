import {withProjectWrite} from './project-access';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Store } from './store';
import type { Project, Run, Session, RoomThread, RoomMessage } from '../shared/types';
import { classifySession } from '../shared/session-classification';
import { FlowError, type FlowRecord, type Task, type Round, type Acceptance, type FlowOperation, type Submission, type Review } from '../shared/project-flow';
import type { ApplyJournal } from './project-flow-apply';
import { observeTool, type LogTarget, type WorkLogPage, type WorkLogEntry, type LogExport, type LogReceipt, type LogRecord } from '../shared/work-log';
import { effectiveConfigText } from '../shared/executor-config';
import { redact, resolveSafePath } from './security';

interface Position {v:1;scope:string;after:number;through:number;runIds:string[]}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const encode=(p:Position)=>Buffer.from(JSON.stringify(p)).toString('base64url');
const fence=(text:string)=>{const longest=Math.max(2,...(text.match(/`+/g)??[]).map(s=>s.length));const mark='`'.repeat(longest+1);return `${mark}\n${text}\n${mark}`;};

/** A read projection over persisted events. Neither reading nor exporting dispatches model work. */
export class WorkLogs {
  private writing=new Map<string,Promise<LogReceipt[]>>();
  constructor(private store:Store){}
  private context(p:Record<string,unknown>){
    const project=this.store.get<Project>('projects',String(p.projectId));
    const raw=p.target as LogTarget|undefined;
    if(!project||project.kind||!raw||!['task','round','session','member'].includes(raw.kind)||typeof raw.id!=='string')throw new FlowError('NOT_FOUND','请选择本项目的任务、轮次或工作记录。');
    const target:LogTarget={kind:raw.kind,id:raw.id};
    if(target.kind==='member'){
      const member=this.store.members().find(m=>m.id===target.id),operations=this.store.list<FlowOperation>('flow_operations').filter(op=>{const session=op.sessionId&&this.store.get<Session>('sessions',op.sessionId);return op.projectId===project.id&&session&&(session.memberId??session.provider)===target.id;});
      if(!project.memberIds?.includes(target.id)&&!operations.length)throw new FlowError('NOT_FOUND','成员没有参与本项目。');
      const operationIds=new Set(operations.map(op=>op.id));
      const runs=this.store.list<Run>('runs').filter(run=>run.projectId===project.id&&(operationIds.has(run.flowOperationId??'')||operations.some(op=>op.runId===run.id||op.correctionRunId===run.id))&&(this.store.get<Session>('sessions',run.sessionId)?.memberId??run.provider)===target.id);
      if(runs.length>5000)throw new FlowError('TOO_LARGE','记录较多，请按任务查看日志。');
      const record={schemaVersion:1 as const,id:target.id,projectId:project.id,flowId:'',revision:0,createdAt:project.createdAt,updatedAt:project.createdAt,title:`${member?.name??target.id} 的项目工作记录`} satisfies FlowRecord&{title:string};
      return {project,target,record,runs,operations,round:undefined,acceptance:undefined,canWrite:false,scope:JSON.stringify([project.id,target.kind,target.id])};
    }
    const entity=target.kind==='task'?'flow_tasks':target.kind==='round'?'flow_rounds':'sessions';
    const record=this.store.get<FlowRecord&{title?:string}>(entity,target.id);
    if(!record)throw new FlowError('NOT_FOUND','记录不属于当前项目。');
    const session=target.kind==='session'?record as unknown as Session:undefined;
    const executionProject=session?this.store.get<Project>('projects',session.projectId):project;
    const roomId=session?.roomId??(session?.roomThreadId?this.store.get<RoomThread>('room_threads',session.roomThreadId)?.roomId:undefined);
    const roomOwned=session&&executionProject?.kind==='lounge'&&roomId===`project:${project.id}`&&executionProject.roomId===roomId;
    if(record.projectId!==project.id&&!roomOwned)throw new FlowError('NOT_FOUND','记录不属于当前项目。');
    const runProjectId=target.kind==='session'?record.projectId:project.id;
    let ids=new Set([target.id]);
    if(target.kind==='round')for(const task of this.store.list<Task>('flow_tasks').filter(t=>t.roundId===target.id&&t.projectId===project.id))ids.add(task.id);
    if(target.kind!=='session'){
      for(const item of this.store.list<FlowRecord&{taskId?:string;roundId?:string}>('flow_reviews'))if(item.projectId===project.id&&item.flowId===record.flowId&&ids.has(item.taskId??''))ids.add(item.id);
      for(const bucket of ['flow_integrations','flow_requested_checks'])for(const item of this.store.list<FlowRecord&{roundId:string}>(bucket))if(target.kind==='round'&&item.projectId===project.id&&item.flowId===record.flowId&&item.roundId===target.id)ids.add(item.id);
    }
    const operations=this.store.list<FlowOperation>('flow_operations').filter(op=>op.projectId===project.id&&op.flowId===record.flowId&&ids.has(op.targetId));
    const operationIds=new Set(operations.map(op=>op.id));
    const direct=new Set(this.store.list<FlowRecord&{taskId:string;runId:string}>('flow_submissions').filter(s=>s.projectId===project.id&&s.flowId===record.flowId&&ids.has(s.taskId)).map(s=>s.runId));
    const runs=this.store.list<Run>('runs').filter(run=>run.projectId===runProjectId&&(target.kind==='session'?run.sessionId===target.id:operationIds.has(run.flowOperationId??'')||direct.has(run.id)||operations.some(op=>op.runId===run.id||op.correctionRunId===run.id))).filter(run=>this.store.get<Session>('sessions',run.sessionId)?.projectId===runProjectId);
    if(runs.length>5000)throw new FlowError('TOO_LARGE','记录较多，请按任务查看日志。');
    const round=target.kind==='round'?record as Round:target.kind==='task'?this.store.get<Round>('flow_rounds',(record as Task).roundId):undefined;
    const acceptance=round?.acceptanceId?this.store.get<Acceptance>('flow_acceptances',round.acceptanceId):undefined;
    const journal=acceptance?.applyOperationId?this.store.get<ApplyJournal>('flow_apply_journals',acceptance.applyOperationId):undefined;
    const canWrite=Boolean(round?.status==='accepted'&&acceptance?.roundId===round.id&&acceptance.projectId===project.id&&acceptance.status==='accepted'&&acceptance.requiresApply&&journal?.state==='applied'&&journal.projectId===project.id&&journal.acceptanceId===acceptance.id&&journal.artifactId===acceptance.version.artifactId&&path.resolve(journal.directory).toLowerCase()===path.resolve(project.directory).toLowerCase());
    return {project,target,record,runs,operations,round,acceptance,canWrite,scope:JSON.stringify([project.id,target.kind,target.id])};
  }
  private position(p:Record<string,unknown>,ctx:ReturnType<WorkLogs['context']>):Position{
    if(!p.cursor)return {v:1,scope:ctx.scope,after:0,through:this.store.eventWatermark(),runIds:ctx.runs.map(r=>r.id)};
    try{
      if(typeof p.cursor!=='string'||p.cursor.length>500000)throw Error();
      const pos=JSON.parse(Buffer.from(p.cursor,'base64url').toString()) as Position;
      if(pos.v!==1||pos.scope!==ctx.scope||!Number.isSafeInteger(pos.after)||!Number.isSafeInteger(pos.through)||pos.after<0||pos.through<pos.after||pos.through>this.store.eventWatermark()||!Array.isArray(pos.runIds)||pos.runIds.length>5000||pos.runIds.some(id=>typeof id!=='string'||!ctx.runs.some(run=>run.id===id)))throw Error();
      return pos;
    }catch{throw new FlowError('INVALID_CURSOR','日志位置已无效，请重新读取。');}
  }
  page(p:Record<string,unknown>):WorkLogPage{
    const ctx=this.context(p),pos=this.position(p,ctx),limit=Math.max(1,Math.min(200,Number.isSafeInteger(p.limit)?Number(p.limit):80));
    const fetched=this.store.eventPage(pos.runIds,pos.after,pos.through,limit+1),rows=fetched.slice(0,limit),hasMore=fetched.length>limit;
    const scannedThrough=hasMore?rows.at(-1)!.sequence:pos.through;
    const entries:WorkLogEntry[]=rows.filter(row=>!['delta','reasoning','usage','session'].includes(row.event.kind)).filter(row=>ctx.runs.some(run=>run.id===row.event.runId&&run.sessionId===row.event.sessionId)).map(({sequence,event})=>{
      const session=this.store.get<Session>('sessions',event.sessionId)!;
      const safe=redact(event),tool=observeTool(safe);
      const input=event.kind==='message'&&(safe.data as {role?:string}|undefined)?.role==='user'&&['flow','room'].includes(classifySession(session,ctx.runs));
      const projected=input?'已发送本次工作说明；完整内容可展开原始记录。':safe.text.slice(0,1200);
      return {id:event.id,sequence,at:event.at,runId:event.runId,sessionId:event.sessionId,memberId:session.memberId??session.provider,kind:event.kind,text:projected,detail:JSON.stringify({text:safe.text,data:safe.data},null,2).slice(0,16000),fidelity:event.fidelity,sourceEventIds:[event.id],...(tool?{tool}: {})};
    });
    const records:LogRecord[]=[];
    for(const sub of this.store.list<Submission>('flow_submissions').filter(s=>s.projectId===ctx.project.id&&pos.runIds.includes(s.runId)))records.push({id:sub.id,runId:sub.runId,kind:'submission',text:(sub.userSummary||sub.summary).slice(0,2000)});
    for(const review of this.store.list<Review>('flow_reviews').filter(r=>r.projectId===ctx.project.id&&pos.runIds.includes(r.runId??'')))records.push({id:review.id,runId:review.runId!,kind:'review',text:`任务检查记录：${review.outcome==='pass'||review.status==='passed'?'通过':review.outcome==='changes_requested'||review.status==='changes_requested'?'要求修改':'尚不能确认通过'}。${(review.outcomeReasons??[]).join('；')}`.slice(0,2000)});
    for(const round of this.store.list<Round>('flow_rounds').filter(r=>r.projectId===ctx.project.id&&pos.runIds.includes(r.reportRunId??'')&&r.report))records.push({id:round.id,runId:round.reportRunId!,kind:'report',text:round.report!.summary.slice(0,2000)});
    for(const message of this.store.list<RoomMessage>('room_messages').filter(m=>pos.runIds.includes(m.runId??'')&&m.text))records.push({id:message.id,runId:message.runId!,kind:'reply',text:message.text.slice(0,2000)});
    return {projectId:ctx.project.id,target:ctx.target,title:ctx.record.title??'工作记录',entries,records:redact(records),through:pos.through,scannedThrough,hasMore,cursor:hasMore?encode({...pos,after:scannedThrough}):undefined,checkpoint:encode({...pos,after:0}),canWrite:ctx.canWrite,runs:ctx.runs.filter(run=>pos.runIds.includes(run.id)).map(run=>({id:run.id,memberId:this.store.get<Session>('sessions',run.sessionId)?.memberId??run.provider,stage:ctx.operations.find(op=>op.id===run.flowOperationId)?.kind??'会话',status:run.status,delivery:run.delivery,error:run.error,configuration:effectiveConfigText(run.requestedConfig,run.effectiveConfig)})),receipts:this.store.list<LogReceipt>('flow_log_receipts').filter(receipt=>receipt.projectId===ctx.project.id&&(ctx.target.kind==='round'?receipt.roundId===ctx.target.id:receipt.target.kind===ctx.target.kind&&receipt.target.id===ctx.target.id))};
  }
  export(p:Record<string,unknown>):LogExport{
    const position=this.position({cursor:p.checkpoint??p.cursor},this.context(p));
    let page=this.page({...p,cursor:encode({...position,after:0}),limit:200});
    const checkpoint=page.checkpoint,through=page.through,title=page.title,project=this.context(p).project,runs=page.runs,records=page.records;
    const entries:WorkLogEntry[]=[];let bytes=0;
    for(;;){for(const entry of page.entries){bytes+=entry.detail.length+(entry.tool?.command?.length??0);if(bytes>8*1024*1024)throw new FlowError('TOO_LARGE','日志过大，请按任务导出。');entries.push(entry);}if(!page.hasMore)break;page=this.page({...p,cursor:page.cursor,limit:200});}
    const lines=[`# ${project.name} · ${title} · 工作日志`,`项目：${project.id}；范围：${page.target.kind}/${page.target.id}。`,`截至已存事件位置 ${through}。序号空隙不代表漏记；继续输出需重新读取。`,`原生记录、派生记录和未知结果保留原标记。缺退出码不代表成功。`];
    lines.push('## 导出时的运行状态',...runs.map(run=>fence(`${run.id} · ${run.memberId} · ${run.stage} · ${run.status} · 投递 ${run.delivery} · ${run.configuration??'这次运行未记录配置'}${run.error?' · '+run.error:''}`)));
    lines.push('## 已存提交和检查说明（成员说明不等同执行成功）',...records.map(record=>`记录 ${record.id}；运行 ${record.runId}。\n\n${fence(record.text)}`));
    for(const entry of entries){lines.push(`## ${entry.at} · ${entry.memberId} · ${entry.kind}`,`事件 ${entry.id}；运行 ${entry.runId}；来源 ${entry.fidelity}。`,fence(entry.text));if(entry.tool)lines.push(`工具状态：${entry.tool.phase}；退出码：${entry.tool.exitCode??'未知'}。`,...(entry.tool.command?[fence(entry.tool.command)]:[]),...(entry.tool.paths.length?[fence(entry.tool.paths.join('\n'))]:[]));lines.push(fence(entry.detail));}
    const content=redact(lines.join('\n\n')+'\n');
    return {name:`${title.replace(/[\\/:*?"<>|\r\n]/g,' ').slice(0,70)}-工作日志.md`,content,hash:hash(content),through,entryCount:entries.length,checkpoint};
  }
  async write(p:Record<string,unknown>):Promise<LogReceipt[]>{
    const ctx=this.context(p);if(!ctx.canWrite||!ctx.round||!ctx.acceptance)throw new FlowError('NOT_APPLIED','请在本轮验收并写入项目后保存项目日志。');
    if(ctx.target.kind==='session'||ctx.target.kind==='member')throw new FlowError('INVALID_REQUEST','请按轮次或任务保存项目日志。');
    const lock=JSON.stringify([ctx.project.id,ctx.round.id]);
    const pending=this.writing.get(lock);
    const work=(pending??Promise.resolve()).then(()=>this.archive(ctx.project,ctx.round!,ctx.acceptance!,ctx.target));this.writing.set(lock,work);
    try{return await work;}finally{if(this.writing.get(lock)===work)this.writing.delete(lock);}
  }
  private async archive(project:Project,round:Round,acceptance:Acceptance,target:LogTarget){
    const targets=target.kind==='task'?[target]:[{kind:'round' as const,id:round.id},...this.store.list<Task>('flow_tasks').filter(t=>t.projectId===project.id&&t.roundId===round.id).map(t=>({kind:'task' as const,id:t.id}))];
    const receipts:LogReceipt[]=[];
    for(const selected of targets){
      const id=hash(JSON.stringify([acceptance.id,selected])),old=this.store.get<LogReceipt>('flow_log_receipts',id);
      if(old?.state==='written'){receipts.push(old);continue;}
      let receipt:LogReceipt=old??{id,projectId:project.id,roundId:round.id,target:selected,acceptanceId:acceptance.id,checkpoint:'',path:`.airoom/logs/${hash(round.flowId).slice(0,16)}/${hash(round.id).slice(0,16)}/${selected.kind}-${id.slice(0,20)}.md`,state:'prepared',at:new Date().toISOString()};
      try{
        const exported=this.export({projectId:project.id,target:selected,...(receipt.checkpoint?{checkpoint:receipt.checkpoint}:{})});
        receipt={...receipt,checkpoint:exported.checkpoint,hash:exported.hash,state:'prepared',error:undefined};this.store.put('flow_log_receipts',id,receipt);
        let file=resolveSafePath(project.directory,receipt.path);await fs.mkdir(path.dirname(file),{recursive:true});file=resolveSafePath(project.directory,receipt.path);
        try{await withProjectWrite(this.store,project.id,project.directory,async check=>{check();await fs.writeFile(file,exported.content,{flag:'wx'});},false,[receipt.path]);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||!(await fs.lstat(file)).isFile()||hash(await fs.readFile(file,'utf8'))!==exported.hash)throw error;}
        receipt={...receipt,state:'written',error:undefined};
      }catch(error){receipt={...receipt,state:'failed',error:redact((error as Error).message).slice(0,1000)};}
      this.store.put('flow_log_receipts',id,receipt);receipts.push(receipt);
    }
    return receipts;
  }
  async afterAcceptance(projectId:string,roundId:string){
    if(!this.store.get<Project>('projects',projectId)?.writeWorkLogs)return;
    try{await this.write({projectId,target:{kind:'round',id:roundId}});}catch{/* Logging must never change acceptance, re-run tasks, or block the next round. */}
  }
}
