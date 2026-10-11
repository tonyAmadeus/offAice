import '../scripts/test-bootstrap.mjs';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { DeepseekAdapter } from '../src/backend/adapters/deepseek';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';
import type { AdapterContext } from '../src/shared/types';

async function fixture(t: TestContext) {
  await mkdir('.test-cache', {recursive:true});
  const root=await mkdtemp(path.resolve('.test-cache/deepseek-'));
  t.after(async()=>{await rm(root,{recursive:true,force:true});});
  const events:any[]=[];const deliveries:string[]=[];
  const session={id:'session',projectId:'p',provider:'deepseek' as const,title:'test',createdAt:'',updatedAt:'',revision:1,writeMode:false};
  const ctx:AdapterContext={session,run:{id:'r',sessionId:'session',projectId:'p',provider:'deepseek',revision:1,status:'running',input:'test',createdAt:'',updatedAt:'',bootId:'b',delivery:'prepared'},cwd:root,env:{},settings:{...DEFAULT_SETTINGS,models:{deepseek:'actual-test-model'}},deepseekKey:'1234567890abcdef1234567890abcdef',emit:(kind,text,data)=>events.push({kind,text,data}),approve:async()=>({choice:'answer',answers:{text:'continue'}}),persistNativeSession:()=>{},markDelivery:s=>deliveries.push(s),registerProcess:()=>{}};
  return {root,ctx,events,deliveries};
}
function stream(packets:any[]) {
  return new Response(packets.map(p=>`data: ${JSON.stringify(p)}\n\n`).join('')+'data: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}});
}
const call=(id:string,name:string,args:any)=>({choices:[{delta:{tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]});

test('DeepSeek replaces system persona including removed memories without adding user-message copies',async t=>{
  const f=await fixture(t),inputs:any[]=[];
  const adapter=new DeepseekAdapter(()=>f.ctx.deepseekKey,f.root,(async(_url:any,options:any)=>{inputs.push(JSON.parse(options.body));return stream([{choices:[{delta:{content:'收到'}}]}]);}) as any);
  f.ctx.persona='过时记忆甲';await adapter.start(f.ctx,'第一轮');
  f.ctx.persona='当前记忆乙';await adapter.start(f.ctx,'第二轮');
  f.ctx.persona=undefined;await adapter.start(f.ctx,'第三轮');
  assert.match(inputs[0].messages[0].content,/过时记忆甲/);
  assert.match(inputs[1].messages[0].content,/当前记忆乙/);assert.doesNotMatch(inputs[1].messages[0].content,/过时记忆甲/);
  assert.match(inputs[2].messages[0].content,/未列出的旧记忆不再适用/);assert.doesNotMatch(inputs[2].messages[0].content,/当前记忆乙/);
  for(const input of inputs){assert.equal(input.messages.filter((m:any)=>m.role==='system').length,1);assert.ok(input.messages.filter((m:any)=>m.role==='user').every((m:any)=>!m.content.includes('记忆')));}
});

test('DeepSeek restores canonical room context only when native history is missing and refuses corrupt history',async t=>{
  const f=await fixture(t),inputs:any[]=[];let replays=0;
  f.ctx.freshInput=()=>{replays++;return '完整历史：决定和未完成事项保留。';};
  const adapter=new DeepseekAdapter(()=>f.ctx.deepseekKey,f.root,(async(_url:any,options:any)=>{inputs.push(JSON.parse(options.body));return stream([{choices:[{delta:{content:'收到'}}]}]);}) as any);
  await adapter.start(f.ctx,'增量');await adapter.start(f.ctx,'下一轮');assert.equal(replays,1);assert.equal(inputs[0].messages.at(-1).content,'完整历史：决定和未完成事项保留。');assert.equal(inputs[1].messages.at(-1).content,'下一轮');
  const file=path.join(f.root,'api-history/session.json');await writeFile(file,'{broken');await assert.rejects(adapter.start(f.ctx,'不得覆盖历史'),/历史无法读取/);assert.equal(inputs.length,2);assert.equal(await readFile(file,'utf8'),'{broken');
});

test('DeepSeek fallback is read-only, strips secrets from source results and persisted history', async t=>{
  const f=await fixture(t);await writeFile(path.join(f.root,'config.txt'),`secret=${f.ctx.deepseekKey}\nordinary setting`);
  let requests=0;
  const transport=async(_url:any,options:any)=>{
    requests++;
    if(requests===1)return stream([call('c1','read_file',{path:'config.txt'})]);
    assert.ok(!options.body.includes(f.ctx.deepseekKey!));
    return stream([{choices:[{delta:{content:'审查已结束'}}],usage:{total_tokens:42}}]);
  };
  const adapter=new DeepseekAdapter(()=>f.ctx.deepseekKey,f.root,transport as any);
  const result=await adapter.start(f.ctx,'检查文件');
  assert.equal(result.stopped,false);assert.equal(requests,2);assert.ok(f.events.some(e=>e.kind==='usage'));
  const history=await readFile(path.join(f.root,'api-history/session.json'),'utf8');
  assert.ok(!history.includes(f.ctx.deepseekKey!));assert.ok(history.includes('credential redacted'));
  assert.ok(f.deliveries.includes('confirmed'));
});

test('DeepSeek cannot escape workspace or execute commands; text output is confined to artifact directory',async t=>{
  const f=await fixture(t);let request=0;
  const transport=async()=>{
    request++;
    if(request===1)return stream([call('c1','read_file',{path:'../outside.txt'})]);
    if(request===2)return stream([call('c2','execute_command',{command:'del'})]);
    if(request===3)return stream([call('c3','save_artifact',{name:'review.md',content:'review result'})]);
    return stream([{choices:[{delta:{content:'完成文本审查'}}]}]);
  };
  await new DeepseekAdapter(()=>f.ctx.deepseekKey,f.root,transport as any).start(f.ctx,'review');
  assert.ok(f.events.some(e=>e.kind==='warning'&&e.text.includes('超出')));
  assert.ok(f.events.some(e=>e.kind==='warning'&&e.text.includes('未提供')));
  assert.equal(await readFile(path.join(f.root,'artifacts/session/review.md'),'utf8'),'review result');
});

test('stopping DeepSeek aborts request and issues no subsequent tool or request',async t=>{
  const f=await fixture(t);let signal:AbortSignal|undefined;let started!:()=>void;
  const ready=new Promise<void>(resolve=>started=resolve);
  const transport=async(_url:any,options:any)=>{signal=options.signal;started();return await new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));};
  const adapter=new DeepseekAdapter(()=>f.ctx.deepseekKey,f.root,transport as any);
  const execution=adapter.start(f.ctx,'long task');await ready;await adapter.stop();
  assert.equal(signal?.aborted,true);assert.equal((await execution).stopped,true);
  assert.ok(f.events.some(e=>e.text.includes('计费未知')));
});

test('API dispatcher follows explicit proxy mode and key never goes to a custom server',async t=>{
  const f=await fixture(t);f.ctx.settings={...f.ctx.settings,networkMode:'proxy'};let dispatcherName='';
  const transport=async(_url:any,options:any)=>{dispatcherName=options.dispatcher.constructor.name;return stream([{choices:[{delta:{content:'ok'}}]}]);};
  await new DeepseekAdapter(()=>f.ctx.deepseekKey,f.root,transport as any).start(f.ctx,'hello');assert.equal(dispatcherName,'ProxyAgent');
  f.ctx.settings.deepseekBaseUrl='https://attacker.example';let contacted=false;
  await assert.rejects(new DeepseekAdapter(()=>f.ctx.deepseekKey,f.root,(async()=>{contacted=true;}) as any).start(f.ctx,'hello'),/官方接口/);
  assert.equal(contacted,false);
});

test('DeepSeek per-task request budget stops new calls while keeping finished tool results',async t=>{
  const f=await fixture(t);f.ctx.settings.deepseekMaxRequests=1;let count=0;
  const transport=async()=>{count++;return stream([call('c1','save_artifact',{name:'partial.md',content:'already finished'})]);};
  const result=await new DeepseekAdapter(()=>f.ctx.deepseekKey,f.root,transport as any).start(f.ctx,'review');
  assert.equal(count,1);assert.equal(result.stopped,true);
  assert.equal(await readFile(path.join(f.root,'artifacts/session/partial.md'),'utf8'),'already finished');
  assert.ok(f.events.some(e=>e.kind==='warning'&&e.text.includes('预算')));
});

test('DeepSeek carries returned reasoning through tool followups and the next user turn',async t=>{
  const f=await fixture(t);let count=0;
  const transport=async(_url:any,options:any)=>{
    count++;
    if(count===1)return stream([{choices:[{delta:{reasoning_content:'需要先核对项目文件'}}]},call('c1','list_files',{})]);
    const body=JSON.parse(options.body);assert.equal(body.messages.find((m:any)=>m.role==='assistant').reasoning_content,'需要先核对项目文件');
    if(count===3)assert.ok(body.messages.some((m:any)=>m.reasoning_content==='文件已核对'));
    return stream([{choices:[{delta:{reasoning_content:'文件已核对',content:'这是审查结果'}}]}]);
  };
  const adapter=new DeepseekAdapter(()=>f.ctx.deepseekKey,f.root,transport as any);
  await adapter.start(f.ctx,'第一轮');await adapter.start(f.ctx,'第二轮');
  assert.equal(count,3);assert.ok(f.events.some(e=>e.kind==='reasoning'));
});

test('DeepSeek stops reading at explicit stream completion and rejects truncated streams',async t=>{
  const f=await fixture(t);let cancelled=false;
  const transport=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"完成"}}]}\n\ndata: [DONE]\n\n'));},cancel(){cancelled=true;}}));
  await new DeepseekAdapter(()=>f.ctx.deepseekKey,f.root,transport as any).start(f.ctx,'hello');assert.equal(cancelled,true);
  const truncated=async()=>new Response('data: {"choices":[{"delta":{"content":"部分输出"}}]}\n\n');
  await assert.rejects(new DeepseekAdapter(()=>f.ctx.deepseekKey,f.root,truncated as any).start(f.ctx,'next'),/结束标记/);
});
