import {createHash} from 'node:crypto';
import type { Approval, MemberProfile, Project, ProviderInfo, RoomState, RoomThread, Run, Session } from '../shared/types';
import { ATTENTION_KINDS, type AttentionItem, type AttentionSummary, type AttentionDismissal, type WorkspaceConflictNotice } from '../shared/attention';
import { pendingDiscussionQuestion } from '../shared/discussion';
import type { Store } from './store';
import type { Round, Decision, Acceptance, ProjectFlow, FlowOperation, Plan } from '../shared/project-flow';
import type { PersonalRoom } from '../shared/member-workspaces';
import type {JointReview,JointDecision} from '../shared/joint-review';
import type {TaskAddition} from '../shared/project-workbench';
import type {RoundtableTopic} from '../shared/roundtable';
import {isConversationSession} from '../shared/session-classification';

const short=(value:string|undefined,limit=240)=>(value??'').replace(/\s+/g,' ').trim().slice(0,limit);
type MessageReference=ReturnType<Store['roomMessageReferences']>[number];

/** A read-only projection of existing work. No provider calls or file operations. */
export function collectAttention(store:Store,providers:ProviderInfo[],answerable:ReadonlySet<string>,includeIgnored=false):AttentionSummary {
  const items=new Map<string,AttentionItem>();
  const sessions=new Map(store.list<Session>('sessions').map(item=>[item.id,item]));
  const projects=new Map(store.list<Project>('projects').map(item=>[item.id,item]));
  const personalRooms=new Map(store.list<PersonalRoom>('personal_rooms').map(room=>[room.id,room]));
  const topics=store.list<RoundtableTopic>('roundtable_topics'),topicsByProject=new Map(topics.map(topic=>[topic.projectId,topic]));
  const liveTopic=(topic:RoundtableTopic|undefined)=>Boolean(topic&&topic.status!=='ended'&&!topic.archivedAt&&!topic.restoredHistoryOnly);
  const liveProject=(id:string):boolean=>{
    const project=projects.get(id);if(!project)return false;
    if(project.kind==='roundtable')return liveTopic(topicsByProject.get(id));
    if(project.kind==='lounge'&&project.roomId?.startsWith('project:'))return projects.has(project.roomId.slice(8));
    if(project.kind==='lounge'&&project.roomId?.startsWith('roundtable:'))return liveTopic(topics.find(t=>t.roomId===project.roomId));
    if(project.kind==='lounge'&&project.roomId?.startsWith('report:')){const room=personalRooms.get(project.roomId);return Boolean(room?.projectId&&projects.has(room.projectId));}
    return true;
  };
  const runs=store.list<Run>('runs'),byRun=new Map(runs.map(item=>[item.id,item]));
  const messages=store.roomMessageReferences(),members=store.members();
  const byMessage=new Map(messages.map(item=>[item.id,item])),messageByRun=new Map<string,MessageReference>(),staleByRun=new Map<string,MessageReference>(),decidedRuns=new Set<string>();
  for(const message of messages){
    if(message.runId&&!message.discussionControl&&!messageByRun.has(message.runId))messageByRun.set(message.runId,message);
    const resultId=message.link?.reviewOf?.runId??message.link?.runId;
    if(resultId&&message.link?.outcome&&message.link.verdict)decidedRuns.add(resultId);
    if(message.link?.runId&&message.link.reviewStale&&!staleByRun.has(message.link.runId))staleByRun.set(message.link.runId,message);
  }
  const blockers=new Map(store.list<{sessionId?:string;runId?:string}>('blocked_sessions').filter(item=>item.runId).map(item=>[item.runId,item]));
  const threads=new Set(store.list<{id:string}>('room_threads').map(item=>item.id));
  const thread=store.currentRoomThread(),currentThread=thread.id;
  const rooms=store.list<RoomState>('room_states').filter(s=>s.roomId==='global'||projects.has(s.roomId?.slice(8)??''));
  const memberFor=(session:Session):MemberProfile|undefined=>members.find(item=>item.id===session.memberId&&item.executor===session.provider)??members.find(item=>item.id===session.provider);
  const usable=(session:Session|undefined):session is Session=>Boolean(session&&!session.restoredHistoryOnly&&!session.archived&&liveProject(session.projectId));
  const inRoom=(session:Session)=>session.projectId==='lounge'||projects.get(session.projectId)?.kind==='lounge';
  const roomOf=(session:Session)=>session.roomId??projects.get(session.projectId)?.roomId??'global';
  const roomView=(session:Session):AttentionItem['action']['view']=>session.flowId?'project-room':inRoom(session)?roomOf(session)==='global'?'room':'project-room':'session';
  const location=(run:Run,session:Session)=>{
    const message=messageByRun.get(run.id);
    const threadId=run.origin?.threadId??message?.threadId??currentThread;
    const roomId=roomOf(session);
    const personal=personalRooms.get(roomId),operation=run.flowOperationId?store.get<FlowOperation>('flow_operations',run.flowOperationId):undefined;
    return {projectId:personal?.projectId??(inRoom(session)&&roomId.startsWith('project:')?roomId.slice(8):session.projectId),sessionId:session.id,runId:run.id,provider:run.provider,memberId:memberFor(session)?.id,
      ...(operation?.jointReviewId?{jointReviewId:operation.jointReviewId}:{}),
      ...(run.origin?.threadId?{threadId:run.origin.threadId}:{}),
      ...(inRoom(session)?{roomId,threadId,...(message?{messageId:message.id}:{})}:{})};
  };
  const add=(item:AttentionItem)=>{
    if(item.projectId&&!liveProject(item.projectId))return;
    if(item.threadId&&!threads.has(item.threadId))return;
    if(item.roomId?.startsWith('project:')&&!projects.has(item.roomId.slice(8)))return;
    if(item.roomId?.startsWith('roundtable:')&&!liveTopic(topics.find(t=>t.roomId===item.roomId)))return;
    if(item.jointReviewId){const review=store.get<JointReview>('flow_joint_reviews',item.jointReviewId);if(!review||['completed','cancelled','stale'].includes(review.status))return;}
    // Rechecking a signed-out provider does not make the same login request new.
    const fingerprint=createHash('sha256').update(JSON.stringify({...item,...(item.kind==='login'?{at:undefined}:{})})).digest('hex');
    items.set(item.id,{...item,fingerprint});
  };

  for(const approval of store.list<Approval>('approvals')){
    const run=byRun.get(approval.runId),session=sessions.get(approval.sessionId);
    if(approval.state!=='pending'||!answerable.has(approval.id)||!run||!usable(session)||run.status!=='waiting_user'||run.completedAt||run.revision!==session.revision)continue;
    const question=approval.type==='question';
    add({...location(run,session),id:`${approval.type}:${approval.id}`,kind:question?'question':'approval',approvalId:approval.id,
      title:`${memberFor(session)?.name??approval.provider}${question?' 等你回答':' 等你确认操作'}`,detail:short(approval.detail||approval.title),at:approval.createdAt,
      action:{view:roomView(session),label:question?'回答问题':'查看操作请求'}});
  }
  const discussionUnknown=new Set<string>();
  for(const room of rooms){
    const roomId=room.roomId??'global',d=room.discussion,thread=store.currentRoomThread(roomId),currentThread=thread.id;
    const place={roomId,threadId:currentThread,...(roomId!=='global'?{projectId:roomId.slice(8)}:{})},view=roomId==='global'?'room' as const:'project-room' as const;
    if(d&&d.phase!=='idle'){
      for(const question of (d.questions??[]).filter(item=>item.to==='user'&&pendingDiscussionQuestion(item))){
        const message=byMessage.get(question.messageId);
        add({...place,id:`room-question:${d.id}:${question.id}`,kind:'question',title:`${members.find(item=>item.id===question.from)?.name??'成员'} 等你回答`,detail:short(question.text),at:message?.at??thread.createdAt,memberId:question.from,messageId:question.messageId,action:{view,label:roomId==='global'?'回答聊天室问题':'回答会议室问题'}});
      }
      if(d.phase==='waiting_user'&&d.reviewRequired?.length)add({...place,id:`room-review:${d.id}`,kind:'acceptance',title:'会议里的结果待你核对',detail:short(d.reviewRequired.join('；')),at:byMessage.get(d.latestUserId)?.at??thread.createdAt,action:{view,label:'核对会议结果'}});
    }
    for(const id of [d?.unknownRunId,...d?.unknownRunIds??[]])if(id&&!d?.acknowledgedRunIds?.includes(id))discussionUnknown.add(id);
  }

  const lastBySession=new Map<string,Run>();
  for(const run of runs){const previous=lastBySession.get(run.sessionId);if(!previous||run.createdAt>=previous.createdAt)lastBySession.set(run.sessionId,run);}
  const uncertainSupplements=new Set(store.list<{kind?:string;delivery:string;runId?:string;acknowledgedAt?:string}>('outbox').filter(item=>item.kind==='steer'&&item.delivery==='unknown'&&!item.acknowledgedAt).map(item=>item.runId));
  for(const run of runs){
    const session=sessions.get(run.sessionId);if(!usable(session))continue;
    const abandoned=run.flowOperationId&&Boolean((store.get<FlowOperation>('flow_operations',run.flowOperationId)?.result as {abandoned?:boolean}|undefined)?.abandoned);
    const nativeUnknown=!abandoned&&(run.status==='unknown'||run.delivery==='unknown');
    const imageUnknown=session.purpose==='room-image'&&nativeUnknown&&!run.imageGenerationAcknowledgedAt;
    const supplementUnknown=uncertainSupplements.has(run.id)&&lastBySession.get(session.id)?.id===run.id&&run.revision===session.revision;
    if(nativeUnknown&&!(session.purpose==='room-image'&&run.imageGenerationAcknowledgedAt)&&(blockers.has(run.id)||discussionUnknown.has(run.id)||imageUnknown)||supplementUnknown){
      add({...location(run,session),id:`unknown:${run.id}`,kind:'unknown',title:supplementUnknown&&!nativeUnknown?'补充要求是否送达待核对':'这一轮的结果待核对',
        detail:'请先核对这一轮已有的结果和说明，再决定下一步。工作台不会自动重发这次请求。',at:run.updatedAt,
        action:{view:roomView(session),label:'核对结果'}});
    }
    // Only a run whose file changes are still in place has something to accept; a run that only answered does not.
    if(inRoom(session)||session.purpose||run.status!=='ended'||run.validation||run.workspaceUndo?.status!=='available')continue;
    if(decidedRuns.has(run.id))continue;
    const stale=staleByRun.get(run.id);
    const desk=store.get('desk_session_links',session.id)||isConversationSession(session,runs),origin=run.origin?.threadId;
    if(desk&&!origin&&!stale)continue;
    const outcome=origin?messages.find(message=>message.threadId===origin&&message.link?.runId===run.id&&message.link.outcome):undefined;
    const sourceThread=stale?.threadId??origin,sourceRoom=sourceThread?store.get<{roomId?:string}>('room_threads',sourceThread)?.roomId??'global':undefined;
    add({...location(run,session),id:`acceptance:${run.id}`,kind:'acceptance',title:stale?'复核结论需要更新':`${memberFor(session)?.name??run.provider} 的结果待验收`,
      detail:stale?'复核后作者的文件又改过，旧结论已过期。请先重新核对。':short(run.input)||session.title,at:run.completedAt??run.updatedAt,
      ...(sourceThread?{threadId:sourceThread,roomId:sourceRoom as RoomState['roomId'],messageId:stale?.id??outcome?.id}:{}),action:{view:sourceRoom?sourceRoom==='global'?'room':'project-room':'session',label:stale?'查看过期复核':'核对并验收'}});
  }
  for(const provider of providers){
    if(provider.auth!=='none'||provider.available||provider.stale||provider.runtimeReady===false)continue;
    const member=members.find(item=>item.executor===provider.id);if(!member)continue;
    add({id:`login:${provider.id}`,kind:'login',title:`${member.name} 需要登录`,detail:'打开成员设置，使用这个程序的官方登录入口。',at:provider.checkedAt??thread.createdAt,
      provider:provider.id,memberId:member.id,action:{view:'member-settings',label:'去登录'}});
  }
  for(const notice of store.list<WorkspaceConflictNotice>('workspace_conflicts')){
    const session=sessions.get(notice.sessionId);
    if(!usable(session)||!session.workspace||session.workspace!==notice.workspace||!notice.conflicts.length)continue;
    add({id:`merge-conflict:${session.id}`,kind:'merge-conflict',projectId:session.projectId,sessionId:session.id,provider:session.provider,memberId:memberFor(session)?.id,
      title:`${projects.get(session.projectId)?.name??'项目'} 上次应用有冲突`,detail:`上次发现 ${notice.conflicts.length} 个冲突，未写入任何文件。请查看差异，处理后再应用。`,at:notice.at,
      action:{view:'workspace',label:'查看冲突和差异'}});
  }
  const counts=Object.fromEntries(ATTENTION_KINDS.map(kind=>[kind,0])) as AttentionSummary['counts'];
  for(const flow of store.list<ProjectFlow>('project_flows').filter(f=>f.status==='awaiting_plan'&&projects.has(f.projectId))){
    const plan=store.list<Plan>('flow_plans').filter(p=>p.flowId===flow.id&&p.status==='awaiting_confirmation').sort((a,b)=>b.version-a.version)[0];
    if(plan)add({id:'plan-confirmation:'+plan.id,kind:'decision',projectId:flow.projectId,flowId:flow.id,memberId:flow.leadMemberId,title:`方案第 ${plan.version} 版待确认`,detail:plan.objective,at:plan.updatedAt,action:{view:'project-room',label:'确认方案'}});
  }
  for(const round of store.list<Round>('flow_rounds'))if(round.status==='awaiting_acceptance'&&round.requiresUserAcceptance&&store.get<ProjectFlow>('project_flows',round.flowId)?.activePlanId===round.planId&&store.get<ProjectFlow>('project_flows',round.flowId)?.status==='active'){
    const acceptance=round.acceptanceId?store.get<Acceptance>('flow_acceptances',round.acceptanceId):undefined;
    add({id:'round-acceptance:'+round.id,kind:'round-acceptance',projectId:round.projectId,flowId:round.flowId,roundId:round.id,title:round.title+' 成品待验收',detail:acceptance?.status==='conflict'?'应用有冲突，请处理后重新验收。':acceptance?.status==='recovery_required'?'应用中断，需先核对和恢复。':round.report?.summary??'负责人已完成整合检查。',at:round.updatedAt,action:{view:'project-room',label:'查看本轮成品'}});
  }
  for(const decision of store.list<Decision>('flow_decisions'))if(decision.status==='open'&&!['completed','cancelled'].includes(store.get<ProjectFlow>('project_flows',decision.flowId)?.status??''))add({id:'decision:'+decision.id,kind:'decision',projectId:decision.projectId,flowId:decision.flowId,roundId:decision.roundId,decisionId:decision.id,title:decision.title,detail:decision.reason,at:decision.updatedAt,action:{view:'project-room',label:'处理决策'}});
  for(const proposal of store.list<TaskAddition>('flow_task_additions')){const flow=store.get<ProjectFlow>('project_flows',proposal.flowId);if(flow&&projects.has(proposal.projectId)&&!['completed','cancelled'].includes(flow.status)&&flow.activePlanId===proposal.planId&&['ready','blocked'].includes(proposal.status))add({id:'task-addition:'+proposal.id,kind:'decision',projectId:proposal.projectId,flowId:proposal.flowId,roundId:proposal.roundId,memberId:proposal.memberId,title:proposal.status==='ready'?'追加任务待确认：'+proposal.title:'追加任务准备需要核对：'+proposal.title,detail:short(proposal.error??proposal.scopeReason??proposal.goal),at:proposal.updatedAt,action:{view:'project-room',label:'查看追加草案'}});}
  for(const review of store.list<JointReview>('flow_joint_reviews').filter(r=>projects.has(r.projectId)&&['blocked','awaiting_decision'].includes(r.status))){const decisions=store.list<JointDecision>('flow_joint_decisions').filter(d=>d.jointReviewId===review.id&&d.status==='open');if(decisions.length)for(const decision of decisions)add({id:'joint-decision:'+decision.id,kind:'decision',projectId:review.projectId,jointReviewId:review.id,title:decision.title,detail:decision.reason,at:decision.updatedAt,action:{view:'project-room',label:'查看评审成果'}});else add({id:'joint-blocked:'+review.id,kind:'decision',projectId:review.projectId,jointReviewId:review.id,title:'共同评审运行需要核对',detail:review.error??'核对已有记录，不会自动重发。',at:review.updatedAt,action:{view:'project-room',label:'查看评审成果'}});}
  const ignored=new Map(store.list<AttentionDismissal>('attention_dismissals').map(item=>[item.id,item.fingerprint]));
  const sorted=[...items.values()].filter(item=>includeIgnored||ignored.get(item.id)!==item.fingerprint).sort((a,b)=>ATTENTION_KINDS.indexOf(a.kind)-ATTENTION_KINDS.indexOf(b.kind)||b.at.localeCompare(a.at)||a.id.localeCompare(b.id));
  for(const item of sorted)counts[item.kind]++;
  return {items:sorted,counts,total:sorted.length,generatedAt:new Date().toISOString()};
}

/** A notification preference, never an acknowledgement of delivery, approval or acceptance. */
export function dismissAttention(store:Store,providers:ProviderInfo[],answerable:ReadonlySet<string>,id:unknown,fingerprint:unknown):AttentionSummary {
  const item=collectAttention(store,providers,answerable,true).items.find(item=>item.id===id);
  if(!item||typeof fingerprint!=='string'||item.fingerprint!==fingerprint)throw new Error('这条提醒已变化或已经不存在，请刷新后重新查看。');
  const {projectId,sessionId,runId,roomId,threadId}=item;
  store.put('attention_dismissals',item.id,{id:item.id,fingerprint,dismissedAt:new Date().toISOString(),projectId,sessionId,runId,roomId,threadId} satisfies AttentionDismissal);
  return collectAttention(store,providers,answerable);
}
