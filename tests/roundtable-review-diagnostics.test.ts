import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCompatibleJson} from '../src/shared/flow-format';
import {parseReply} from '../src/shared/project-flow-protocol';
import {validateJointOpinion,assertJointMeaning} from '../src/shared/joint-review-protocol';
import {parseDiscussionReply} from '../src/shared/discussion';
import {labelPeerLetters,peerFindingTarget,peerReviewTargets,type JointReviewDetail,type JointSlot} from '../src/shared/joint-review';
import type {RoundtableTopic} from '../src/shared/roundtable';
import {roundtableDiscussionFacts} from '../src/backend/roundtable-material';
import {meetingMaterial} from '../src/backend/meeting-history';
import {jointHarness} from './helpers/joint-review-harness';

test('literal line breaks and tabs in JSON strings preserve the full decoded original without guessing missing quotes',()=>{
  const body='第一段\n\n第二段\t制表符\r\n结尾',raw='{"body":"'+body+'"}';
  assert.throws(()=>JSON.parse(raw));assert.equal((parseCompatibleJson(raw) as any).body,body);
  const response='{"protocol":"airoom.project-flow","version":1,"kind":"joint-independent","payload":{"summary":"原结论","proposal":"'+body+'"}}';
  assert.equal(validateJointOpinion(parseReply(response,'joint-independent')).proposal,body);
  assert.throws(()=>parseCompatibleJson('{"body":"末尾\\\n未结束"}'));
  assert.throws(()=>parseCompatibleJson('{"body":"缺少结尾'));
});

test('ordinary discussion accepts raw newlines while retaining exact turn and revision checks',()=>{
  const body='完整原话\n下一段',raw='{"version":1,"turn":"actual","revision":7,"action":"speak","body":"'+body+'"}';
  assert.equal(parseDiscussionReply(raw,'actual',7).body,body);
  assert.throws(()=>parseDiscussionReply(raw,'other',7));assert.throws(()=>parseDiscussionReply(raw,'actual',8));
});

test('optional observations may omit a change request without weakening real required fixes or inventing advice',()=>{
  const observation={location:'可见画面',kind:'verified',severity:'optional',evidence:'已完整说明可见的原始细节'};
  const raw={summary:'原结论',proposal:'原稿',findings:[observation]},before=structuredClone(raw),parsed=validateJointOpinion(raw);
  assert.equal(parsed.findings[0].request,'');assert.equal(parsed.findings[0].evidence,observation.evidence);assert.deepEqual(raw,before);
  for(const severity of ['blocking','should-fix']){
    const missing=validateJointOpinion({...raw,findings:[{...observation,severity}]});
    assert.equal(missing.findings[0].severity,severity);assert.equal(missing.findings[0].request,'');assert.equal(missing.findings[0].evidence,observation.evidence);assert.ok(missing.replyNotes?.length);
    assert.equal(validateJointOpinion({...raw,findings:[{...observation,severity,request:''}]}).findings[0].severity,severity);
  }
  const envelope=(value:unknown)=>JSON.stringify({protocol:'airoom.project-flow',version:1,kind:'joint-independent',payload:value});
  const original=parseReply(envelope(raw),'joint-independent'),changed=parseReply(envelope({...raw,findings:[{...observation,request:'新编造的修改建议'}]}),'joint-independent');
  assert.throws(()=>assertJointMeaning(original,changed),/格式补正/);
});

