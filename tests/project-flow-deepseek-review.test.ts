import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {Engine} from '../src/backend/engine';
import {Store} from '../src/backend/store';
import type {FlowOperation,ProjectFlowSnapshot,Round,Task} from '../src/shared/project-flow';
import {parseReply} from '../src/shared/project-flow-protocol';
import {harness,plan,passing} from './helpers/project-flow-harness';

const envelope=(payload:unknown,kind='review')=>JSON.stringify({protocol:'airoom.project-flow',version:1,kind,payload});
test('T9 extracts the complete reply after persona text, fences and braces inside JSON strings',()=>{
  const payload={summary:'内容有 {花括号}、"引号" 和 C:\\目录',nested:[{value:'\\'}]},fence=String.fromCharCode(96).repeat(3);
  for(const [prefix,suffix] of [['（尾鳍啪嗒啪嗒）本鲸来复核……\n',''],['角色台词\n'+fence+'json\n','\n'+fence+'\n复核结束。'],['说明 {这段不是 JSON}\n','\n完成。']])
    assert.deepEqual(parseReply(prefix+envelope(payload)+suffix,'review'),payload);
});
test('T9 uses the last complete object and still rejects mismatched protocol, version or purpose',()=>{
  assert.deepEqual(parseReply('先前结果：'+envelope({value:'old'})+'\n最终结果：'+envelope({value:'new'}),'review'),{value:'new'});
  assert.deepEqual(parseReply('先前草稿：{"protocol":"airoom.project-flow","payload":,}\n最终结果：'+envelope({value:'new'}),'review'),{value:'new'});
  assert.deepEqual(parseReply('先前草稿：['+envelope({value:'old'})+']\n最终结果：'+envelope({value:'new'}),'review'),{value:'new'});
  for(const patch of [{protocol:'other'},{version:2},{kind:'submission'}]){
    const raw=JSON.stringify({protocol:'airoom.project-flow',version:1,kind:'review',payload:{},...patch});
    assert.throws(()=>parseReply('本鲸来了\n'+raw,'review'),/协议名称、版本或用途/);
    assert.throws(()=>parseReply(envelope({value:'old'})+'\n'+raw,'review'),/协议名称、版本或用途/);
  }
});
test('T9 cannot extract a nested envelope from an array or silently use an older result after a truncated final reply',()=>{
  assert.throws(()=>parseReply('本鲸来了\n['+envelope({})+']','review'),/JSON|对象/);
  assert.throws(()=>parseReply(envelope({value:'old'})+'\n最新：{"protocol":"airoom.project-flow","payload":','review'),/JSON/);
  assert.throws(()=>parseReply('本鲸来了\n'+envelope({}).slice(0,-1),'review'),/JSON/);
  assert.throws(()=>parseReply('a'.repeat(128*1024)+envelope({}),'review'),/128 KiB/);
  assert.throws(()=>parseReply(envelope({value:'old'})+'\n最新：{"protocol":"airoom.project-flow","version":1,"kind":"review","payload":,}','review'),/语法错误/);
  assert.throws(()=>parseReply('本鲸来了\n'+JSON.stringify({protocol:'airoom.project-flow',version:1,kind:'review',payload:{},extra:true}),'review'),/不支持的字段/);
});

