import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {MATERIAL_CHARS,historyExcerpt,meetingHistory,meetingMaterial} from '../src/backend/meeting-history';

const opinions=(count:number,chars:number)=>Array.from({length:count},(_,i)=>({memberName:'成员'+i,opinion:{summary:'意见'+i+'-'+'文'.repeat(chars)}}));

test('discussion material reaches members whole instead of being cut again to a chat-message size',()=>{
  const prepared=meetingMaterial({requirement:'需求',opinions:opinions(3,4000)}),text='围绕议题审议：\n'+JSON.stringify(prepared.material);
  assert.equal(prepared.truncated,false,'12 000 characters fit the material budget untouched');
  const sent=meetingHistory({messages:[{id:'m',author:'system',text,material:true}],references:[],recent:[],background:[]}).messages[0];
  assert.equal(sent.text,text);assert.equal(sent.contextExcerpt,undefined);
  // An ordinary long system message is still limited like any other history message.
  assert.ok(meetingHistory({messages:[{id:'m',author:'system',text}],references:[],recent:[],background:[]}).messages[0].text.length<=6000);
});

test('thirty detailed findings fit the actual budget without a second mid-JSON cut',()=>{
  const findings=Array.from({length:30},(_,i)=>({id:'finding-'+i,slotId:'slot-'+i,memberId:'member-'+i,location:'位置'+i,kind:'verified',severity:'should-fix',evidence:'依据开头'+'文'.repeat(500)+'依据结尾',request:'建议开头'+'改'.repeat(500)+'建议结尾'}));
  const value={requirement:'原要求',findings,dispositions:findings.map(f=>({findingId:f.id,action:'accept',reason:'原理由'+'理'.repeat(200)}))},before=structuredClone(value),prepared=meetingMaterial(value),material=prepared.material as typeof value;
  assert.equal(prepared.truncated,true);assert.ok(prepared.sentChars<=MATERIAL_CHARS-500,String(prepared.sentChars));assert.deepEqual(value,before);
  assert.deepEqual(material.findings.map(f=>f.id),findings.map(f=>f.id));assert.equal(material.findings[0].evidence.startsWith('依据开头'),true);assert.ok(material.findings[0].evidence.endsWith('依据结尾'));
  const prefix='围绕议题审议：\n',text=prefix+JSON.stringify(prepared.material),sent=meetingHistory({messages:[{id:'material',text,material:true}],references:[],recent:[],background:[]}).messages[0];
  assert.equal(sent.text,text);assert.doesNotThrow(()=>JSON.parse(sent.text.slice(prefix.length)));assert.equal(sent.contextExcerpt,undefined);
});

test('large structured metadata keeps whole head and tail entries and explicitly accounts for omissions',()=>{
  const value={findings:Array.from({length:300},(_,i)=>({id:'f'+i,slotId:'s'+i,location:'位置'+i,kind:'verified',severity:'optional',evidence:'原始观察',request:''})),dispositions:Array.from({length:300},(_,i)=>({findingId:'f'+i,action:'defer',reason:'待查'}))};
  const prepared=meetingMaterial(value,2000),material=prepared.material as any;
  assert.ok(prepared.sentChars<=2000);assert.equal(prepared.truncated,true);assert.match(material.contextExcerpt.notice,/不能据此声称/);
  assert.deepEqual(material.contextExcerpt.omitted.map((o:any)=>o.path),['findings','dispositions']);
  assert.equal(material.material.findings[0].id,'f0');assert.equal(material.material.findings.at(-1).id,'f299');
  for(const omitted of material.contextExcerpt.omitted)assert.equal(omitted.retained,material.material[omitted.path].length);
});

test('even tiny budgets stay valid JSON with accurate truncation flags and no oversized excerpt notice',()=>{
  for(const budget of [2,10,22,23,80,200,500,1000]){
    const prepared=meetingMaterial({findings:[{id:'id'.repeat(1000),evidence:'文'.repeat(2000)}]},budget),encoded=JSON.stringify(prepared.material);
    assert.ok(encoded.length<=budget,`${budget}: ${encoded.length}`);assert.equal(prepared.sentChars,encoded.length);assert.equal(prepared.truncated,true);assert.doesNotThrow(()=>JSON.parse(encoded));
    assert.ok(historyExcerpt('文'.repeat(100),budget).length<=budget);
  }
});

test('over budget, opinions are excerpted before findings, dispositions and verification',()=>{
  const finding='问题原文-'+'核'.repeat(3000),value={requirement:'需求',opinions:opinions(4,12000),findings:[{id:'f1',location:'结论段',evidence:finding}],dispositions:[{findingId:'f1',action:'accept',reason:'理由'.repeat(500)}],verification:[{summary:'核查结果'.repeat(400)}]};
  const prepared=meetingMaterial(value),text=JSON.stringify(prepared.material);
  assert.ok(prepared.truncated);assert.ok(prepared.sentChars<=MATERIAL_CHARS-500,String(prepared.sentChars));
  assert.equal(prepared.sentChars,text.length);assert.doesNotThrow(()=>JSON.parse(text),'JSON stays valid');
  const material=prepared.material as typeof value;
  assert.equal(material.findings[0].evidence,finding,'findings stay whole while opinions can shrink');
  assert.equal(material.dispositions[0].reason,value.dispositions[0].reason);assert.equal(material.verification[0].summary,value.verification[0].summary);
  assert.ok(material.opinions.every((o,i)=>o.opinion.summary.startsWith('意见'+i)&&o.opinion.summary.includes('中段省略')),'both ends of each opinion survive');
});
