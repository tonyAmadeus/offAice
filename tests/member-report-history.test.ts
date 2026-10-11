import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeMemberReports} from '../src/shared/member-report-history';
import type {RoomMessage} from '../src/shared/types';
import type {MemberReport} from '../src/shared/project-workbench';

const report=(id:string,summary:string,role:MemberReport['role']='author'):MemberReport=>({id,projectId:'project',roundId:'round',memberId:'claude',role,title:'第 1 轮',summary:[summary]} as MemberReport);
const message=(id:string,at:string,body?:MemberReport):RoomMessage=>({id,at,text:body?.summary.join('')??'保留这条提问',author:body?'claude':'user',roomId:'report:project:claude',threadId:'thread',...(body?{memberReport:body}:{})});

test('report versions fold across pages and live updates while replies and exact historical facts remain',()=>{
  const first=message('v1','1',report('same','尚未完成')),question={...message('question','2'),replyTo:'v1'},second=message('v2','3',report('same','已完成'));
  const folded=mergeMemberReports([first,question,second]);
  assert.equal(folded.length,2);assert.deepEqual(folded[0],question);assert.equal(folded[1].id,'v2');assert.deepEqual(folded[1].memberReportVersions,[{messageId:'v1',at:'1',report:first.memberReport}]);
  const third=message('v3','4',report('same','已验收')),merged=mergeMemberReports([first,...folded,third]);
  assert.equal(merged.length,2);assert.equal(merged[1].id,'v3');assert.deepEqual(merged[1].memberReportVersions?.map(v=>v.messageId),['v1','v2']);assert.equal(first.memberReport?.summary[0],'尚未完成');
});

test('different roles, rounds, members and rooms never merge; equal timestamps keep the last saved fact',()=>{
  const versions=[message('z-old','1',report('same','旧')),message('a-new','1',report('same','新'))];
  for(const patch of [{role:'lead'},{roundId:'round2'},{memberId:'codex'}] as Partial<MemberReport>[])versions.push(message(JSON.stringify(patch),'2',{...report('same','另一个职责'),...patch}));
  versions.push({...message('other-room','3',report('same','另一个房间')),roomId:'report:other:claude'});
  const merged=mergeMemberReports(versions);assert.equal(merged.length,5);assert.equal(merged[0].memberReport?.summary[0],'新');assert.equal(merged[0].memberReportVersions?.[0].report.summary[0],'旧');
});
