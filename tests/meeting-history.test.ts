import test from 'node:test';
import assert from 'node:assert/strict';
import {MATERIAL_CHARS,meetingHistory,meetingMaterial} from '../src/backend/meeting-history';
import {readableContent} from '../src/shared/content-presentation';

test('meeting history carries IDs once and identical prose once without turning repeats into votes',()=>{
  const a={id:'a',author:'first',text:'相同方案'},b={id:'b',author:'second',text:'相同方案'};
  const view=meetingHistory({messages:[a,b],references:[a],recent:[b],background:[{text:'相同方案'}]});
  assert.equal(view.messages.length,2);assert.equal(view.messages[1].duplicateOf,'a');assert.equal(view.messages[1].author,'second');assert.equal(view.references.length,0);assert.equal(view.recent.length,0);assert.equal(view.background.length,0);
});
test('history excerpts retain every unread ID and both ends with explicit incomplete coverage',()=>{
  const original=Array.from({length:16},(_,i)=>({id:String(i),text:'开始-'+String(i)+'文'.repeat(12000)+'-结尾'}));
  const result=meetingHistory({messages:original,references:[],recent:[],background:[]});
  assert.deepEqual(result.messages.map(m=>m.id),original.map(m=>m.id));
  assert.ok(JSON.stringify(result).length<36000);assert.ok(result.messages.every(m=>m.text.includes('中段省略')&&m.text.endsWith('-结尾')));assert.equal(original[0].text.length>12000,true);
});
test('roundtable material excerpts cover each candidate and remain valid JSON',()=>{
  const facts={opinions:Array.from({length:5},(_,i)=>({memberId:'m'+i,summary:'观点'+i+'文'.repeat(15000)})),selectedSlotId:null};
  const result=meetingMaterial(facts),encoded=JSON.stringify(result.material),parsed=JSON.parse(encoded);
  assert.ok(encoded.length<=MATERIAL_CHARS-500);assert.equal(parsed.opinions.length,5);assert.equal(result.truncated,true);assert.equal(parsed.selectedSlotId,null);
});
test('structured deliverables render prose without protocol, checks or provenance fields',()=>{
  const raw=JSON.stringify({protocol:'airoom.project-flow',version:1,payload:{summary:'说明',proposal:{concept:'办公室群像',storyboard:[{time:'0–5s',description:'全员登场'}]},evidence:[{command:'secret-check'}],fingerprint:'internal-hash'}});
  const rendered=readableContent(raw);assert.match(rendered,/办公室群像/);assert.match(rendered,/全员登场/);assert.doesNotMatch(rendered,/protocol|evidence|internal-hash|secret-check/);
  assert.equal(readableContent('如何实现 JSON 校验算法？'),'如何实现 JSON 校验算法？');
});


test('structured proposals retain storyboard alongside a summary and the latest human request is complete',()=>{
  const rendered=readableContent(JSON.stringify({summary:'故事概要',storyboard:[{description:'第二个镜头'}]}));
  assert.match(rendered,/故事概要/);assert.match(rendered,/第二个镜头/);
  const request='必须保留的需求：'+'文'.repeat(18000),view=meetingHistory({messages:[{id:'u',author:'user',text:request}],recent:[],references:[],background:[]});assert.equal(view.messages[0].text,request);
});