test('peer reviewers stay anonymous while each finding records the candidate it is about',async()=>{
  const h=await jointHarness({handler:async call=>{
    if(call.kind!=='joint-peer')return undefined;
    // One finding names its letter in the field; the other only mentions it in the text.
    return {summary:'方案 A 结构清楚；方案 B 缺少结论。',findings:[
      {location:'结论段',kind:'suspected',severity:'should-fix',evidence:'没有总结',request:'补上结论',candidate:'B'},
      {location:'方案 A 第二段',kind:'suggestion',severity:'optional',evidence:'可再精简'},
    ],unverifiedItems:[],evidence:[]};
  }});
  try{
    const {jointReviewId:id}=await h.start(),detail=await h.wait(id,s=>s.review.status==='completed');
    for(const peer of detail.slots.filter(s=>s.stage==='peer')){
      const call=h.calls.find(c=>c.kind==='joint-peer'&&(c.ctx.session.memberId??c.ctx.session.provider)===peer.memberId)!;
      assert.ok(call.material.candidates.every((c:any)=>c.memberId===undefined&&c.memberName===undefined&&c.slotId===undefined),'reviewers see letters only');
      assert.match(call.material.instruction,/candidate/);assert.match(call.prompt,/candidate:string/);
      const letter=(l:string)=>peer.peerMap!.find(p=>p.letter===l)!.slotId;
      assert.deepEqual(peer.opinion!.findings.map(f=>[f.candidate,f.targetSlotId]),[['B',letter('B')],['A',letter('A')]]);
      const summary=h.calls.find(c=>c.kind==='joint-summary')!.material.peerOpinions.find((p:any)=>p.slotId===peer.id);
      assert.deepEqual(summary.targets,peer.peerMap,'the lead still compares blind candidates');
    }
    assert.ok(detail.review.findings.filter(f=>detail.slots.find(s=>s.id===f.slotId)?.stage==='peer').every(f=>f.targetSlotId));
    assert.equal(h.calls.filter(c=>c.correction).length,0);
  }finally{await h.dispose();}
});

test('the owner sees member names next to each reviewer own letters and in the public discussion',()=>{
  const names:Record<string,string>={a:'Claudia',b:'Gptia'},targets=[{letter:'A',slotId:'sa',memberId:'a'},{letter:'B',slotId:'sb',memberId:'b'}];
  assert.equal(labelPeerLetters('方案 A 更完整，方案B 缺结论，方案 A（Claudia）已标注，方案 C 不存在。',targets,id=>names[id]),'方案 A（Claudia） 更完整，方案B（Gptia） 缺结论，方案 A（Claudia）已标注，方案 C 不存在。');
  assert.deepEqual(peerFindingTarget({location:'方案 B 第一段',evidence:'',request:''},[{letter:'A',slotId:'sa'},{letter:'B',slotId:'sb'}]),{candidate:'B',targetSlotId:'sb'});
  assert.deepEqual(peerFindingTarget({location:'方案 A 与方案 B 都缺',evidence:'',request:''},[{letter:'A',slotId:'sa'},{letter:'B',slotId:'sb'}]),{},'two letters stay unassigned rather than guessed');
  assert.deepEqual(peerFindingTarget({location:'全文',evidence:'',request:''},[{letter:'A',slotId:'sa'}]),{candidate:'A',targetSlotId:'sa'},'a single candidate needs no letter');
  assert.deepEqual(peerFindingTarget({location:'Options are fine; 方案 B 缺结论',evidence:'',request:''},[{letter:'A',slotId:'sa'},{letter:'B',slotId:'sb'}]),{candidate:'B',targetSlotId:'sb'},'English words are not letters');
  const slot=(id:string,memberId:string,stage:JointSlot['stage']):JointSlot=>({id,projectId:'p',flowId:'r',schemaVersion:1,revision:1,createdAt:'2026-10-13T00:00:00Z',updatedAt:'2026-10-13T00:00:00Z',attempt:1,jointReviewId:'r',stage,status:'completed',memberId,opinion:{summary:'意见',findings:[],unverifiedItems:[],evidence:[]}});
  const slots=[slot('sa','a','independent'),slot('sb','b','independent')];
  const detail={review:{findings:[{id:'f',location:'结论',kind:'suggestion',severity:'optional',evidence:'',request:'',memberId:'b',slotId:'peer',candidate:'A',targetSlotId:'sa'}],responses:[],dispositions:[]},slots,decisions:[]} as unknown as JointReviewDetail;
  const facts=roundtableDiscussionFacts({material:{text:'需求'}} as RoundtableTopic,detail,id=>names[id]??id);
  assert.equal((facts.findings[0] as any).targetMemberName,'Claudia');
});

