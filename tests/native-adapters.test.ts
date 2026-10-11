import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AdapterContext, Approval, TimelineEvent } from '../src/shared/types';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';
import { CodexAdapter, getCodexLoginLaunch, requireCodexSubscription } from '../src/backend/adapters/codex';
import { adoptClaudeTranscript, ClaudeAdapter, claudeEnvironment, getClaudeLoginLaunch, projectInstructions, requireClaudeSubscription } from '../src/backend/adapters/claude';
import { collectCommand, resolveCli, subscriptionEnvironment } from '../src/backend/adapters/common';
import {disposeOwned} from '../src/backend/process-supervisor';
import {rm} from 'node:fs/promises';
import { newCompatibility, withCompatibility } from '../src/backend/compatibility';

const fixturesRoot = resolve('.test-cache'); mkdirSync(fixturesRoot, { recursive: true });
test('Codex environment removes host session, credential and network markers while keeping AIROOM homes and user settings',async ()=>{
  const forbidden=['CODEX_THREAD_ID','CODEX_SESSION_ID','CODEX_SANDBOX','CODEX_SANDBOX_NETWORK_DISABLED','CODEX_SANDBOX_LAUNCH_COUNT','CODEX_NETWORK_PROXY_ACTIVE','CODEX_NETWORK_PROXY_CREDENTIAL_BROKER_ACTIVE','CODEX_WINDOWS_SANDBOX_PROXY_PORTS','CODEX_ACCESS_TOKEN','CODEX_CONNECTORS_TOKEN','CODEX_INTERNAL_ORIGINATOR_OVERRIDE','CODEX_DAEMON_SHUTDOWN_FILE','CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN','CODEX_SQLITE_HOME','CODEX_APP_SERVER_LOGIN_ISSUER','CODEX_REFRESH_TOKEN_URL_OVERRIDE','OPENAI_FEDERATION_RULE_ID','OPENAI_IDENTITY_TOKEN_FILE'];
  const source:NodeJS.ProcessEnv={...Object.fromEntries(forbidden.map(key=>[key,'host-value'])),codex_sandbox:'case-insensitive',CODEX_HOME:'owned-home',AIROOM_CODEX_HOME:'owned-home',AIROOM_CODEX_STATE_DIR:'owned-state',CODEX_CA_CERTIFICATE:'user-ca',CODEX_MANAGED_BY_NPM:'1',HTTPS_PROXY:'user-proxy',NO_PROXY:'localhost'};
  const env=subscriptionEnvironment('codex',source);for(const key of [...forbidden,'codex_sandbox'])assert.equal(env[key],undefined,key);
  for(const key of ['CODEX_HOME','AIROOM_CODEX_HOME','AIROOM_CODEX_STATE_DIR','CODEX_CA_CERTIFICATE','CODEX_MANAGED_BY_NPM','HTTPS_PROXY','NO_PROXY'])assert.equal(env[key],source[key as keyof typeof source]);
  assert.equal(source.CODEX_SANDBOX,'host-value','the parent environment is untouched');
});
function fixture(source: string, provider: 'codex' | 'claude') {
  const directory = mkdtempSync(join(fixturesRoot, `native-${provider}-中文 空格-`));
  const path = join(directory, `${provider}.cjs`); writeFileSync(path, source, 'utf8');
  return { directory, path, async cleanup() { await disposeOwned(); if (!directory.startsWith(fixturesRoot + '\\') && !directory.startsWith(fixturesRoot + '/')) throw new Error('Unsafe fixture cleanup'); await rm(directory, { recursive: true, force: true, maxRetries:20, retryDelay:100 }); } };
}
function context(provider: 'codex' | 'claude', directory: string, path: string, env: NodeJS.ProcessEnv = {}): { context: AdapterContext; events: Array<{ kind: TimelineEvent['kind']; text: string; data: any }>; deliveries: string[]; requests: any[] } {
  const events: Array<{ kind: TimelineEvent['kind']; text: string; data: any }> = [], deliveries: string[] = [], requests: any[] = [];
  const settings = { ...DEFAULT_SETTINGS, paths: { [provider]: path }, models: {},permissions:{...DEFAULT_SETTINGS.permissions,[provider]:{commands:'ask' as const,fileScope:'workspace' as const,network:true}} };
  const instance: AdapterContext = {
    cwd: directory, settings, env: { ...process.env, AIROOM_APP_ROOT: process.cwd(), AIROOM_CODEX_HOME: join(directory,'owned-home'), AIROOM_CLAUDE_HOME: join(directory,'claude-home'), ...env },
    run: { id: 'run', sessionId: 'session', projectId: 'project', provider, revision: 1, status: 'running', input: '', createdAt: '', updatedAt: '', bootId: 'test', delivery: 'prepared' },
    session: { id: 'session', projectId: 'project', provider, title: '协议测试', revision: 1, writeMode: true, createdAt: '', updatedAt: '' },
    emit(kind, text, data) { events.push({ kind, text, data }); },
    async approve(request) { requests.push(request); return request.type === 'question' ? { choice: 'answer', answers: { q1: 'blue', '选哪种颜色？': 'blue' } } : { choice: provider === 'codex' ? 'accept' : 'allow' }; },
    persistNativeSession(id, nativeHome) { instance.session.nativeId = id; if (nativeHome) instance.session.nativeHome = nativeHome; },
    markDelivery(state, turn) { deliveries.push(state); instance.run.delivery = state; instance.run.nativeTurnId = turn; },
    registerProcess() {},
  };
  return { context: instance, events, deliveries, requests };
}
const codexFixture = String.raw`
const readline = require('node:readline'),fs=require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli fixture'); process.exit(0); }
const rl = readline.createInterface({input:process.stdin});
let threadId='thr_fixture', turnId='turn_fixture', testText='', turnResponseId, approvalId=700, questionId=701;
const send = message => process.stdout.write(JSON.stringify(message)+'\n');
const reply = (id,result) => send({id,result});
const event = (method,params) => send({method,params});
const done = (status,error) => { event('turn/completed',{threadId,turn:{id:turnId,status,error}}); };
const askQuestion=()=>{event('item/commandExecution/outputDelta',{threadId,turnId,itemId:'cmd1',delta:'test\n'});send({id:questionId,method:'item/tool/requestUserInput',params:{threadId,turnId,questions:[{id:'q1',question:'选哪种颜色？',header:'颜色',options:[{label:'blue',description:'蓝色'}]}]}});};
rl.on('line', line => {
 const m=JSON.parse(line);
 if(m.method)fs.appendFileSync(require('node:path').join(__dirname,'rpc.jsonl'),JSON.stringify({method:m.method,params:m.params})+'\n');
 if (m.method==='initialize') reply(m.id,{userAgent:'fixture'});
 if (m.method==='account/read'&&process.env.FAKE_CODEX_ROUTING_FAILURE) {
   process.stderr.write('\x1b[31mERROR\x1b[0m failed to refresh available models: request timed out\n');
   send({id:m.id,error:{code:-32603,message:'workspace routing discovery timed out'}});return;
 }
 if (m.method==='account/read') reply(m.id,{account:process.env.FAKE_CODEX_REQUIRE_FILE&&!fs.existsSync(require('node:path').join(process.env.CODEX_HOME,'auth.json'))||process.env.FAKE_CODEX_REFRESH_SIGNED_OUT&&m.params.refreshToken?null:process.env.FAKE_DEFAULT_AUTH_MISSING&&!process.env.CODEX_HOME?.includes('owned-home')?null:{type:process.env.FAKE_CODEX_ACCOUNT||'chatgpt',planType:'pro'}});
 if (m.method==='config/read') reply(m.id,{config:{model_provider:process.env.FAKE_CODEX_PROVIDER||'openai'}});
 if (m.method==='windowsSandbox/readiness') reply(m.id,{status:'ready'});
 if (m.method==='account/rateLimits/read') {
   const auth=require('node:path').join(process.env.CODEX_HOME,'auth.json');
   if(process.env.FAKE_CODEX_AUTH_CHANGE==='remove')fs.unlinkSync(auth);
   if(process.env.FAKE_CODEX_AUTH_CHANGE==='replace')fs.writeFileSync(auth,'replacement fixture account');
   if(process.env.FAKE_CODEX_REFRESH_SIGNED_OUT)send({id:m.id,error:{code:401,message:'Unauthorized'}});
   else reply(m.id,{rateLimits:{primary:{usedPercent:12}}});
 }
 // Enforce the real codex-cli 0.160.0 app-server schema (generate-json-schema), like the CLI does.
 const reject=(msg)=>send({id:m.id,error:{code:-32600,message:'Invalid request: '+msg}});
 const SANDBOX_POLICY_KEYS={readOnly:['type','networkAccess'],workspaceWrite:['type','writableRoots','networkAccess','excludeSlashTmp','excludeTmpdirEnvVar'],dangerFullAccess:['type'],externalSandbox:['type','networkAccess']};
 if ((m.method==='thread/start'||m.method==='thread/resume'||m.method==='turn/start')&&m.params.approvalPolicy!==undefined&&typeof m.params.approvalPolicy==='string'&&!['untrusted','on-request','never'].includes(m.params.approvalPolicy)) { reject('unknown variant '+m.params.approvalPolicy); return; }
 if ((m.method==='thread/start'||m.method==='thread/resume')&&m.params.sandbox!==undefined&&!['read-only','workspace-write','danger-full-access'].includes(m.params.sandbox)) { reject('unknown variant '+m.params.sandbox); return; }
 if (m.method==='turn/start'&&m.params.sandboxPolicy) { const keys=SANDBOX_POLICY_KEYS[m.params.sandboxPolicy.type]; const extra=keys?Object.keys(m.params.sandboxPolicy).filter(k=>!keys.includes(k)):['type']; if (extra.length) { reject('unknown field '+extra.join(',')); return; } }
 if (m.method==='thread/start'||m.method==='thread/resume') { if (m.params.modelProvider!=='openai') process.exit(9); threadId=m.params.threadId||threadId; reply(m.id,{thread:{id:threadId,modelProvider:'openai'}}); }
 if (m.method==='turn/start') {
   testText=m.params.input[0].text;turnResponseId=m.id;
   if (process.env.OPENAI_API_KEY) process.exit(8);
   if (testText==='disconnect') process.exit(17);
   if (testText==='rpc-quota') {send({id:m.id,error:{code:429,message:'429 quota exceeded'}});return;}
   reply(m.id,{turn:{id:turnId,status:'inProgress'}});
   event('turn/started',{threadId,turn:{id:turnId}});
   if (testText==='native-error'||testText==='quota-error') {done('failed',{message:testText==='quota-error'?'429 usage limit':'fixture failed'});return;}
   event('turn/plan/updated',{threadId,turnId,plan:[{step:'检查中文文件',status:'inProgress'}]});
   event('item/reasoning/summaryTextDelta',{threadId,turnId,itemId:'reason',delta:'公开摘要'});
   event('item/started',{threadId,turnId,item:{id:'cmd1',type:'commandExecution',command:'echo test',cwd:process.cwd(),status:'inProgress'}});
   if (testText==='wait') return;
   if (m.params.approvalPolicy==='never'&&m.params.sandboxPolicy?.type==='dangerFullAccess') {askQuestion();return;}
   send({id:approvalId,method:'item/commandExecution/requestApproval',params:{threadId,turnId,itemId:'cmd1',availableDecisions:['accept','decline','cancel']}});
 }
 if (m.id===approvalId&&!m.method) {
   if (m.result?.decision!=='accept') process.exit(6);
   askQuestion();
 }
 if (m.id===questionId&&!m.method) {
   if (m.result?.answers?.q1?.answers?.[0]!=='blue') process.exit(7);
   event('item/agentMessage/delta',{threadId,turnId,itemId:'reply',delta:'你好，世界'});
   event('item/completed',{threadId,turnId,item:{id:'reply',type:'agentMessage',text:'你好，世界',phase:'final_answer'}});
   event('thread/tokenUsage/updated',{threadId,tokenUsage:{total:{totalTokens:42}}});done('completed');
 }
 if (m.method==='turn/steer') { if (m.params.expectedTurnId!==turnId) process.exit(5); reply(m.id,{turnId});event('item/agentMessage/delta',{threadId,turnId,itemId:'steer',delta:m.params.input[0].text}); }
 if (m.method==='turn/interrupt') { reply(m.id,{});done('interrupted'); }
});
rl.once('close',()=>process.exit(0));
`;
const claudeFixture = String.raw`
const readline=require('node:readline'),fs=require('node:fs'),cp=require('node:child_process');
const argv=process.argv.slice(2);
if(argv.includes('--version')) {console.log('2.1.288 (Claude Code)');process.exit(0);}
if(argv.includes('auth')) {console.log(JSON.stringify({loggedIn:true,authMethod:process.env.FAKE_CLAUDE_AUTH||'claude.ai',apiProvider:'firstParty'}));process.exit(0);}
if(argv.includes('--bare')||argv.includes('--dangerously-skip-permissions')||process.env.ANTHROPIC_API_KEY||process.env.ANTHROPIC_AUTH_TOKEN)process.exit(9);
fs.writeFileSync('launch.json',JSON.stringify({argv,hasProxy:!!process.env.HTTPS_PROXY}));
const send=message=>process.stdout.write(JSON.stringify(message)+'\n');
let finalSent=false;
const input=readline.createInterface({input:process.stdin});
input.on('close',()=>process.exit(finalSent?0:23));
input.on('line',async line=>{
 const message=JSON.parse(line),text=message.message.content[0].text;
 fs.appendFileSync('input.jsonl',JSON.stringify(message)+'\n');
 send({type:'system',subtype:'init',session_id:'claude_fixture',model:'fixture',apiKeySource:'none'});
 // A queued notice from an earlier turn (e.g. a stopped background task) finishes before our input is dequeued.
 if(text==='stale-first'){send({type:'result',subtype:'success',session_id:'claude_fixture',result:'',is_error:false,num_turns:0,usage:{input_tokens:0,output_tokens:0}});await new Promise(resolve=>setTimeout(resolve,200));}
 send(message);
 if(text==='wait'){setInterval(()=>{},10000);return;}
 if(text==='disconnect'){process.exit(17);}
 if(text==='native-error'||text==='quota-error'){
  if(text==='quota-error')send({type:'rate_limit_event',rate_limit_info:{status:'rejected'}});
  finalSent=true;send({type:'result',subtype:'error_during_execution',is_error:true,errors:[text==='quota-error'?'429 usage limit':'fixture failed'],session_id:'claude_fixture'});return;
 }
 if(text==='permission'||text==='question'||text==='permission-auto'||text==='permission-offline') {
  await new Promise(resolve=>setTimeout(resolve,100));
  const config=JSON.parse(argv[argv.indexOf('--mcp-config')+1]).mcpServers.airoom;
  const helper=cp.spawn(config.command,config.args,{env:{...process.env,...config.env},stdio:['pipe','pipe','pipe']});
  helper.stderr.on('data',data=>process.stderr.write(data));
  const lines=readline.createInterface({input:helper.stdout});
  helper.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05'}})+'\n');
  await new Promise((resolve,reject)=>{lines.on('line',raw=>{const reply=JSON.parse(raw);if(reply.id===1)helper.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'permission_prompt',arguments:text==='question'?{tool_name:'AskUserQuestion',input:{questions:[{question:'选哪种颜色？',options:[{label:'blue'}]}]}}:{tool_name:'Bash',input:{command:'echo test'}}}})+'\n');
    if(reply.id===2){const result=JSON.parse(reply.result.content[0].text);if(result.behavior!==(text==='permission-offline'?'deny':'allow')||text==='question'&&result.updatedInput.answers['选哪种颜色？']!=='blue')reject(new Error('MCP approval contract failed'));else resolve();helper.stdin.end();}});helper.once('error',reject);});
 }
 send({type:'stream_event',session_id:'claude_fixture',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'公开思考'}}});
 const bytes=Buffer.from(JSON.stringify({type:'stream_event',session_id:'claude_fixture',event:{type:'content_block_delta',delta:{type:'text_delta',text:'你好，世界'}}})+'\n');
 for(let index=0;index<bytes.length;index+=2)process.stdout.write(bytes.subarray(index,index+2));
 send({type:'assistant',session_id:'claude_fixture',parent_tool_use_id:null,message:{content:[{type:'text',text:'你好，世界'}]}});
 finalSent=true;
 send({type:'result',subtype:'success',session_id:'claude_fixture',result:'你好，世界',is_error:false,usage:{input_tokens:42,output_tokens:5}});
 // Wait for the host to close stdin after the result; early EOF cancels approval above.
});
`;

