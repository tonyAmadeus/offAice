import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {bindFlowEvidence} from '../src/backend/project-flow-evidence';
import {assertReviewMeaning,commandEvidenceProblem} from '../src/shared/project-flow-review';
import type {Evidence} from '../src/shared/project-flow';
import type {TimelineEvent} from '../src/shared/types';
import {harness,plan,passing} from './helpers/project-flow-harness';

// Native commandExecution records and member evidence from the blocked TEST12 check.
const recorded=[
  {
    "kind": "command",
    "description": "读取整合副本的三个基础文件",
    "result": "成功读取全文，HTML 结构、成员数据及浏览器打开步骤均符合本轮标准。",
    "command": "Get-Content -Encoding UTF8 index.html, data/members.js, README.md",
    "exitCode": 0,
    "eventIds": []
  },
  {
    "kind": "command",
    "description": "执行成员数据并校验数组、姓名及非空介绍",
    "result": "输出 ok=true，成员依次为 Claudia、DeepSeek、Gptia，每项 intro 均为非空字符串。",
    "command": "node -e \"global.window={};require('./data/members.js');const m=window.MEMBERS;const ok=Array.isArray(m)&&m.length===3&&['Claudia','DeepSeek','Gptia'].every((n,i)=>m[i].name===n)&&m.every(x=>typeof x.intro==='string'&&x.intro.trim().length>0);console.log(JSON.stringify({ok,members:m}));if(!ok)process.exit(1);\"",
    "exitCode": 0,
    "eventIds": []
  }
];
const wrapped=[
  "\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command 'Get-Content -Encoding UTF8 index.html, data/members.js, README.md'",
  "\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command \"node -e \\\"global.window={};require('./data/members.js');const m=window.MEMBERS;const ok=Array.isArray(m)&&m.length===3&&['Claudia','DeepSeek','Gptia'].every((n,i)=>m[i].name===n)&&m.every(x=>typeof x.intro==='string'&&x.intro.trim().length>0);console.log(JSON.stringify({ok,members:m}));if(\"'!ok)process.exit(1);\"'"
];
const event=(command:string,patch:Record<string,unknown>={}):TimelineEvent=>({
  id:'native',runId:'run',sessionId:'session',provider:'codex',kind:'tool',fidelity:'native',
  text:'原生命令完成',at:new Date().toISOString(),
  data:{id:'invocation',type:'commandExecution',command,status:'completed',exitCode:0,...patch},
});
const claim=(command:string):Evidence=>({kind:'command',description:'检查文件',command,exitCode:0,result:'已核对',eventIds:[],source:'reported'});
const bind=(native:string,reported:string,patch:Record<string,unknown>={})=>bindFlowEvidence([claim(reported)],[event(native,patch)],['run'])[0];

test('T14a both real Codex command wrappers bind to the verbatim inner command and retain the raw record',()=>{
  for(const [index,e] of recorded.entries()){
    const native=event(wrapped[index]),bound=bindFlowEvidence([{...e,kind:'command',source:'reported'}],[native],['run'])[0];
    assert.equal(bound.source,'observed');assert.deepEqual(bound.eventIds,['native']);
    assert.equal(bound.command,e.command);assert.equal(bound.observedExitCode,0);assert.equal(bound.exitCodeSource,'observed');
    assert.equal((native.data as any).command,wrapped[index]);
  }
});

test('T14a recognizes known shell names, executable paths, harmless flags and serialized quote escapes',()=>{
  const command='Get-Content -Encoding UTF8 a.txt';
  const wrappers=[
    "powershell.exe -Command '"+command+"'",
    '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "'+command+'"',
    'pwsh -NoLogo -NonInteractive -Command '+command,
    'cmd /c '+command,
    '"C:\\Windows\\System32\\cmd.exe" /d /s /c "'+command+'"',
    "/bin/bash -lc '"+command+"'",
    'bash --login -c "'+command+'"',
    '/bin/sh -c "'+command+'"',
    'powershell -Command "bash -lc \\"'+command+'\\""',
  ];
  for(const native of wrappers){
    assert.equal(bind(native,command).source,'observed',native);
    assert.equal(bind(command,native).source,'observed','wrapped member command: '+native);
  }
  for(const [native,reported] of [
    ['bash -lc "printf \\"$value\\""', 'printf "$value"'],
    ["bash -lc 'printf '\\''one'\\'''", "printf 'one'"],
    ['pwsh -Command "node -e \\"if("'+"'!ok)process.exit(1);\"'",'node -e "if(!ok)process.exit(1);"'],
  ])assert.equal(bind(native,reported).source,'observed',native);
});