test('peer labels do not resolve to self, another review or a missing candidate',()=>{
  const peer={id:'peer',jointReviewId:'same',stage:'peer',memberId:'a',peerMap:[{letter:'A',slotId:'own'},{letter:'B',slotId:'foreign'},{letter:'C',slotId:'missing'},{letter:'D',slotId:'other'}]} as JointSlot;
  const slots=[peer,{id:'own',jointReviewId:'same',stage:'independent',memberId:'a'},{id:'foreign',jointReviewId:'foreign',stage:'independent',memberId:'b'},{id:'other',jointReviewId:'same',stage:'independent',memberId:'b'}] as JointSlot[];
  assert.deepEqual(peerReviewTargets(peer,slots),[{letter:'D',slotId:'other',memberId:'b'}]);
});

test('discussion material keeps each full finding and original observation once before considering excerpts',()=>{
  const observation='完整依据-'+ '原'.repeat(1200),reason='原处置理由-'+ '理'.repeat(400);
  const slots=Array.from({length:3},(_,i):JointSlot=>({id:'s'+i,projectId:'p',flowId:'r',schemaVersion:1,revision:1,createdAt:'2026-10-13T00:00:00Z',updatedAt:'2026-10-13T00:00:00Z',attempt:1,jointReviewId:'r',stage:'independent',status:'completed',memberId:'m'+i,opinion:{summary:'原总结'+i+'文'.repeat(500),proposal:'原候选'+i,unverifiedItems:['未核实事项'+i],findings:[{id:'f'+i,location:'位置'+i,kind:'suspected',severity:'optional',evidence:observation,request:''}],evidence:[{kind:'inspection',description:observation,result:observation,eventIds:[],source:'reported'}]}}));
  const findings=slots.flatMap(s=>s.opinion!.findings.map(f=>({...f,memberId:s.memberId,slotId:s.id}))),dispositions=findings.map(f=>({findingId:f.id,action:'defer',reason}));
  const detail={slots,review:{findings,responses:[],dispositions,conclusion:{summary:'原结论',synthesis:'原综合稿',dispositions,disagreements:[],verificationRequests:[]},outcome:'inconclusive'}} as unknown as JointReviewDetail;
  const topic={material:{text:'原要求'}} as RoundtableTopic,before=structuredClone(detail),facts=roundtableDiscussionFacts(topic,detail,id=>'成员'+id),prepared=meetingMaterial(facts);
  assert.deepEqual(detail,before);assert.equal(prepared.truncated,false);assert.ok(prepared.sentChars<17000);
  assert.equal(facts.findings.length,3);assert.ok(facts.findings.every(f=>f.evidence===observation));
  for(const item of facts.opinions){assert.deepEqual(item.opinion.findingIds,[item.memberId.replace('m','f')]);assert.equal(item.opinion.evidence[0].result,observation);assert.equal(item.opinion.evidence[0].description,undefined);}
  assert.equal(facts.conclusion?.summary,'原结论');assert.equal(facts.conclusion?.dispositionsReference,'dispositions');assert.ok(facts.dispositions.every(d=>d.reason===reason));
  const unique={...detail,slots:[{...slots[0],opinion:{...slots[0].opinion!,findings:[{...slots[0].opinion!.findings[0],evidence:'这份独有的依据'}]}}]};
  assert.equal(roundtableDiscussionFacts(topic,unique,id=>id).opinions[0].opinion.findings?.[0].evidence,'这份独有的依据');
});

test('oversize material reports actual lengths and preserves both ends without calling it a failed reply',()=>{
  const value={opinions:[{summary:'开头'+'文'.repeat(60000)+'结尾'}]},result=meetingMaterial(value),encoded=JSON.stringify(result.material);
  assert.equal(result.originalChars,JSON.stringify(value).length);assert.equal(result.sentChars,encoded.length);assert.equal(result.truncated,true);
  assert.ok(encoded.includes('开头'));assert.ok(encoded.includes('结尾'));assert.ok(encoded.includes('中段省略'));
});