test('T8 DeepSeek command completions without exit codes remain observed with explicitly unverified member exit codes',async()=>{
  const p=plan();p.tasks=p.tasks.slice(0,1);p.tasks[0].reviewerMemberId='dsh';let last:unknown;
  const commands=["Select-String -Path a.txt -Pattern 'new-a'","Select-String -Path a.txt -Pattern 'a'"];
  const h=await harness({plan:p,handler:async c=>{
    if(c.kind!=='review')return;
    if(c.correction)return last;
    assert.equal(c.ctx.session.provider,'dsh');
    c.ctx.emit('delta','（尾鳍啪嗒啪嗒）本鲸来复核……\n',undefined,'native');
    for(const [index,command] of commands.entries()){
      c.ctx.emit('tool',command,{sessionUpdate:'tool_call',toolCallId:'select-'+index,status:'in_progress',rawInput:{command}},'native');
      c.ctx.emit('tool','命令完成',{sessionUpdate:'tool_call_update',toolCallId:'select-'+index,status:'completed',content:[{type:'content',content:{type:'text',text:'a.txt:1:new-a'}}]},'native');
    }
    return last={...passing(c.material.task.completionCriteria),evidence:commands.map(command=>({kind:'command',description:'核对文件内容',command,exitCode:0,result:'已查到对应内容',eventIds:[]}))};
  }});
  try{
    await h.confirm();const s=await h.wait(s=>s.reviews.some(r=>r.status==='passed'||r.status==='blocked'));
    assert.equal(s.reviews[0].status,'passed');assert.equal(h.calls.some(c=>c.correction),false);
    for(const e of s.reviews[0].evidence){
      assert.equal(e.source,'observed');assert.equal(e.exitCode,0);assert.equal((e as any).exitCodeSource,'reported');
      assert.equal((e as any).observedExitCode,undefined);assert.equal((e as any).executionStatus,'completed');assert.ok(e.eventIds.length);
    }
    const ready=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');
    assert.match(ready.rounds[0].report!.systemNotes!.map(n=>n.text).join(),/退出码未核实/);assert.match(ready.rounds[0].report!.systemNotes!.map(n=>n.text).join(),/原生记录确认命令已完成，但未提供退出码/);
    assert.equal(await h.original(),'old-a');
  }finally{await h.dispose();}
});

test('T9 persona prefixes through the full flow do not consume any format correction and remain in the original event log',async()=>{
  const p=plan();p.tasks=p.tasks.slice(0,1);
  const h=await harness({plan:p,handler:async c=>{if(!c.correction)c.ctx.emit('delta','（尾鳍啪嗒啪嗒）本鲸来处理这一轮……\n',undefined,'native');}});
  try{
    await h.confirm();await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');
    assert.equal(h.calls.some(c=>c.correction),false);assert.equal(h.calls.filter(c=>c.kind==='review').length,1);
    assert.ok(h.engine.store.listEvents().some(e=>e.kind==='delta'&&e.text.includes('尾鳍啪嗒啪嗒')));assert.equal(await h.original(),'old-a');
  }finally{await h.dispose();}
});

for(const record of [{exitCode:2,status:'completed',message:/退出码不一致.*成员填写 0，实际记录为 2/},{status:'failed',message:/原生记录显示执行失败/}])
  test('T8 native execution contradiction is diagnosed accurately and still blocks: '+record.status+' '+record.exitCode,async()=>{
    const p=plan();p.tasks=p.tasks.slice(0,1);p.tasks[0].reviewerMemberId='dsh';let last:unknown;
    const command='Select-String -Path a.txt -Pattern new-a',h=await harness({plan:p,handler:async c=>{
      if(c.kind!=='review')return;if(c.correction){assert.match(c.ctx.run.input,record.message);return last;}
      c.ctx.emit('tool',command,{toolCallId:'call',rawInput:{command},status:'in_progress'},'native');
      c.ctx.emit('tool','完成',{toolCallId:'call',status:record.status,...(record.exitCode===undefined?{}:{exitCode:record.exitCode})},'native');
      return last={...passing(c.material.task.completionCriteria),evidence:[{kind:'command',description:'实际检查',command,exitCode:0,result:'声称已验证',eventIds:[]}]};
    }});
    try{await h.confirm();const s=await h.wait(s=>s.tasks[0]?.status==='blocked');assert.match(s.tasks[0].blockedReason!,record.message);
      assert.equal(h.calls.filter(c=>c.correction).length,1);assert.equal(s.rounds[0].status,'executing');assert.equal(await h.original(),'old-a');
    }finally{await h.dispose();}
  });

