import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {normalizeFlowPayload,parseCompatibleJson} from '../src/shared/flow-format';
import {parseReply,validatePlan,validateReview,validateSubmission} from '../src/shared/project-flow-protocol';
import {validateJointOpinion,assertJointMeaning,retainJointText} from '../src/shared/joint-review-protocol';
import {assertReviewMeaning,assessReview,commandEvidenceProblem} from '../src/shared/project-flow-review';
import {bindFlowEvidence} from '../src/backend/project-flow-evidence';
import {parseDiscussionReply} from '../src/shared/discussion';
import {harness,plan} from './helpers/project-flow-harness';
import {jointHarness} from './helpers/joint-review-harness';

const envelope=(payload:unknown,kind='review')=>JSON.stringify({protocol:'airoom.project-flow',version:1,kind,payload});

test('trailing commas are accepted without changing quoted text, escapes or the final-response boundary',()=>{
  const literal='原文里的 ,}、,]、"引号"、\\路径及换行\n保持不变';
  const raw=`{"literal":${JSON.stringify(literal)},"items":[{"value":${JSON.stringify(literal)},},],}`;
  assert.deepEqual(parseCompatibleJson(raw),{literal,items:[{value:literal}]});
  const final=envelope({summary:literal},'joint-independent');
  assert.equal((parseReply('说明：\n'+final.slice(0,-1)+',}\n完成。','joint-independent') as any).summary,literal);
  for(const invalid of ['{"value":1,,}','{"value":,}','{"value":"截断'])assert.throws(()=>parseCompatibleJson(invalid));
  assert.throws(()=>parseReply(final+'\n最新：'+final.slice(0,-3),'joint-independent'),/JSON/);
});

test('spelling variants, single items and empty optional fields retain the same opinion and native input',()=>{
  const raw={summary:'保留原判断',proposal:'原候选',FINDINGS:{location:'结尾',KIND:'Suggestion',severity:'should_fix',evidence:'已有原文',request:'补一句说明'},
    unverified_items:'原文中的一条\n仍然是同一条',evidence:{kind:'tool_result',description:'完整观察',exit_code:'0',event_ids:null,placeholder:null},user_summary:null,disagreements_placeholder:null};
  const before=structuredClone(raw),normalized=normalizeFlowPayload(raw,'joint-independent'),result=validateJointOpinion(raw);
  assert.equal(result.findings.length,1);assert.equal(result.findings[0].kind,'suggestion');assert.equal(result.findings[0].severity,'should-fix');
  assert.deepEqual(result.unverifiedItems,[raw.unverified_items]);assert.equal(result.evidence[0].kind,'inspection');assert.equal(result.evidence[0].result,'完整观察');
  assert.equal(result.evidence[0].source,'reported');assert.equal(result.evidence[0].exitCode,0);assert.equal(result.evidence[0].observedExitCode,undefined);
  assert.equal(validateJointOpinion({summary:'保留原判断',proposal:' ',unverifiedItems:null}).proposal,undefined);
  assert.deepEqual(raw,before);assert.deepEqual(normalizeFlowPayload(normalized,'joint-independent'),normalized);
});

test('one full existing observation is enough, but missing facts and unobserved commands are never manufactured',()=>{
  const full='观察原文：尚无足够材料确认，未运行测试。';
  for(const observation of [{description:full},{result:full}]){
    const e=validateSubmission({summary:'已有成果',completionResults:[],evidence:{kind:'inspection',...observation}}).evidence[0];
    assert.equal(e.description,full);assert.equal(e.result,full);assert.equal(e.source,'reported');
  }
  assert.throws(()=>validateSubmission({summary:'已有成果',completionResults:[],evidence:{kind:'inspection'}}),/文字字段/);
  const command=validateSubmission({summary:'已有成果',completionResults:[],evidence:{kind:'COMMAND',command:'npm test',description:full,exitCode:'0'}}).evidence;
  assert.equal(commandEvidenceProblem(bindFlowEvidence(command,[],['run'])[0]),'missing-completion');
  assert.throws(()=>validateSubmission({summary:'已有成果',completionResults:[],evidence:{kind:'command',description:full}}),/命令文本/);
  assert.throws(()=>validateSubmission({summary:'已有成果',completionResults:[],evidence:{kind:'inspection',description:full,exitCode:'0e0'}}),/整数/);
});

