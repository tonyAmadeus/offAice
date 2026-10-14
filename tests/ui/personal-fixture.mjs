/** Browser-only personal-room fixture for presentation/error tests; real workflow tests use Engine. */
export async function installPersonalFixture(page){
  await page.addInitScript(()=>{
    const original=window.airoom.invoke,topics=new Map(),reads=new Set(),summaries=new Map();
    const source=()=>window.__snapshot;
    const sessions=id=>source().sessions.filter(s=>(s.memberId??s.provider)===id&&!s.flowId&&!s.roomId&&!s.purpose?.startsWith('flow-')&&!s.purpose?.startsWith('room-')&&!source().runs.some(r=>r.sessionId===s.id&&r.flowOperationId));
    function current(roomId){const id=roomId.slice(5),old=topics.get(roomId);if(old&&source().sessions.some(s=>s.id===old))return old;const s=[...sessions(id)].sort((a,b)=>Number(Boolean(a.archived))-Number(Boolean(b.archived))||b.updatedAt.localeCompare(a.updatedAt))[0];if(s){topics.set(roomId,s.id);return s.id;}return undefined;}
    const active=s=>source().runs.some(r=>r.sessionId===s&&['running','queued','waiting_user','stopping'].includes(r.status));
    function overview(){return ['claude','codex','dsh',...source().members?.filter(m=>!m.builtIn).map(m=>m.id)??[]].flatMap(id=>{const roomId='desk:'+id,s=current(roomId);if(!s)return [];const signature=JSON.stringify([source().runs,source().events,source().approvals,topics.get(roomId),summaries.get(s),source().sessions]);let revision=0;for(const c of signature)revision=(revision*31+c.charCodeAt(0))>>>0;return [{roomId,kind:'desk',memberId:id,revision,currentThreadId:'desk-topic-'+s,sessionId:s,folder:source().projects.find(p=>p.id===source().sessions.find(x=>x.id===s)?.projectId)?.directory,state:{active:active(s),mode:'chat'},unread:false,pending:source().approvals.some(a=>a.sessionId===s&&a.state==='pending')}];});}
    async function room(roomId){
      const member=roomId.slice(5),id=current(roomId),session=source().sessions.find(s=>s.id===id);if(!session)return {state:{active:false,mode:'chat'},threads:[],messages:[]};
      const threads=sessions(member).map(s=>({id:'desk-topic-'+s.id,roomId,title:s.title,createdAt:s.createdAt,archivedAt:s.id!==id?s.updatedAt:undefined,count:source().runs.filter(r=>r.sessionId===s.id).length*2,summary:summaries.get(s.id)}));
      const stored=await original('session.events',{sessionId:id}),events=[...(Array.isArray(stored)?stored:[]),...source().events.filter(e=>e.sessionId===id)];
      const messages=source().runs.filter(r=>r.sessionId===id).flatMap(r=>[{id:'user-'+r.id,roomId,threadId:'desk-topic-'+id,author:'user',text:r.input??r.inputPreview,at:r.createdAt},{id:'reply-'+r.id,roomId,threadId:'desk-topic-'+id,author:member,runId:r.id,text:events.filter(e=>e.runId===r.id&&['message','delta'].includes(e.kind)).map(e=>e.text).join(''),at:r.completedAt??r.createdAt,status:active(id)&&['running','queued','waiting_user','stopping'].includes(r.status)?'speaking':r.status==='ended'?'done':r.status==='stopped'?'stopped':'failed',error:r.error}]);
      return {roomId,sessionId:id,directory:session.workspace??source().projects.find(p=>p.id===session.projectId)?.directory,direct:session.workspaceKind==='original',personalFolder:source().dataDirectory+'\\desks\\'+member,state:{active:active(id),mode:'chat'},currentThreadId:'desk-topic-'+id,threadId:'desk-topic-'+id,threads,messages,hasMore:false,readToken:'read-'+id};
    }
    const subscribe=window.airoom.onEvent;
    window.airoom.onEvent=listener=>subscribe(event=>listener(event.type==='snapshot'?{...event,snapshot:{...event.snapshot,rooms:overview()}}:event));
    window.airoom.invoke=async(method,params={})=>{
      if(method==='snapshot'){const snapshot=await original(method,params);snapshot.rooms=[...snapshot.rooms?.filter(r=>!r.roomId.startsWith('desk:'))??[],...overview()];return snapshot;}
      if(method==='desk.open'){window.__calls.push({method,params});return room('desk:'+params.memberId);}
      if(method==='desk.switchFolder'){window.__calls.push({method,params});return room('desk:'+params.memberId);}
      if(method==='desk.topic'){window.__calls.push({method,params});params={...params,roomId:'desk:'+params.memberId};method='room.archive';}
      if(method.startsWith('room.')&&params.roomId?.startsWith('desk:')){
        window.__calls.push({method,params});const roomId=params.roomId,id=current(roomId),member=roomId.slice(5);
        const publish=()=>window.__listeners?.forEach(fn=>fn({type:'snapshot',snapshot:{...structuredClone(source()),rooms:overview()}}));
        if(method==='room.get'||method==='room.history')return room(roomId);
        if(method==='room.read'){reads.add(params.readToken);return {};}
        if(method==='room.select'){topics.set(roomId,params.threadId.replace('desk-topic-',''));publish();return {};}
        if(method==='room.rename'){await original('session.update',{sessionId:params.threadId.replace('desk-topic-',''),title:params.title});return {};}
        if(method==='room.stop'){for(const r of source().runs.filter(r=>r.sessionId===id&&['running','waiting_user','queued'].includes(r.status))){await original('run.stop',{runId:r.id});r.status='stopped';r.completedAt=new Date().toISOString();}publish();return {};}
        if(method==='room.send'){const result=await original('session.send',{sessionId:id,text:params.text,attachments:params.attachments,intent:'message'});return result;}
        if(method==='room.compress'){summaries.set(id,{text:'保留目标、结论与未完成事项。',by:member,at:new Date().toISOString(),count:2});publish();return {};}
        if(method==='room.export'){const data=await room(roomId);return {title:data.threads.find(t=>t.id===params.threadId)?.title??'话题',content:data.messages.map(m=>m.text).join('\n\n')};}
        if(method==='room.delete'){await original('session.delete',{sessionId:params.threadId.replace('desk-topic-',''),discardWorkspace:false});publish();return {};}
        if(method==='room.archive'){const old=source().sessions.find(s=>s.id===id);if(old)old.archived=true;const next={...old,id:'new-topic-'+Date.now(),projectId:old?.projectId??source().projects.find(p=>!p.kind)?.id,memberId:member,revision:1,title:params.title??'当前话题',provider:old?.provider??source().members?.find(m=>m.id===member)?.executor??member,writeMode:true,nativeId:undefined,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),archived:false,workspaceKind:'original',workspace:source().dataDirectory+'\\desks\\'+member};source().sessions.push(next);topics.set(roomId,next.id);publish();return {id:'desk-topic-'+next.id};}
      }
      return original(method,params);
    };
  });
}
