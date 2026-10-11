import { ActiveRunProgress } from './run-progress';
import { useEffect, useRef, useState } from 'react';
import { FolderOpen, MoreHorizontal, Settings2 } from 'lucide-react';
import type { Session, Snapshot } from '../shared/types';
import { RoomView } from './room';
import { Avatar, useTeam } from './members';
import { ApprovalCard } from './panels';
import { ContextMenu, ModelPopover, isBusy, type MenuState } from './interactions';
import { WorkspaceUndoDialog } from './workspace-undo';
import { Modal } from './modals';
import type { Invoke } from './ui';
import type { ApplyResult } from '../backend/workspace';
import { ErrorBoundary } from './ErrorBoundary';
import { requestedConfig } from '../shared/executor-config';
import type { PersonalRoomData } from '../shared/member-workspaces';
import './desk-folders.css';
import {workspaceLocation} from './workspace-location';

/** The personal desk has the shared chat, its own approvals and model picker. Project panels live in reports. */
export function MemberDesk({memberId,snapshot,invoke,onSettings}:{memberId:string;snapshot:Snapshot;invoke:Invoke;onSettings:()=>void}){
  const team=useTeam(),member=team.get(memberId),roomId=`desk:${memberId}` as const;
  const overview=snapshot.rooms?.find(r=>r.roomId===roomId),session=snapshot.sessions.find(s=>s.id===overview?.sessionId);
  const location=workspaceLocation(session,overview?.folder);
  const [model,setModel]=useState<{anchor:DOMRect;session:Session}|null>(null),[menu,setMenu]=useState<MenuState>(null),[undo,setUndo]=useState<Session|null>(null),[apply,setApply]=useState<ApplyResult|null>(null);
  const [folders,setFolders]=useState<PersonalRoomData|null>(null),[switching,setSwitching]=useState(false);
  const folderRead=useRef(0),folderOpen=useRef(false);
  function closeFolders(){folderOpen.current=false;folderRead.current++;setFolders(null);}
  async function openFolders(){const ticket=++folderRead.current;try{const value=await invoke<PersonalRoomData>('room.get',{roomId});if(ticket===folderRead.current){folderOpen.current=true;setFolders(value);}}catch{}}
  useEffect(()=>{if(!folders||!folderOpen.current)return;let current=true;const ticket=++folderRead.current;void invoke<PersonalRoomData>('room.get',{roomId}).then(value=>{if(current&&folderOpen.current&&ticket===folderRead.current)setFolders(value);}).catch(()=>{});return()=>{current=false;};},[Boolean(folders),overview?.revision]);
  async function switchFolder(directory:string){folderOpen.current=false;folderRead.current++;setSwitching(true);try{await invoke('desk.switchFolder',{memberId,directory});closeFolders();}catch{folderOpen.current=true;}finally{setSwitching(false);}}
  const approvals=snapshot.approvals.filter(a=>a.sessionId===session?.id&&a.state==='pending');
  const latest=snapshot.runs.filter(r=>r.sessionId===session?.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
  async function applyCopy(target:Session){if(!window.confirm('把这个话题工作副本的改动应用到原文件夹？会先检查冲突。'))return;try{setApply(await invoke('workspace.apply',{sessionId:target.id}));}catch{}}
  /** Folder actions in one menu: the personal folder always, the topic's work copy when it has one. */
  function deskMenu(event:React.MouseEvent<HTMLButtonElement>,target?:Session){
    const rect=event.currentTarget.getBoundingClientRect(),busy=target?isBusy(snapshot,target.id):false,copy=target&&target.workspaceKind!=='original';
    setMenu({x:rect.left,y:rect.bottom+6,items:[
      ...(target?[{label:'打开当前工作位置',icon:<FolderOpen size={14}/>,disabled:target.restoredHistoryOnly,onSelect:()=>{void invoke('workspace.open',{sessionId:target.id}).catch(()=>{});}}]:[]),
      {label:'打开个人文件夹',icon:<FolderOpen size={14}/>,disabled:!member,onSelect:()=>{void invoke('desk.folder',{memberId}).catch(()=>{});}},
      ...(copy&&target?['separator' as const,
        {label:'应用到原文件夹',disabled:busy||!target.workspace,onSelect:()=>{void applyCopy(target);}},
        {label:'撤销最近一轮',disabled:busy||!target.workspace,onSelect:()=>setUndo(target)},
        {label:'丢弃工作副本',disabled:busy||!target.workspace,danger:true,onSelect:()=>{if(window.confirm('丢弃这个话题的工作副本？未应用的改动会丢失，原文件夹保留。'))void invoke('workspace.discard',{sessionId:target.id}).catch(()=>{});}}]:[]),
    ]});
  }
  const defaults=(target:Session)=>{const config=member&&requestedConfig(snapshot.projects.find(p=>p.id===target.projectId)??{},member.card,snapshot.settings,undefined,snapshot.executors?.find(e=>e.id===target.provider));return {model:config?.model,effort:config?.effort};};
  return <main className="member-desk" aria-label="个人工位">
    <RoomView snapshot={snapshot} invoke={invoke} roomId={roomId} personal={{kind:'desk',memberId,title:`${member?.name??memberId} 的工位`,hint:session?location.label+' · '+location.hint:overview?.folder?`当前文件夹：${overview.folder} · 开新话题后开始工作`:'每个话题使用独立会话，默认在个人文件夹工作。',
      headerActions:<><button type="button" className="button small secondary" aria-label="切换工位文件夹" onClick={()=>void openFolders()}><FolderOpen size={14}/>切换文件夹</button><button type="button" className="icon-button" aria-label={session&&session.workspaceKind!=='original'?'话题工作副本操作':'工位文件夹操作'} aria-haspopup="menu" title="打开当前工作位置、个人文件夹或处理工作副本" onClick={e=>deskMenu(e,session)}><MoreHorizontal size={16}/></button></>,
      composerControls:room=>{const target=snapshot.sessions.find(s=>s.id===room.sessionId);return target&&<button type="button" className="composer-model" aria-label="选择话题模型和思考程度" title="本话题的模型和思考程度" onClick={e=>setModel({anchor:e.currentTarget.getBoundingClientRect(),session:target})}><Settings2 size={13}/>{target.model||defaults(target).model||'成员默认'}{(target.effort||defaults(target).effort)&&` · ${target.effort||defaults(target).effort}`}</button>;},
      dock:<><ActiveRunProgress snapshot={snapshot} invoke={invoke} sessionIds={session?[session.id]:[]} label="工位工作"/>{approvals.length?<div className="personal-approvals" aria-label="当前话题审批">{approvals.map(a=><ErrorBoundary key={a.id} compact area="话题审批" resetKey={a.state}><ApprovalCard approval={a} invoke={invoke} member={member}/></ErrorBoundary>)}</div>:null}{latest?.workspaceUndo?.status==='undone'&&<p role="status" className="panel-muted">本轮文件改动已撤销，消息和原始记录保留。</p>}</>,
      empty:<div className="room-empty">{member&&<div className="room-empty-team"><Avatar member={member} size={64}/></div>}<h2>{overview?.currentThreadId?`和 ${member?.name??'成员'} 单独聊聊`:'当前文件夹还没有话题'}</h2><p>{overview?.currentThreadId?'起草、整理资料或试做一个小任务，成果保存在本话题的工作文件夹。':'点击“开新话题”开始，也可以切换文件夹查看旧话题。'}</p></div>,
    }}/>
    {folders&&<Modal title="切换工位文件夹" subtitle="只切换话题展示。各文件夹保留最近话题，正在运行的工作继续。" onClose={()=>{if(!switching)closeFolders();}}><div className="modal-body desk-folder-list">{folders.folders?.map(folder=><button key={folder.key} type="button" className={`desk-folder-option ${folder.key===folders.folderKey?'selected':''}`} aria-label={`切换到 ${folder.label}`} aria-pressed={folder.key===folders.folderKey} disabled={switching} onClick={()=>void switchFolder(folder.directory)}><FolderOpen size={17}/><span><strong>{folder.label}{folder.personal?' · 直接读写':''}</strong><small>{folder.directory}</small></span><span className="desk-folder-status">{folder.topicCount} 个话题{folder.pending?' · 待回应':folder.active?' · 运行中':''}{folder.unread?' · 未读':''}</span></button>)}</div><div className="modal-footer"><button className="button secondary" disabled={switching||!member} onClick={()=>void invoke<string|null>('dialog.directory').then(directory=>{if(directory)return switchFolder(directory);}).catch(()=>{})}>选择其他文件夹</button><button className="button quiet" disabled={switching} onClick={closeFolders}>关闭</button></div></Modal>}
    {model&&<ModelPopover invoke={invoke} anchor={model.anchor} session={model.session} info={snapshot.providers.find(p=>p.id===model.session.provider)} defaults={defaults(model.session)} onSettings={onSettings} onClose={()=>setModel(null)} onSave={change=>{void invoke('session.update',{sessionId:model.session.id,...change},'话题模型设置已保存，下一轮生效。').catch(()=>{});}}/>}
    <ContextMenu menu={menu} onClose={()=>setMenu(null)}/>
    {undo&&<WorkspaceUndoDialog session={undo} invoke={invoke} notify={()=>{}} onClose={()=>setUndo(null)} onDone={()=>setUndo(null)}/>}
    {apply&&<Modal title={apply.conflicts.length?'有冲突，未应用改动':'改动已应用到原文件夹'} onClose={()=>setApply(null)}><div className="modal-body">{apply.conflicts.length?<ul>{apply.conflicts.map(c=><li key={c.path}>{c.path}：{c.reason}</li>)}</ul>:<p>已应用 {apply.applied.length} 项改动。</p>}</div><div className="modal-footer"><button className="button primary" onClick={()=>setApply(null)}>关闭</button></div></Modal>}
  </main>;
}
