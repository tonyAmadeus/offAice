import type {RoomMessage} from './types';

/** One current card per project/round/member/role, retaining every saved version and ordinary reply. */
export function mergeMemberReports(messages:RoomMessage[]):RoomMessage[]{
  const ordinary:RoomMessage[]=[],groups=new Map<string,RoomMessage[]>();
  for(const message of messages){
    const report=message.memberReport;
    if(!report){ordinary.push(message);continue;}
    const key=JSON.stringify([message.roomId,message.threadId,report.id,report.projectId,report.roundId,report.memberId,report.role]);
    const group=groups.get(key)??[];group.push(message);groups.set(key,group);
  }
  for(const group of groups.values()){
    const versions=new Map<string,NonNullable<RoomMessage['memberReportVersions']>[number]>();
    for(const message of group){
      for(const version of message.memberReportVersions??[])versions.set(version.messageId,version);
      versions.set(message.id,{messageId:message.id,at:message.at,report:message.memberReport!});
    }
    const ordered=[...versions.values()].sort((a,b)=>a.at.localeCompare(b.at)),latest=ordered.at(-1)!;
    const message=group.find(m=>m.id===latest.messageId)??group.at(-1)!;
    ordinary.push({...message,id:latest.messageId,at:latest.at,memberReport:latest.report,text:latest.report.summary.join('\n\n')||latest.report.title,memberReportVersions:ordered.slice(0,-1)});
  }
  return ordinary.sort((a,b)=>a.at.localeCompare(b.at)||Number(a.author!=='user')-Number(b.author!=='user')||a.id.localeCompare(b.id));
}
