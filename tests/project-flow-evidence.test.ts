import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {bindFlowEvidence} from '../src/backend/project-flow-evidence';
import {assessReview,commandEvidenceProblem,commandExitCodeNotes} from '../src/shared/project-flow-review';
import {validateSubmission} from '../src/shared/project-flow-protocol';
import type {Evidence} from '../src/shared/project-flow';
import type {TimelineEvent} from '../src/shared/types';
import {passing} from './helpers/project-flow-harness';

const command='Select-String -Path a.txt -Pattern new-a';
const claim=(exitCode:number|undefined=0):Evidence=>({kind:'command',description:'核对内容',command,...(exitCode===undefined?{}:{exitCode}),result:'已核对',eventIds:[],source:'reported'});
const event=(id:string,data:unknown,patch:Partial<TimelineEvent>={}):TimelineEvent=>({id,runId:'run',sessionId:'session',provider:'dsh',at:new Date().toISOString(),kind:'tool',text:'原生工具事件',fidelity:'native',data,...patch});
const start=event('start',{toolCallId:'call',status:'in_progress',rawInput:{command}});
const end=(extra:Record<string,unknown>={},patch:Partial<TimelineEvent>={})=>event('end',{toolCallId:'call',status:'completed',...extra},patch);
const bind=(events:TimelineEvent[],e=claim(),runIds=['run'])=>bindFlowEvidence([e],events,runIds)[0];

test('DeepSeek completion with no numeric exit code observes execution but never invents zero',()=>{
  const e=bind([start,end()]);
  assert.equal(e.source,'observed');assert.deepEqual(e.eventIds,['end']);assert.equal(e.executionStatus,'completed');
  assert.equal(e.exitCode,0);assert.equal(e.exitCodeSource,'reported');assert.equal(e.observedExitCode,undefined);
  assert.equal(commandEvidenceProblem(e),undefined);assert.equal(assessReview({...passing(['A']),evidence:[e]},['A']).outcome,'pass');
  assert.match(commandExitCodeNotes([e])[0],/退出码未核实.*未提供退出码/);
  const omitted=bind([start,end()],{...claim(),exitCode:undefined});
  assert.equal(omitted.exitCode,undefined);assert.equal(omitted.observedExitCode,undefined);assert.deepEqual(commandExitCodeNotes([omitted]),[]);
});

test('Codex single completion records the actual numeric exit code and permits expected nonzero results',()=>{
  for(const code of [0,2]){
    const e=bind([event('codex',{id:'cmd',type:'commandExecution',command,status:'completed',exitCode:code},{provider:'codex'})],claim(code));
    assert.equal(e.source,'observed');assert.equal(e.observedExitCode,code);assert.equal(e.exitCodeSource,'observed');
    assert.equal(e.executionStatus,code?'failed':'completed');assert.equal(commandEvidenceProblem(e),undefined);
  }
});

test('a claimed zero contradicting a native nonzero code stays visible and cannot pass',()=>{
  const e=bind([start,end({exitCode:2})]);
  assert.equal(e.source,'observed');assert.equal(e.observedExitCode,2);assert.equal(e.exitCodeSource,'reported');
  assert.equal(commandEvidenceProblem(e),'exit-code-mismatch');
  const assessment=assessReview({...passing(['A']),evidence:[e]},['A']);
  assert.equal(assessment.outcome,'inconclusive');assert.match(assessment.reasons.join(),/退出码声明与原生执行结果矛盾/);
});

test('Claude tool_result observes completion without deriving an exit code from is_error',()=>{
  const use=event('use',{type:'tool_use',id:'claude-call',input:{command}},{provider:'claude'});
  for(const is_error of [false,true]){
    const result=event('result',{type:'tool_result',tool_use_id:'claude-call',is_error},{provider:'claude'}),e=bind([use,result]);
    assert.equal(e.source,'observed');assert.equal(e.observedExitCode,undefined);assert.equal(e.exitCodeSource,'reported');
    assert.equal(e.executionStatus,is_error?'failed':'completed');assert.equal(commandEvidenceProblem(e),is_error?'failed-execution':undefined);
  }
  assert.equal(commandEvidenceProblem(bind([start,end({status:'failed'})])),'failed-execution');
});

test('pending, orphaned, derived, foreign-run and differently named commands cannot become observed',()=>{
  const fixtures=[
    [start], [start,end({status:'in_progress',exitCode:0})], [end()],
    [start,end({}, {fidelity:'derived'})], [start,end({}, {runId:'foreign'})],
    [event('other',{toolCallId:'call',rawInput:{command:command+' extra'}}),end()],
    [start,end({toolCallId:'other'})],
  ];
  for(const events of fixtures){const e=bind(events);assert.equal(e.source,'reported');assert.deepEqual(e.eventIds,[]);assert.equal(commandEvidenceProblem(e),'missing-completion');}
  // Correction and original runs may use the same tool ID; they are not the same invocation.
  assert.equal(bind([start,end({}, {runId:'correction'})],claim(),['run','correction']).source,'reported');
  assert.equal(bind([start,end()],claim(),['correction','run']).source,'observed');
});

test('repeated commands select a real matching invocation rather than erase native contradictions',()=>{
  const failed=event('failed',{toolCallId:'failed-call',command,status:'completed',exitCode:1});
  const unknown=event('unknown',{toolCallId:'unknown-call',command,status:'completed'});
  const success=event('success',{id:'ok',command,status:'completed',exitCode:0});
  const e=bind([failed,success,unknown]);
  assert.deepEqual(e.eventIds,['success']);assert.equal(e.observedExitCode,0);assert.equal(e.exitCodeSource,'observed');
  const noMatching=bind([failed]);assert.equal(noMatching.observedExitCode,1);assert.equal(commandEvidenceProblem(noMatching),'exit-code-mismatch');
});

test('members cannot forge program-derived evidence provenance or attach arbitrary event IDs',()=>{
  for(const field of ['exitCodeSource','observedExitCode','executionStatus'])
    assert.throws(()=>validateSubmission({summary:'完成',completionResults:passing(['A']).criteriaResults,evidence:[{...claim(),[field]:field==='observedExitCode'?0:'observed'}]}),/不支持的字段/);
  const e=bind([], {...claim(),eventIds:['not-observed'],source:'observed'});
  assert.equal(e.source,'reported');assert.deepEqual(e.eventIds,[]);
});