test('T9 only wrapping text is normalized; a genuinely invalid field still gets one precise correction',async()=>{
  const p=plan();p.tasks=p.tasks.slice(0,1);let original:any;
  const h=await harness({plan:p,handler:async c=>{
    if(c.kind!=='review')return;c.ctx.emit('delta','（尾鳍啪嗒啪嗒）本鲸来复核……\n',undefined,'native');
    if(c.correction){assert.match(c.ctx.run.input,/只能是 command、quote、inspection 或 source/);return {...original,evidence:[{...original.evidence[0],kind:'inspection'}]};}
    return original={...passing(c.material.task.completionCriteria),evidence:[{kind:'tool',description:'读取文件',result:'内容已核对',eventIds:[]}]};
  }});
  try{await h.confirm();const s=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');assert.equal(s.reviews[0].status,'passed');
    assert.equal(h.calls.filter(c=>c.correction).length,1);assert.equal(await h.original(),'old-a');
  }finally{await h.dispose();}
});

test('restart reuses the completed DeepSeek prefixed review and its native completion without another model call',async()=>{
  const p=plan();p.tasks=p.tasks.slice(0,1);p.tasks[0].reviewerMemberId='dsh';
  const h=await harness({plan:p,handler:async c=>{
    if(c.kind!=='review')return;
    c.ctx.emit('delta','（尾鳍啪嗒啪嗒）本鲸来复核……\n',undefined,'native');
    const command='Select-String -Path a.txt -Pattern new-a';
    c.ctx.emit('tool',command,{toolCallId:'recover-call',rawInput:{command},status:'in_progress'},'native');
    c.ctx.emit('tool','查到内容',{toolCallId:'recover-call',status:'completed'},'native');
    return {...passing(c.material.task.completionCriteria),evidence:[{kind:'command',description:'检查文件',command,exitCode:0,result:'查到内容',eventIds:[]}]};
  }});let restarted:Engine|undefined;
  try{
    await h.confirm();const ready=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance');await h.engine.close();
    const data=new Store(path.join(h.root,'data')),task=data.get<Task>('flow_tasks',ready.tasks[0].id)!,round=data.get<Round>('flow_rounds',ready.rounds[0].id)!;
    const op=data.list<FlowOperation>('flow_operations').find(o=>o.kind==='review'&&o.targetId===task.id)!;
    data.put('flow_operations',op.id,{...op,state:'running'});data.put('flow_tasks',task.id,{...task,status:'awaiting_review'});
    data.put('flow_rounds',round.id,{...round,status:'executing',report:undefined,integrationId:undefined});data.close();
    restarted=new Engine(path.join(h.root,'data'),()=>{},()=>{},h.adapterFactory);await restarted.probe();
    let s=await restarted.invoke('projectFlow.get',{projectId:h.project.id}) as ProjectFlowSnapshot;
    assert.equal(restarted.store.get<FlowOperation>('flow_operations',op.id)!.recovery,'completed');
    await restarted.invoke('projectFlow.resume',{requestId:'resume-prefixed-review',flowId:s.flow!.id,expectedRevision:s.flow!.revision});
    const deadline=Date.now()+20000;
    while(s.rounds[0]?.status!=='awaiting_acceptance'){
      assert.ok(Date.now()<deadline,'recovered review should reach acceptance');await new Promise(resolve=>setTimeout(resolve,25));
      s=await restarted.invoke('projectFlow.get',{projectId:h.project.id}) as ProjectFlowSnapshot;
    }
    assert.equal(h.calls.filter(c=>c.kind==='review').length,1);assert.equal(h.calls.some(c=>c.correction),false);
    assert.match(s.rounds[0].report!.systemNotes!.map(n=>n.text).join(),/退出码未核实/);assert.equal(await h.original(),'old-a');
  }finally{await restarted?.close();await h.dispose();}
});
