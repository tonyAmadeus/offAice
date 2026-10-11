// A minimal Agent Client Protocol (v1) program for tests: stdio JSON-RPC, one line per message.
// FAKE_ACP_STATE: folder for the login marker and a log of every request it received.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const state = process.env.FAKE_ACP_STATE; mkdirSync(state, { recursive: true });
const signedIn = () => existsSync(join(state, 'signed-in'));
const log = entry => appendFileSync(join(state, 'log.jsonl'), JSON.stringify(entry) + '\n');
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } });
const waiting = new Map(); let outgoing = 0, sessions = 0, cancelled = null;
let selectedModel = 'fast', selectedEffort = 'low';
const configState = () => ({ configOptions: [
  { id: 'vendor-model', category: 'model', name: '模型', type: 'select', currentValue: selectedModel, options: [{ value: 'fast', name: 'Fast' }, { value: 'deep', name: 'Deep' }] },
  { id: 'vendor-thinking', category: 'thought_level', name: '思考', type: 'select', currentValue: selectedEffort, options: [{ group: 'levels', name: 'Levels', options: (selectedModel === 'deep' ? ['low', 'high'] : ['low']).map(value => ({ value, name: value })) }] },
] });
const ask = (method, params) => new Promise(resolve => { const id = `agent-${++outgoing}`; waiting.set(id, resolve); send({ id, method, params }); });

