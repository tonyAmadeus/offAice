import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscussionFormatError, streamDiscussionBody } from '../src/shared/discussion-format';
import { parseDiscussionReply, parseHandVote } from '../src/shared/discussion';

const reply = {version:1,turn:'current-turn',revision:7,action:'speak',body:'你好，讨论继续。'};
const parse = (value:unknown) => parseDiscussionReply(typeof value === 'string' ? value : JSON.stringify(value),reply.turn,reply.revision);

test('one complete envelope can be surrounded by prose or fences and optional fields are sanitized',()=>{
  const envelope={...reply,extra:{body:'不能显示的内层正文 { }'},next:42,replyTo:null,questions:[{to:'codex',text:'怎么验证？',extra:true},{to:4,text:'错误对象'}],answers:['q',12,'q']};
  for(const text of [JSON.stringify(envelope),`说明：\n\x60\x60\x60json\n${JSON.stringify(envelope)}\n\x60\x60\x60\n回复完毕。`]){
    const result=parse(text);assert.equal(result.body,reply.body);assert.equal(result.next,undefined);assert.equal(result.replyTo,undefined);
    assert.deepEqual(result.questions,[{to:'codex',text:'怎么验证？'}]);assert.deepEqual(result.answers,['q']);assert.ok(result.reviewQuestions);assert.ok(result.formatWarnings!.length);
    assert.equal((result as any).extra,undefined);
  }
  assert.deepEqual(parseHandVote('意愿：{"want":3,"why":"有关键补充","action":"accept"}'),{want:3,why:'有关键补充'});
});

test('wrong core metadata, duplicate keys and multiple objects stay hard failures',()=>{
  for(const value of [{...reply,turn:'old-turn'},{...reply,revision:6},{...reply,version:2},JSON.stringify(reply).replace('"turn":"current-turn"','"turn":"old-turn","turn":"current-turn"'),JSON.stringify(reply)+JSON.stringify(reply)])
    assert.throws(()=>parse(value),error=>error instanceof DiscussionFormatError&&!error.retryable);
  for(const value of ['普通发言',JSON.stringify([reply]),{action:'speak',body:'缺少轮次'}])assert.throws(()=>parse(value),error=>error instanceof DiscussionFormatError&&error.retryable);
  assert.throws(()=>parse({...reply,action:'accept',body:'',questions:[{to:'user',text:'新的问题？'}]}));
});

test('every streaming prefix shows only decoded top-level body after matching metadata',()=>{
  const body='第一行\n引用 "双引号" 与 \\ 路径；鱼🐟，字尾。';
  const text='说明\n'+JSON.stringify({...reply,extra:{body:'内层秘密'},body})+'\n结束';
  for(let i=0;i<=text.length;i++){
    const visible=streamDiscussionBody(text.slice(0,i),reply.turn,reply.revision);
    assert.ok(body.startsWith(visible),`bad prefix ${i}: ${visible}`);assert.ok(!visible.includes('秘密'));
  }
  assert.equal(streamDiscussionBody(text,reply.turn,reply.revision),body);
  const escaped=JSON.stringify({...reply,body:'🐟你好\n'}).replace('🐟你好','\\ud83d\\udc1f\\u4f60\\u597d');
  for(let i=0;i<=escaped.length;i++)assert.ok('🐟你好\n'.startsWith(streamDiscussionBody(escaped.slice(0,i),reply.turn,reply.revision)),`split escape at ${i}`);
  assert.equal(streamDiscussionBody(escaped,reply.turn,reply.revision),'🐟你好\n');
});

test('unmatched, silent or ambiguous streamed control stays hidden and metadata may follow body',()=>{
  for(const text of [JSON.stringify({...reply,turn:'old'}),JSON.stringify({...reply,revision:6}),JSON.stringify({...reply,version:2}),JSON.stringify({...reply,action:'accept'}),JSON.stringify({...reply,action:'pass'}),JSON.stringify(reply)+JSON.stringify(reply),JSON.stringify(reply).replace('"turn":"current-turn"','"turn":"old","turn":"current-turn"')])assert.equal(streamDiscussionBody(text,reply.turn,reply.revision),'');
  const late=JSON.stringify({body:reply.body,version:1,turn:reply.turn,revision:reply.revision,action:'speak'});
  assert.equal(streamDiscussionBody(late.slice(0,late.indexOf('"action"')),reply.turn,reply.revision),'');
  assert.equal(streamDiscussionBody(late,reply.turn,reply.revision),reply.body);
  assert.equal(streamDiscussionBody(JSON.stringify(reply)), '');
});

test('a visible streaming body stays visible while trailing metadata arrives character by character',()=>{
  const text=JSON.stringify({...reply,replyTo:'message-id',next:'codex',questions:[]});
  const bodyEnd=text.indexOf(',"replyTo"');
  for(let length=bodyEnd;length<=text.length;length++){
    assert.equal(streamDiscussionBody(text.slice(0,length),reply.turn,reply.revision),reply.body,`body disappeared at ${length}: ${text.slice(0,length)}`);
  }
  assert.throws(()=>parse(text.replace('"next":"codex"','"revision":6')),'complete duplicate metadata still fails validation');
});