test('T14a never normalizes changed commands, internal whitespace, extra shell actions or unsupported wrappers',()=>{
  const command='Get-Content -Encoding UTF8 a.txt';
  for(const native of [
    "powershell -Command '"+command+"' ; Remove-Item a.txt",
    "powershell -Command '"+command+"' && echo done",
    "powershell -Command '"+command+"' extra",
    "powershell -Command '"+command,
    "powershell -Command '"+command.replace('a.txt','b.txt')+"'",
    "powershell -Command '"+command.replace(' UTF8 ','  UTF8 ')+"'",
    "powershell -Command ' "+command+" '",
    'powershell -File '+command,
    'powershell -EncodedCommand '+command,
    "powershell -Unknown -Command '"+command+"'",
    "python -c '"+command+"'",
    "echo powershell -Command '"+command+"'",
    "bash -lc '"+command+"' ignored-argument",
  ])assert.equal(bind(native,command).source,'reported',native);
});

test('T14a stripping a wrapper does not waive native completion, run identity or numeric failure checks',()=>{
  const command=recorded[0].command;
  const failed=bind(wrapped[0],command,{exitCode:2});
  assert.equal(failed.source,'observed');assert.equal(commandEvidenceProblem(failed),'exit-code-mismatch');
  assert.equal(bind(wrapped[0],command,{status:'failed',exitCode:undefined}).executionStatus,'failed');
  assert.equal(bind(wrapped[0],command,{status:'inProgress'}).source,'reported');
  const foreign={...event(wrapped[0]),runId:'other'};
  assert.equal(bindFlowEvidence([claim(command)],[foreign],['run'])[0].source,'reported');
  const derived={...event(wrapped[0]),fidelity:'derived' as const};
  assert.equal(bindFlowEvidence([claim(command)],[derived],['run'])[0].source,'reported');
});

const original=()=>({...passing(['A']),evidence:recorded.map(e=>({...e}))});
const inspection=()=>({...original(),evidence:recorded.map(e=>({
  kind:'inspection',description:'查看 '+e.description,result:e.result+'；工具返回数字退出码 '+e.exitCode+'。',eventIds:[],
}))});

test('T14b command-to-inspection correction can append an existing explanation after the complete original result',()=>{
  assert.doesNotThrow(()=>assertReviewMeaning(original(),inspection()));
  const corrected=inspection();corrected.evidence[0].result=recorded[0].result;
  assert.doesNotThrow(()=>assertReviewMeaning(original(),corrected));
});

test('T14b corrections still reject deleted or changed original text, a new result or an appended claim without migration',()=>{
  for(const result of ['全部检查通过。','补充：'+recorded[0].result,recorded[0].result.slice(0,-1)+'；退出码 0。']){
    const corrected=inspection();corrected.evidence[0].result=result;
    assert.throws(()=>assertReviewMeaning(original(),corrected),/验证结果声明/);
  }
  const sameKind=original();sameKind.evidence[0].result+='；补充说明';
  assert.throws(()=>assertReviewMeaning(original(),sameKind),/验证结果声明/);
  const extra=inspection();extra.evidence.push({...extra.evidence[0]});
  assert.throws(()=>assertReviewMeaning(original(),extra),/验证结果声明/);
  const wrongSlot=inspection();wrongSlot.evidence[0].result=recorded[1].result+'；补充说明';
  assert.throws(()=>assertReviewMeaning(original(),wrongSlot),/验证结果声明/);
  const empty=original();empty.evidence[0].result='';
  assert.throws(()=>assertReviewMeaning(empty,inspection()),/验证结果声明/);
});