test('native and Node CLI launches remove inherited Electron mode, including descendants', { timeout: 60000 }, async () => {
  const fake = fixture(`const cp=require('node:child_process'); console.log(JSON.stringify({ self:process.env.ELECTRON_RUN_AS_NODE??null, child:cp.execFileSync(process.execPath,['-p','process.env.ELECTRON_RUN_AS_NODE || "clean"'],{encoding:'utf8'}).trim() }));`, 'claude');
  try {
    for (const command of [{ command: process.execPath, prefix: [fake.path], path: fake.path }, { command: process.execPath, prefix: [], path: process.execPath }]) {
      const output = await collectCommand(command, command.prefix.length ? [] : [fake.path], { ...process.env, ELECTRON_RUN_AS_NODE: '1', AIROOM_NODE_EXE: process.execPath }, fake.directory);
      assert.equal(output.code, 0, output.stderr);
      assert.deepEqual(JSON.parse(output.stdout), { self: null, child: 'clean' });
    }
  } finally { await fake.cleanup(); }
});

test('subscription guards reject API / third-party billing and preserve network settings', async () => {
  assert.throws(() => requireCodexSubscription({ account: { type: 'apiKey' } }, { config: {} }), /API/);
  assert.throws(() => requireCodexSubscription({ account: { type: 'chatgpt' } }, { config: { model_provider: 'proxy' } }), /第三方/);
  assert.throws(() => requireCodexSubscription({ account: { type: 'chatgpt' } }, { config: { model_providers: { openai: { base_url: 'https://example.com' } } } }), /服务地址/);
  assert.throws(() => requireClaudeSubscription({ loggedIn: true, authMethod: 'api_key' }), /不改走 API/);
  assert.throws(() => requireClaudeSubscription({ loggedIn: true, authMethod: 'oauth_token' }), /订阅登录/);
  const env = subscriptionEnvironment('claude', { ANTHROPIC_API_KEY: 'test', anthropic_auth_token: 'test', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '1', HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost' });
  assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.anthropic_auth_token, undefined); assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined); assert.equal(env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN, undefined);
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7897'); assert.equal(env.NO_PROXY, 'localhost');
  // Started from inside the Claude desktop app, AIROOM must not pass on that host's session to its own members.
  const hosted = subscriptionEnvironment('claude', { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1', CLAUDE_CODE_OAUTH_SCOPES: 'user:inference', CLAUDE_CODE_ACCOUNT_UUID: 'a', CLAUDE_CODE_ORGANIZATION_UUID: 'o', CLAUDE_CODE_USER_EMAIL: 'e', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_HOST_SESSION_ID: 'h', CLAUDE_CODE_MESSAGING_SOCKET: 'm', CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_AGENT_SDK_VERSION: '1', CLAUDE_PID: '1', CLAUDE_CODE_GIT_BASH_PATH: 'C:\Git\bin\bash.exe', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000' });
  assert.deepEqual(Object.keys(hosted).filter(key => /^CLAUDE/.test(key)).sort(), ['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS']);
  assert.equal(subscriptionEnvironment('codex', { CLAUDECODE: '1' }).CLAUDECODE, '1');
});

