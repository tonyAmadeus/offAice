import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSubmission} from '../src/shared/project-flow-protocol';
import {assertReviewMeaning} from '../src/shared/project-flow-review';
import {jointHarness,opinion} from './helpers/joint-review-harness';

const reference={kind:'source',description:'任务材料中的原始要求',location:'brief.md',excerpt:'需求原文',result:'已读取原要求'};
const submission=(source:Record<string,unknown>)=>validateSubmission({summary:'保留完整稿件',completionResults:[],evidence:[source]});

test('missing source display titles are filled locally without changing the reference or claiming verification',()=>{
  for(const title of [undefined,null,'','  ']){
    const raw={...reference,...(title===undefined?{}:{title})},before=structuredClone(raw),e=submission(raw).evidence[0];
    assert.equal(e.title,reference.description);assert.equal(e.location,reference.location);assert.equal(e.excerpt,reference.excerpt);assert.equal(e.result,reference.result);
    assert.equal(e.source,'reported');assert.equal(e.sourceVerification,'unverified');assert.deepEqual(e.eventIds,[]);assert.deepEqual(raw,before);
  }
  const {description,...withoutLabel}=reference;
  assert.equal(submission(withoutLabel).evidence[0].title,reference.location);
  assert.equal(submission({...reference,title:'原有标题'}).evidence[0].title,'原有标题');
});

test('missing reference facts and invalid display titles still fail with a specific field name',()=>{
  for(const field of ['location','excerpt'])for(const value of [undefined,' ',123])assert.throws(()=>submission({...reference,[field]:value}),new RegExp(`evidence\\[0\\]\\.${field}`));
  for(const title of [123,{},'文'.repeat(20001)])assert.throws(()=>submission({...reference,title}),/evidence\[0\]\.title/);
  assert.throws(()=>submission({...reference,sourceVerification:'verified'}),/不支持的字段/);
  assert.throws(()=>submission({...reference,location:'javascript:alert(1)'}),/链接/);
});

test('a format correction can fill a missing title while preserving all original source facts and findings',()=>{
  const before={evidence:[reference]},after={evidence:[{...reference,title:'材料文件'}]};
  assert.doesNotThrow(()=>assertReviewMeaning(before,after));
  assert.doesNotThrow(()=>assertReviewMeaning({evidence:[{...reference,title:' 原有标题 '}]},{evidence:[{...reference,title:'原有标题'}]}));
  for(const change of [{location:'other.md'},{excerpt:'新写的引文'},{result:'核验通过，已确认完成'}])assert.throws(()=>assertReviewMeaning(before,{evidence:[{...after.evidence[0],...change}]}),/格式补正/);
  assert.throws(()=>assertReviewMeaning(before,{evidence:[]}),/来源/);
  assert.throws(()=>assertReviewMeaning(before,{evidence:[...after.evidence,{...reference,title:'新增来源',location:'new.md'}]}),/来源/);
  assert.throws(()=>assertReviewMeaning({evidence:[{...reference,title:'已有标题'}]},after),/来源/);
});

test('joint opinions with an omitted source title complete with no format-correction model calls',async()=>{
  const h=await jointHarness({handler:async c=>{
    assert.equal(c.correction,false,'missing display metadata must not consume a correction');
    if(c.kind==='joint-independent')return {...opinion('原稿'),evidence:[reference]};
  }});
  try{
    const {jointReviewId:id}=await h.start({peerReview:false}),d=await h.wait(id,s=>s.review.status==='completed');
    assert.equal(h.calls.length,4);assert.equal(h.calls.filter(c=>c.correction).length,0);
    for(const slot of d.slots.filter(s=>s.stage==='independent')){
      assert.equal(slot.opinion?.proposal,'原稿 的候选正文');
      assert.equal(slot.opinion?.evidence[0].title,reference.description);
      assert.equal(slot.opinion?.evidence[0].sourceVerification,'verified','only the actual local file match verifies the quote');
    }
  }finally{await h.dispose();}
});

test('a necessary correction can add a source title but cannot replace the original proposal',async()=>{
  const h=await jointHarness({handler:async c=>{
    if(c.kind==='joint-independent')return c.correction
      ? {...opinion('原稿'),proposal:'改写后的正文',evidence:[{...reference,title:'材料文件'}]}
      : {...opinion('原稿'),evidence:[reference],extraKey:'其他格式问题'};
  }});
  try{
    const {jointReviewId:id}=await h.start({peerReview:false}),d=await h.wait(id,s=>s.review.status==='completed');
    assert.equal(h.calls.filter(c=>c.correction).length,3);
    for(const slot of d.slots.filter(s=>s.stage==='independent')){
      assert.equal(slot.opinion?.proposal,'原稿 的候选正文');assert.equal(slot.opinion?.evidence[0].excerpt,reference.excerpt);
    }
  }finally{await h.dispose();}
});