test('literal boolean and enum spelling normalization retains uncertainty instead of treating strings as truthy',()=>{
  const raw={verdict:'CHANGES REQUESTED',verification_complete:' false ',criteria_results:{criterion:'内容正确',verified:'FALSE',evidence:''},findings:null,evidence:null,
    assessments:{criterion:'结构清楚',assessment:'Partly',reason:'可以精简'}};
  const parsed=validateReview(raw,['内容正确']);
  assert.equal(parsed.verdict,'changes_requested');assert.equal(parsed.verificationComplete,false);assert.equal(parsed.criteriaResults[0].verified,false);
  assert.equal(parsed.assessments?.[0].rating,'partly');assert.equal(assessReview(parsed,['内容正确']).outcome,'inconclusive');
  for(const value of ['yes','1',1,null])assert.throws(()=>validateReview({...raw,verification_complete:value},['内容正确']),/布尔值/);
});

test('meaningful unknown fields and conflicting aliases still fail instead of silently choosing a value',()=>{
  for(const value of ['新的事实',true,false,0])assert.throws(()=>validateJointOpinion({summary:'意见',unexpected:value}),/不支持的字段/);
  for(const key of ['constructor','__proto__'])assert.throws(()=>validateJointOpinion(JSON.parse(`{"summary":"意见","${key}":{"unexpected":true}}`)),/不支持的字段/);
  assert.throws(()=>validateReview({verdict:'pass',verificationComplete:true,verification_complete:false,criteriaResults:[],findings:[],evidence:[]},[]),/重复且内容不一致/);
  assert.throws(()=>validateReview({verdict:'inconclusive',verificationComplete:false,criteriaResults:[],findings:[],evidence:[],assessments:{criterion:'结构',rating:'not',assessment:'meets',reason:'原理由'}},[]),/重复且内容不一致/);
  const source={kind:'source',location:'brief.md',excerpt:'原文',source_verification:'verified'};
  assert.throws(()=>validateSubmission({summary:'意见',completionResults:[],evidence:source}),/不支持的字段/);
});

test('compatible containers and key spelling do not relax selected members or mandatory file scopes',()=>{
  const p=plan();p.tasks=p.tasks.slice(0,1);
  const raw={...p,rounds:p.rounds[0],tasks:{...p.tasks[0],allowedPaths:'a.txt',inputs:null,dependencies:null}};
  assert.deepEqual(validatePlan(raw,['claude']).tasks[0].allowedPaths,['a.txt']);
  for(const allowedPaths of [null,[], '../outside','C:\\outside'])assert.throws(()=>validatePlan({...raw,tasks:{...raw.tasks,allowedPaths}},['claude']),/allowedPaths|相对/);
  assert.throws(()=>validatePlan({...raw,tasks:{...raw.tasks,memberId:'foreign'}},['claude']),/团队/);
  assert.throws(()=>parseReply(envelope({},'submission'),'review'),/用途/);
  assert.throws(()=>parseReply(JSON.stringify({protocol:'airoom.project-flow',version:2,kind:'review',payload:{}}),'review'),/版本/);
});

test('correction guards see canonical original claims and still reject altered facts after normalization',()=>{
  const raw={verdict:'PASS',verification_complete:'true',criteria_results:{criterion:'内容正确',verified:'true',evidence:'实际原文'},findings:null,evidence:{kind:'inspection',description:'完整原始观察'}};
  const before=parseReply(envelope(raw),'review') as any;
  assert.doesNotThrow(()=>assertReviewMeaning(before,structuredClone(before)));
  for(const change of [{verdict:'inconclusive'},{verificationComplete:false},{criteriaResults:[{...before.criteriaResults[0],verified:false}]},{evidence:[{...before.evidence[0],result:'新增检查结果'}]}])assert.throws(()=>assertReviewMeaning(before,{...before,...change}),/格式补正/);
  const opinion=parseReply(envelope({summary:'原结论',proposal:'原候选',evidence:{kind:'tool',description:'完整原始观察'}},'joint-independent'),'joint-independent');
  assert.throws(()=>assertJointMeaning(opinion,{...opinion as any,proposal:'新候选'}),/格式补正/);
});

test('discussion trailing commas retain exact turn, revision and duplicate-field authority checks',()=>{
  const reply={version:1,turn:'actual-turn',revision:7,action:'speak',body:'原话中的 ,} 与 ,] 保留'};
  const encode=(value:unknown)=>JSON.stringify(value).slice(0,-1)+',}';
  assert.equal(parseDiscussionReply(encode(reply),reply.turn,reply.revision).body,reply.body);
  for(const change of [{turn:'old'},{revision:6},{version:2}])assert.throws(()=>parseDiscussionReply(encode({...reply,...change}),reply.turn,reply.revision));
  assert.throws(()=>parseDiscussionReply(encode(reply).replace('"turn":"actual-turn"','"turn":"old","turn":"actual-turn"'),reply.turn,reply.revision));
});