test('Claude prefers the global install but retains explicitly configured paths', async () => {
  const fake = fixture('', 'claude');
  try {
    const appData = join(fake.directory, 'appdata');
    const globalPackage = join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code');
    mkdirSync(globalPackage, { recursive: true });
    writeFileSync(join(globalPackage, 'package.json'), JSON.stringify({ bin: { claude: 'cli.cjs' } }));
    writeFileSync(join(globalPackage, 'cli.cjs'), '');
    assert.equal(resolveCli('claude', { ...DEFAULT_SETTINGS, paths: {} }, { APPDATA: appData }, fake.directory).path, join(globalPackage, 'cli.cjs'));
    assert.equal(resolveCli('claude', { ...DEFAULT_SETTINGS, paths: { claude: fake.path } }, { APPDATA: appData }, fake.directory).path, fake.path);
  } finally { await fake.cleanup(); }
});

test('Claude explicitly loads bounded root project conventions without silently truncating', async () => {
  const fake = fixture('', 'claude');
  try {
    mkdirSync(join(fake.directory, '.claude'));
    writeFileSync(join(fake.directory, 'CLAUDE.md'), 'Use project-specific acceptance checks.');
    writeFileSync(join(fake.directory, '.claude', 'CLAUDE.md'), 'Keep user data intact.');
    const instructions = projectInstructions(fake.directory);
    assert.deepEqual(instructions.paths, ['CLAUDE.md', '.claude/CLAUDE.md']);
    assert.match(instructions.text, /Keep user data intact/);
    writeFileSync(join(fake.directory, 'CLAUDE.md'), 'x'.repeat(65537));
    assert.throws(() => projectInstructions(fake.directory), /64 KiB/);
  } finally { await fake.cleanup(); }
});
test('Codex receives actual progress, approvals, answers, final native IDs and quota through stdio', { timeout: 60000 }, async () => {
  const fake = fixture(codexFixture, 'codex');
  try {
    const testContext = context('codex', fake.directory, fake.path, { OPENAI_API_KEY: 'must-not-be-inherited' });
    const adapter = new CodexAdapter(),report=newCompatibility('codex','run',testContext.context.settings);
    const result = await withCompatibility(report,()=>adapter.start(testContext.context, 'run'));
    assert.equal(report.stages.at(-1)?.stage,'close');assert.equal(report.stages.at(-1)?.outcome,'passed');
    assert.equal(result.summary, '你好，世界'); assert.equal(testContext.context.session.nativeId, 'thr_fixture'); assert.equal(testContext.context.run.nativeTurnId, 'turn_fixture');
    assert.deepEqual(testContext.requests.map(request => request.type), ['approval', 'question']);
    assert.ok(testContext.events.some(event => event.kind === 'plan')); assert.ok(testContext.events.some(event => event.kind === 'reasoning' && event.text === '公开摘要')); assert.ok(testContext.events.some(event => event.kind === 'output' && event.text === 'test\n'));
    assert.equal(testContext.events.filter(event => event.kind === 'delta').map(event => event.text).join(''), '你好，世界'); assert.equal(testContext.events.filter(event => event.kind === 'message').length, 0);
    assert.equal(testContext.context.run.delivery, 'confirmed');
  } finally { await fake.cleanup(); }
});