async function handle(message) {
  log({ method: message.method, params: message.params, ...(message.method === 'initialize' ? { token: process.env.ACP_TEST_TOKEN ?? null } : {}) });
  const { id, method, params } = message;
  if (method === 'initialize') return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: process.env.FAKE_ACP_HISTORY !== 'none', promptCapabilities:{image:process.env.FAKE_ACP_IMAGES==='1'} }, agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: '1.2.3' }, authMethods: [{ id: 'browser', name: '浏览器登录' }] } });
  if (method === 'authenticate') { writeFileSync(join(state, 'signed-in'), params.methodId); return send({ id, result: {} }); }
  if (method === 'session/new') {
    if (!signedIn()) return send({ id, error: { code: -32000, message: 'Authentication required' } });
    return send({ id, result: { sessionId: `s-${++sessions}`, ...(process.env.FAKE_ACP_CONFIG === '1' ? configState() : {}), models: { availableModels: [{ modelId: 'fast', name: 'Fast' }, { modelId: 'deep', name: 'Deep' }], currentModelId: selectedModel } } });
  }
  if (method === 'session/load') { if(process.env.FAKE_ACP_HISTORY==='fail')return send({id,error:{code:-32001,message:'Session no longer exists'}});update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD HISTORY' } }); return send({ id, result: process.env.FAKE_ACP_CONFIG==='1'?configState():null }); }
  if (method === 'session/set_model') return send({ id, result: {} });
  if (method === 'session/set_config_option') {
    if (params.configId === 'vendor-model') {
      if (params.value === process.env.FAKE_ACP_REJECT_MODEL) return send({ id, error: { code: -32602, message: 'Selected model rejected' } });
      selectedModel = params.value;
    } else if (params.configId === 'vendor-thinking') selectedEffort = params.value;
    else return send({ id, error: { code: -32602, message: 'Wrong configuration ID' } });
    return send({ id, result: configState() });
  }
  if (method === 'session/cancel') { cancelled?.(); return; }
  if (method === 'session/prompt') {
    const text = params.prompt.map(block => block.text).join('');
    const sessionId = params.sessionId;
    if (process.env.FAKE_ACP_FLOW === '1' && text.includes('"protocol":"airoom.project-flow"')) {
      const kind = text.match(/"kind":"([^"]+)"/)?.[1];
      const material = JSON.parse(text.split('\n任务材料：').at(-1));
      let payload;
      if (kind === 'plan') payload = {objective:'写测试文件',scope:'result.txt',deliverables:['result.txt'],acceptanceCriteria:['内容正确'],rounds:[{key:'r1',title:'测试轮',goal:'完成文件',requiresUserAcceptance:true}],tasks:[{key:'a',roundKey:'r1',title:'写文件',memberId:material.memberIds[1],goal:'写文件',completionCriteria:['内容正确'],dependencies:[],allowedPaths:['result.txt']}]};
      else if (kind === 'submission') {
        if (!existsSync(join(state,'release-flow'))) { update(sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'正在处理测试任务'}}); await new Promise(resolve=>{cancelled=resolve;}); return send({id,result:{stopReason:'cancelled'}}); }
        writeFileSync(join(params.cwd ?? process.cwd(),'result.txt'),'fixture result');
        payload={summary:'写好文件',completionResults:material.task.completionCriteria.map(criterion=>({criterion,verified:true,evidence:'检查写入的测试文件'})),evidence:[{kind:'inspection',description:'检查测试文件',result:'正确',eventIds:[],source:'reported'}]};
      } else if (kind === 'round-report') payload={summary:'测试汇报',completedTaskKeys:material.taskKeys,deliverables:['result.txt'],validationSummary:'已读取测试文件',remainingIssues:[],nextRoundSummary:'无',userDecisionNeeded:'请验收',meetingResponses:[]};
      else throw Error('Unexpected flow kind '+kind);
      update(sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({protocol:'airoom.project-flow',version:1,kind,payload})}}); return send({id,result:{stopReason:'end_turn'}});
    }
    if (text.includes('DISCONNECT_UNKNOWN')) { process.exitCode=7; process.stdin.destroy(); setTimeout(()=>process.exit(7),10); return; }
    if(process.env.FAKE_ACP_ROOM==='1'){
      const context=JSON.parse(text.split('\nAIROOM_CONTEXT\n').at(-1));
      const reply={version:1,turn:context.turn,revision:context.revision,action:'speak',body:`已读 ${context.messages.length} 条记录，当前修订 ${context.revision}`};
      update(sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(reply)}});return send({id,result:{stopReason:'end_turn'}});
    }
    if (text.includes('SLOW')) { update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '开始…' } }); await new Promise(resolve => { cancelled = resolve; }); return send({ id, result: { stopReason: 'cancelled' } }); }
    if (text.includes('NEED_PERMISSION')) {
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: '写入 a.txt', kind: 'edit', status: 'pending', rawInput: { path: 'a.txt' } });
      const options = process.env.FAKE_ACP_PERMISSIONS === 'all' ? [
        { optionId: 'yes', name: '本程序：仅本次允许', kind: 'allow_once' }, { optionId: 'always', name: '本程序：始终允许', kind: 'allow_always' },
        { optionId: 'no', name: '本程序：仅本次拒绝', kind: 'reject_once' }, { optionId: 'never', name: '本程序：始终拒绝', kind: 'reject_always' },
        { optionId: 'airoom:allow-all', name: '程序自定义选项', kind: 'vendor_choice' },
      ] : process.env.FAKE_ACP_PERMISSIONS === 'always' ? [{ optionId: 'always', name: '本程序：始终允许', kind: 'allow_always' }, { optionId: 'no', name: '拒绝', kind: 'reject_once' }] : [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }];
      const answer = await ask('session/request_permission', { sessionId, toolCall: { toolCallId: 't1' }, options });
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `permission: ${answer.outcome.optionId ?? answer.outcome.outcome}` } });
      return send({ id, result: { stopReason: 'end_turn' } });
    }
    update(sessionId, { sessionUpdate: 'plan', entries: [{ content: '打个招呼', status: 'completed', priority: 'medium' }] });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好，' } });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '我是 Fake。' } });
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: `unknown method ${method}` } });
}

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method) void handle(message);
  else if (waiting.has(message.id)) { waiting.get(message.id)(message.result); waiting.delete(message.id); }
});