test('conflicting formatting retains the original text and cannot bypass correction guards after a parse error',()=>{
  const payload={verdict:'pass',verificationComplete:true,verification_complete:false,criteriaResults:[],findings:[],evidence:[]};
  const original=parseReply(envelope(payload),'review');
  assert.equal((original as any).verdict,'pass');
  assert.throws(()=>validateReview(original,[]),/重复且内容不一致/);
  assert.throws(()=>assertReviewMeaning(original,{verdict:'pass',verificationComplete:true,criteriaResults:[],findings:[],evidence:[]}),/矛盾的字段/);
  const opinion=parseReply(envelope({summary:'原结论',Summary:'矛盾的结论',proposal:'原候选'},'joint-independent'),'joint-independent');
  const corrected=retainJointText(opinion,{summary:'重写结论',proposal:'重写候选'});
  assert.equal((corrected as any).proposal,'原候选');assert.equal((corrected as any).summary,'原结论');
  assert.throws(()=>assertJointMeaning(opinion,corrected),/矛盾的字段/);
});

test('project work proceeds without format retries while retaining the actual owner acceptance and original event text',async()=>{
  const p=plan();p.tasks=p.tasks.slice(0,1);
  const h=await harness({plan:p,handler:async c=>{
    assert.equal(c.correction,false,'compatible formatting must not consume a model correction');
    if(c.kind==='plan'){
      const {acceptanceCriteria,rounds,tasks,...rest}=p;
      return {...rest,acceptance_criteria:acceptanceCriteria,rounds:{...rounds[0],requiresUserAcceptance:'true'},tasks:{...tasks[0],allowedPaths:'a.txt',inputs:null,dependencies:null}};
    }
    if(c.kind==='submission'){
      await writeFile(path.join(c.ctx.cwd,'a.txt'),'new-a');
      return {summary:'已写好',completion_results:{criterion:'A 正确',verified:'true',evidence:'读取当前文件'},evidence:{kind:'tool',description:'当前文件原文为 new-a'}};
    }
    if(['review','integration-check'].includes(c.kind))return {verdict:'PASS',verification_complete:'true',criteria_results:(c.material.criteria??c.material.task.completionCriteria).map((criterion:string)=>({criterion,verified:'true',evidence:'读取并核对当前文件'})),findings:null,evidence:{kind:'tool-result',description:'已核对当前文件'},assessments:null,placeholder:null};
  }});
  try{
    await h.confirm();const state=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');
    assert.equal(h.calls.filter(c=>c.correction).length,0);assert.equal(state.tasks[0].status,'integrated');assert.ok(state.reviews.every(r=>r.status==='passed'));assert.equal(await h.original(),'old-a');
    assert.ok(h.engine.store.listEvents().some(e=>e.kind==='delta'&&e.text.includes('"verification_complete":"true"')));
    await h.accept();await h.wait(s=>s.flow?.status==='completed');assert.equal(await h.original(),'new-a');
  }finally{await h.dispose();}
});

test('joint summary placeholders and description-only verification reach the existing user decision with no retries',async()=>{
  const h=await jointHarness({handler:async c=>{
    assert.equal(c.correction,false);
    if(c.kind==='joint-independent')return {summary:'原意见',proposal:'原候选',findings:{location:'细节',kind:'suspected',severity:'optional',evidence:'缺少清晰细节',request:'进一步核对'},evidence:{kind:'tool',description:'已有完整观察'}};
    if(c.kind==='joint-summary')return {summary:'保留疑点',dispositions:c.material.findings.map((f:any)=>({finding_id:f.id,action:'DEFER',reason:'待核对'})),verification_requests:{finding_ids:c.material.findings[0].id,instruction:'核对原始细节'},disagreements_placeholder:null};
    if(c.kind==='verification')return {outcome:'INCONCLUSIVE',summary:'材料不足，无法核实',finding_ids:c.material.findingIds,evidence:{kind:'inspection',description:'只有已有材料，无法确认细节。'}};
  }});
  try{
    const {jointReviewId:id}=await h.start({peerReview:false}),state=await h.wait(id,s=>s.review.status==='awaiting_decision');
    assert.equal(h.calls.filter(c=>c.correction).length,0);assert.equal(h.calls.length,5);
    assert.equal(state.slots.find(s=>s.stage==='verification')?.verification?.outcome,'inconclusive');
    assert.ok(state.decisions.some(d=>d.kind==='disagreement'&&d.status==='open'));
  }finally{await h.dispose();}
});