test('Codex native routing failure records the account phase, sends no work and displays plain diagnostics', {timeout:30000},async()=>{
  const fake=fixture(codexFixture,'codex');
  try{
    const state=context('codex',fake.directory,fake.path,{FAKE_CODEX_ROUTING_FAILURE:'1'}),adapter=new CodexAdapter();
    const report=newCompatibility('codex','probe',state.context.settings);
    const info=await withCompatibility(report,()=>adapter.probe(state.context.settings,state.context.env));
    assert.equal(info.available,false);assert.equal(info.auth,'unknown');
    assert.match(info.detail,/workspace routing discovery timed out/);assert.match(info.detail,/failed to refresh available models/);
    assert.ok(!info.detail.includes('\u001b'),'terminal styling must not leak into the user-facing error');
    const account=report.stages.find(stage=>stage.method==='account/read');
    assert.equal(account?.outcome,'failed');assert.equal(account?.code,-32603);
    assert.equal(report.stages.find(stage=>stage.method==='initialize')?.outcome,'passed');
    const methods=readFileSync(join(fake.directory,'rpc.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line).method);
    assert.ok(!methods.includes('thread/start'));assert.ok(!methods.includes('turn/start'));
    assert.equal(methods.filter(method=>method==='account/read').length,1,'failed routing is not automatically retried');
  }finally{await fake.cleanup();}
});

test('Codex automatic full access skips Windows setup and operation approvals but keeps questions and resume', { timeout:60000 },async()=>{
  const fake=fixture(codexFixture,'codex');try{
    const state=context('codex',fake.directory,fake.path);
    state.context.settings={...state.context.settings,permissions:DEFAULT_SETTINGS.permissions};state.context.session.autoApprove=true;state.context.persona='你在 AIROOM 团队里的名字是「Gptia」。';
    for(const text of ['first','resume']){
      const result=await new CodexAdapter().start(state.context,text);assert.equal(result.summary,'你好，世界');assert.equal(result.unknown,undefined);
    }
    const calls=readFileSync(join(fake.directory,'rpc.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(!calls.some(call=>call.method.startsWith('windowsSandbox/')));
    const threads=calls.filter(call=>['thread/start','thread/resume'].includes(call.method));
    assert.deepEqual(threads.map(call=>call.method),['thread/start','thread/resume']);
    for(const call of threads){assert.equal(call.params.approvalPolicy,'never');assert.equal(call.params.sandbox,'danger-full-access');assert.match(call.params.developerInstructions,/rg pattern \./);assert.match(call.params.developerInstructions,/「Gptia」/,'the member card reaches start and resume');}
    for(const call of calls.filter(call=>call.method==='turn/start')){assert.equal(call.params.approvalPolicy,'never');assert.deepEqual(call.params.sandboxPolicy,{type:'dangerFullAccess'});}
    assert.deepEqual(state.requests.map(request=>request.type),['question','question']);
    const info=await new CodexAdapter().probe(state.context.settings,state.context.env);assert.equal(info.available,true);assert.equal(info.windowsSandbox,undefined);
    const after=readFileSync(join(fake.directory,'rpc.jsonl'),'utf8');assert.ok(!after.includes('windowsSandbox/'));
  }finally{await fake.cleanup();}
});

test('native new sessions replay room history while successful resume keeps incremental input', {timeout:60000},async()=>{
  for(const provider of ['codex','claude'] as const){
    const fake=fixture(provider==='codex'?codexFixture:claudeFixture,provider);
    try{
      const state=context(provider,fake.directory,fake.path);let replays=0;
      state.context.session.roomThreadId='fixture-room';
      state.context.freshInput=remember=>{assert.ok(remember);replays++;return 'full room history';};
      const run=()=>provider==='codex'?new CodexAdapter().start(state.context,'incremental room input'):new ClaudeAdapter().start(state.context,'incremental room input');
      await run();await run();assert.equal(replays,1);
      if(provider==='claude'){
        state.context.session.nativeId='missing-legacy-transcript';state.context.session.nativeHome='shared';await run();assert.equal(replays,2);
        const inputs=readFileSync(join(fake.directory,'input.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
        assert.deepEqual(inputs.map(m=>m.message.content[0].text),['full room history','incremental room input','full room history']);assert.equal(inputs[2].session_id,'');
      }else{
        const calls=readFileSync(join(fake.directory,'rpc.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
        assert.deepEqual(calls.filter(m=>m.method==='turn/start').map(m=>m.params.input[0].text),['full room history','incremental room input']);
      }
    }finally{await fake.cleanup();}
  }
});

test('Claude automatic full access still uses host approval and real questions without restricted mode', {timeout:60000},async()=>{
  const fake=fixture(claudeFixture,'claude');try{
    const state=context('claude',fake.directory,fake.path);state.context.settings={...state.context.settings,permissions:DEFAULT_SETTINGS.permissions};state.context.session.autoApprove=true;
    assert.equal((await new ClaudeAdapter().start(state.context,'permission-auto')).summary,'你好，世界');assert.equal(state.requests.length,0);
    const launch=JSON.parse(readFileSync(join(fake.directory,'launch.json'),'utf8'));assert.ok(!launch.argv.includes('--restricted'));assert.ok(launch.argv.includes('--permission-prompt-tool'));assert.ok(!launch.argv.includes('--dangerously-skip-permissions'));
    assert.equal((await new ClaudeAdapter().start(state.context,'question')).summary,'你好，世界');assert.deepEqual(state.requests.map(request=>request.type),['question']);
  }finally{await fake.cleanup();}
});

test('Codex and Claude return native failures instead of treating server rejection as transport loss',{timeout:60000},async()=>{
  for(const provider of ['codex','claude'] as const){
    const fake=fixture(provider==='codex'?codexFixture:claudeFixture,provider);
    try{
      for(const input of provider==='codex'?['native-error','quota-error','rpc-quota']:['native-error','quota-error']){
        const state=context(provider,fake.directory,fake.path);
        const result=await (provider==='codex'?new CodexAdapter():new ClaudeAdapter()).start(state.context,input);
        assert.equal(result.failure?.kind,input==='native-error'?'failed':'rate_limited');assert.equal(result.unknown,undefined);assert.equal(state.context.run.delivery,'confirmed');
      }
    }finally{await fake.cleanup();}
  }
});

test('Claude auto commands in workspace scope still reach approval and offline requests are denied',{timeout:60000},async()=>{
  const fake=fixture(claudeFixture,'claude');
  try{
    for(const network of [true,false]){
      const state=context('claude',fake.directory,fake.path);
      state.context.settings={...state.context.settings,permissions:{...state.context.settings.permissions,claude:{commands:'auto',fileScope:'workspace',network}}};
      const result=await new ClaudeAdapter().start(state.context,network?'permission-auto':'permission-offline');
      assert.equal(result.summary,'你好，世界');assert.equal(state.requests.length,network?1:0);
      if(network)assert.match(state.requests[0].detail,/没有命令沙箱/);
    }
  }finally{await fake.cleanup();}
});
test('Codex active steer targets the native turn; interrupt stops only that run', { timeout: 60000 }, async () => {
  const fake = fixture(codexFixture, 'codex');
  try {
    const testContext = context('codex', fake.directory, fake.path); const adapter = new CodexAdapter();
    const work = adapter.start(testContext.context, 'wait');
    await waitFor(() => testContext.events.some(event => event.kind === 'plan'));
    assert.equal(await adapter.steer('新方向'), true); await adapter.stop();
    const result = await work; assert.equal(result.stopped, true);
    assert.ok(testContext.events.some(event => event.text === '新方向')); assert.equal(await adapter.steer('过期方向'), false);
  } finally { await fake.cleanup(); }
});
test('Codex disconnect after input leaves delivery unknown and never retries', { timeout: 60000 }, async () => {
  const fake = fixture(codexFixture, 'codex');
  try {
    const testContext = context('codex', fake.directory, fake.path); const result = await new CodexAdapter().start(testContext.context, 'disconnect');
    assert.equal(result.unknown, true); assert.equal(testContext.context.run.delivery, 'unknown'); assert.equal(testContext.deliveries.filter(state => state === 'sent').length, 1);
  } finally { await fake.cleanup(); }
});
test('Codex blocks an API account before starting any thread', { timeout: 60000 }, async () => {
  const fake = fixture(codexFixture, 'codex');
  try {
    const testContext = context('codex', fake.directory, fake.path, { FAKE_CODEX_ACCOUNT: 'apiKey' });
    await assert.rejects(new CodexAdapter().start(testContext.context, 'run'), /API 认证/); assert.equal(testContext.deliveries.length, 0); assert.equal(testContext.context.session.nativeId, undefined);
  } finally { await fake.cleanup(); }
});
test('Codex login, probe and resumed work use only the same independent home', { timeout: 60000 }, async () => {
  const fake = fixture(codexFixture, 'codex');
  try {
    const ownHome = join(fake.directory, 'owned-home');
    const testContext = context('codex', fake.directory, fake.path, { FAKE_DEFAULT_AUTH_MISSING: '1', CODEX_HOME: '', AIROOM_CODEX_HOME: ownHome, AIROOM_CODEX_STATE_DIR: join(fake.directory, 'sqlite') });
    const result = await new CodexAdapter().start(testContext.context, 'run');
    assert.equal(result.summary, '你好，世界');
    assert.equal(testContext.context.session.nativeHome, 'airoom');
    assert.ok(testContext.events.some(event => event.data?.isolatedAuthDirectory === true));
    const login = getCodexLoginLaunch(testContext.context.settings, testContext.context.env);
    assert.equal(login.env.CODEX_HOME, ownHome); assert.equal(login.args.at(-1), 'login'); assert.equal(login.env.OPENAI_API_KEY, undefined);
    const info=await new CodexAdapter().probe(testContext.context.settings,testContext.context.env);
    assert.equal(info.authDirectory,ownHome);assert.equal(info.auth,'subscription');
    assert.doesNotMatch(info.detail,/验收/,'connection information must not request executor acceptance');
    // A usable shared login must never move work back into the desktop account home.
    delete testContext.context.env.FAKE_DEFAULT_AUTH_MISSING;
    testContext.events.splice(0);
    await new CodexAdapter().start(testContext.context, 'resume');
    assert.ok(testContext.events.some(event => event.data?.isolatedAuthDirectory === true));
  } finally { await fake.cleanup(); }
});

test('Codex refuses legacy shared sessions instead of creating or resuming a different thread',async()=>{
  const fake=fixture(codexFixture,'codex');try{
    const state=context('codex',fake.directory,fake.path);state.context.session.nativeId='legacy-thread';state.context.session.nativeHome='shared';
    await assert.rejects(new CodexAdapter().start(state.context,'resume'),/旧会话绑定/);assert.deepEqual(state.deliveries,[]);
  }finally{await fake.cleanup();}
});

test('packaged login discovers Codex under the application root despite an unrelated current directory',async ()=>{
  const fake=fixture(codexFixture,'codex');const oldCwd=process.cwd();try{
    const packageRoot=join(fake.directory,'resources','app','node_modules','@openai','codex');mkdirSync(packageRoot,{recursive:true});
    writeFileSync(join(packageRoot,'package.json'),JSON.stringify({bin:{codex:'entry.cjs'}}));writeFileSync(join(packageRoot,'entry.cjs'),codexFixture);
    process.chdir(fake.directory);
    const launch=getCodexLoginLaunch({...DEFAULT_SETTINGS,paths:{}},{...process.env,PATH:'',AIROOM_APP_ROOT:join(fake.directory,'resources','app'),AIROOM_CODEX_HOME:join(fake.directory,'owned-home')});
    assert.ok(launch.args.includes(join(packageRoot,'entry.cjs')));assert.equal(launch.env.CODEX_HOME,join(fake.directory,'owned-home'));
  }finally{process.chdir(oldCwd);await fake.cleanup();}
});
test('Claude uses non-bare subscription CLI, actual UTF8 deltas and MCP approvals', { timeout: 90000 }, async () => {
  const fake = fixture(claudeFixture, 'claude');
  try {
    writeFileSync(join(fake.directory, 'CLAUDE.md'), 'Project convention: preserve evidence before edits.');
    const testContext = context('claude', fake.directory, fake.path, { ANTHROPIC_API_KEY: 'must-not-be-inherited', ANTHROPIC_AUTH_TOKEN: 'must-not-be-inherited', HTTPS_PROXY: 'http://127.0.0.1:7897' });
    testContext.context.persona = '你在 AIROOM 团队里的名字是「Claudia」。称呼用户为「阿潘」。';
    const adapter = new ClaudeAdapter(); const result = await adapter.start(testContext.context, 'permission');
    assert.equal(result.summary, '你好，世界', JSON.stringify(testContext.events)); assert.equal(testContext.context.session.nativeId, 'claude_fixture'); assert.equal(testContext.requests[0].type, 'approval');
    assert.equal(testContext.events.filter(event => event.kind === 'delta').map(event => event.text).join(''), '你好，世界'); assert.ok(testContext.events.some(event => event.kind === 'reasoning' && event.text === '公开思考'));
    const launch = JSON.parse(readFileSync(join(fake.directory, 'launch.json'), 'utf8')); assert.ok(launch.argv.includes('--permission-prompt-tool')); assert.equal(launch.hasProxy, true);
    assert.match(launch.argv[launch.argv.indexOf('--append-system-prompt') + 1], /Project convention: preserve evidence before edits/);
    assert.equal(launch.argv[launch.argv.indexOf('--system-prompt-snapshot') + 1], 'off');
    assert.match(launch.argv[launch.argv.indexOf('--append-system-prompt') + 1], /称呼用户为「阿潘」/);
    assert.equal(await adapter.steer('next'), false); assert.equal(testContext.context.run.delivery, 'confirmed');
  } finally { await fake.cleanup(); }
});
test('Claude streaming preserves all text while announcing the native session only once',async ()=>{
  const fake=fixture('', 'claude');
  try{
    const state=context('claude',fake.directory,fake.path),adapter:any=new ClaudeAdapter();let persisted=0;
    const persist=state.context.persistNativeSession;
    state.context.persistNativeSession=(id,home)=>{persisted++;persist(id,home);};adapter.context=state.context;
    for(let i=0;i<500;i++)adapter.event({type:'stream_event',session_id:'same-native-session',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'雨'}}});
    assert.equal(persisted,1);assert.equal(state.context.session.nativeId,'same-native-session');
    assert.equal(state.events.filter(e=>e.kind==='delta').map(e=>e.text).join(''),'雨'.repeat(500));
    adapter.event({type:'stream_event',session_id:'foreign-session',event:{type:'content_block_delta',delta:{type:'text_delta',text:'wrong'}}});
    assert.equal(persisted,1);assert.ok(state.events.every(e=>e.text!=='wrong'));
  }finally{await fake.cleanup();}
});
test('Claude ignores a stale result that precedes its own input and runs background-free', { timeout: 90000 }, async () => {
  const fake = fixture(claudeFixture, 'claude');
  try {
    const testContext = context('claude', fake.directory, fake.path); const result = await new ClaudeAdapter().start(testContext.context, 'stale-first');
    assert.equal(result.summary, '你好，世界', JSON.stringify(testContext.events)); assert.equal(testContext.context.run.delivery, 'confirmed');
    assert.ok(testContext.events.some(event => event.kind === 'status' && /遗留的通知/.test(event.text)));
    assert.equal(subscriptionEnvironment('claude', {}).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
  } finally { await fake.cleanup(); }
});
test('Claude runs in its own config directory and adopts transcripts of older sessions', async () => {
  const root = mkdtempSync(join(fixturesRoot, 'claude-home-')), own = join(root, 'airoom'), shared = join(root, 'shared');
  try {
    assert.throws(() => claudeEnvironment({}), /独立 Claude 登录目录未配置/);
    const env = claudeEnvironment({ AIROOM_CLAUDE_HOME: own, CLAUDE_CONFIG_DIR: shared, ANTHROPIC_API_KEY: 'x' });
    assert.equal(env.CLAUDE_CONFIG_DIR, resolve(own)); assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(getClaudeLoginLaunch({ ...DEFAULT_SETTINGS, paths: { claude: process.execPath } }, { AIROOM_CLAUDE_HOME: own, CLAUDE_CONFIG_DIR: shared }).env.CLAUDE_CONFIG_DIR, resolve(own), 'login lands in the same directory');
    const id = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', folder = join(shared, 'projects', 'C--work');
    mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, `${id}.jsonl`), '{"type":"user"}\n');
    assert.equal(adoptClaudeTranscript('not-a-uuid', { CLAUDE_CONFIG_DIR: shared }, own), false);
    assert.equal(adoptClaudeTranscript(id, { CLAUDE_CONFIG_DIR: shared }, own), true);
    assert.equal(readFileSync(join(own, 'projects', 'C--work', `${id}.jsonl`), 'utf8'), '{"type":"user"}\n');
    assert.equal(adoptClaudeTranscript('11111111-2222-3333-4444-555555555555', { CLAUDE_CONFIG_DIR: shared }, own), false, 'unknown sessions start fresh');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('Claude native AskUserQuestion answers round-trip through the MCP permission host', { timeout: 90000 }, async () => {
  const fake = fixture(claudeFixture, 'claude');
  try {
    const testContext = context('claude', fake.directory, fake.path); const result = await new ClaudeAdapter().start(testContext.context, 'question');
    assert.equal(result.summary, '你好，世界', JSON.stringify(testContext.events)); assert.equal(testContext.requests[0].type, 'question');
  } finally { await fake.cleanup(); }
});
test('Claude final-result absence remains unknown despite replay acknowledgement', { timeout: 90000 }, async () => {
  const fake = fixture(claudeFixture, 'claude');
  try {
    const testContext = context('claude', fake.directory, fake.path); const result = await new ClaudeAdapter().start(testContext.context, 'disconnect');
    assert.equal(result.unknown, true); assert.equal(testContext.context.run.delivery, 'unknown'); assert.equal(testContext.deliveries.filter(state => state === 'sent').length, 1);
  } finally { await fake.cleanup(); }
});
test('Claude stops its owned process without inventing a final result', { timeout: 90000 }, async () => {
  const fake = fixture(claudeFixture, 'claude');
  try {
    const testContext = context('claude', fake.directory, fake.path); const adapter = new ClaudeAdapter(); const work = adapter.start(testContext.context, 'wait');
    await waitFor(() => testContext.events.some(event => event.kind === 'session')); await adapter.stop();
    const result = await work; assert.equal(result.stopped, true); assert.equal(result.summary, '');
  } finally { await fake.cleanup(); }
});
test('Claude blocks non-subscription auth before sending work', { timeout: 90000 }, async () => {
  const fake = fixture(claudeFixture, 'claude');
  try {
    const testContext = context('claude', fake.directory, fake.path, { FAKE_CLAUDE_AUTH: 'api_key' });
    await assert.rejects(new ClaudeAdapter().start(testContext.context, 'run'), /api_key/); assert.equal(testContext.deliveries.length, 0);
  } finally { await fake.cleanup(); }
});
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 30000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Timed out waiting for actual fixture progress'); await new Promise(resolvePromise => setTimeout(resolvePromise, 30)); }
}


test('Codex probe rechecks changed native authentication and never retains stale quota or connectivity',async()=>{
  for(const change of ['remove','replace','unauthorized']){
    const f=fixture(codexFixture,'codex');
    try{
      const h=context('codex',f.directory,f.path,{FAKE_CODEX_REQUIRE_FILE:'1',...(change==='unauthorized'?{FAKE_CODEX_REFRESH_SIGNED_OUT:'1'}:{FAKE_CODEX_AUTH_CHANGE:change})});
      mkdirSync(h.context.env.AIROOM_CODEX_HOME!,{recursive:true});writeFileSync(join(h.context.env.AIROOM_CODEX_HOME!,'auth.json'),'fake account only');
      const result=await new CodexAdapter().probe(h.context.settings,h.context.env);
      assert.equal(result.available,change==='replace');assert.equal(result.auth,change==='replace'?'subscription':'none');assert.equal(result.quota,undefined);
      if(change==='replace')assert.doesNotMatch(result.detail,/验收/);
      const calls=readFileSync(join(f.directory,'rpc.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
      assert.ok(calls.filter(c=>c.method==='account/read').length>=2);assert.ok(!calls.some(c=>c.method==='turn/start'));
      if(change==='replace')assert.equal(calls.filter(c=>c.method==='initialize').length,2,'a fresh process rechecks the changed auth file');
      if(change==='unauthorized')assert.ok(calls.some(c=>c.method==='account/read'&&c.params.refreshToken===true));
    }finally{await f.cleanup();}
  }
});


test('Claude missing legacy work history stops without sending a new prompt',async()=>{
  const fake=fixture(claudeFixture,'claude');
  try{
    const state=context('claude',fake.directory,fake.path);
    state.context.session.nativeId='missing-work-transcript';state.context.session.nativeHome='shared';
    await assert.rejects(new ClaudeAdapter().start(state.context,'must not send'),/原会话记录未找到/);
    assert.throws(()=>readFileSync(join(fake.directory,'input.jsonl')),{code:'ENOENT'});
  }finally{await fake.cleanup();}
});