test('T14b migration does not allow substituting a different command, exit code, verdict or verified state',()=>{
  for(const patch of [{command:'Remove-Item a.txt'},{exitCode:2}]){
    const corrected=inspection();Object.assign(corrected.evidence[0],patch);
    assert.throws(()=>assertReviewMeaning(original(),corrected),/验证结果声明/);
  }
  assert.throws(()=>assertReviewMeaning(original(),{...inspection(),verdict:'inconclusive'}),/复核结论/);
  assert.throws(()=>assertReviewMeaning(original(),{...inspection(),verificationComplete:false}),/验证完成状态/);
  const corrected=inspection();corrected.criteriaResults[0].verified=false;
  assert.throws(()=>assertReviewMeaning(original(),corrected),/核实状态/);
});

for(const kind of ['review','integration-check'])test('T14a Codex '+kind+' completes the actual wrapped commands without a format retry',async()=>{
  const p=plan();p.tasks=p.tasks.slice(0,1);p.tasks[0].reviewerMemberId='codex';
  const h=await harness({plan:p,handler:async c=>{
    if(c.kind!==kind)return;
    assert.equal(c.correction,false);assert.equal(c.ctx.session.provider,'codex');
    for(const [index,command] of wrapped.entries())
      c.ctx.emit('tool',command,{id:'command-'+index,type:'commandExecution',command,status:'completed',exitCode:0},'native');
    return {...passing(c.material.criteria??c.material.task.completionCriteria),evidence:recorded};
  }});
  try{
    await h.confirm();const s=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance'||s.tasks[0]?.status==='blocked'||s.rounds[0]?.status==='blocked');
    assert.equal(s.rounds[0].status,'awaiting_acceptance');assert.equal(h.calls.some(c=>c.correction),false);
    const evidence=kind==='review'?s.reviews[0].evidence:s.integrations[0].checkEvidence;
    for(const e of evidence){assert.equal(e.source,'observed');assert.equal(e.exitCodeSource,'observed');assert.equal(e.observedExitCode,0);}
    assert.equal(await h.original(),'old-a');
  }finally{await h.dispose();}
});

test('T14b integration correction migrates existing text once without running more commands or rewriting tasks',async()=>{
  const p=plan();p.tasks=p.tasks.slice(0,1);let before:any;
  const h=await harness({plan:p,handler:async c=>{
    if(c.kind!=='integration-check')return;
    if(c.correction){
      assert.match(c.ctx.run.input,/实际完成事件/);
      assert.match(c.ctx.run.input,/原 result（包括句末标点）必须完整保留为前缀/);
      return {...before,evidence:before.evidence.map((e:any)=>({
        kind:'inspection',description:'查看 '+e.description,result:e.result+'；工具返回数字退出码 '+e.exitCode+'。',eventIds:[],
      }))};
    }
    for(const [index,command] of wrapped.entries())
      c.ctx.emit('tool',command,{id:'command-'+index,type:'commandExecution',command,status:'completed',exitCode:0},'native');
    return before={...passing(c.material.criteria),evidence:recorded.map(e=>({...e,command:'概括检查：'+e.command}))};
  }});
  try{
    await h.confirm();const s=await h.wait(s=>s.rounds[0]?.status==='awaiting_acceptance'||s.rounds[0]?.status==='blocked');
    assert.equal(s.rounds[0].status,'awaiting_acceptance');assert.equal(h.calls.filter(c=>c.correction).length,1);
    assert.equal(h.calls.filter(c=>c.kind==='submission').length,1);assert.equal(s.rounds[0].integrationFixCount,0);
    for(const [index,e] of s.integrations[0].checkEvidence.entries()){
      assert.equal(e.kind,'inspection');assert.equal(e.source,'reported');assert.ok(e.result.startsWith(recorded[index].result));
    }
    const tools=h.engine.store.listEvents().filter(e=>e.kind==='tool'&&e.data&&typeof e.data==='object'&&(e.data as any).type==='commandExecution');
    assert.equal(tools.length,2);assert.equal(await h.original(),'old-a');
  }finally{await h.dispose();}
});

