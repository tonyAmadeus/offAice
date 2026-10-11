import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizePermissions, automaticWorkSettings } from '../src/shared/defaults';
import { claudeSessionPolicy } from '../src/backend/adapters/claude';
import { codexSessionPolicy, codexToolConfig, ensureWindowsSandbox, appServerArguments } from '../src/backend/adapters/codex';
import type { JsonLineRpc } from '../src/backend/adapters/common';
import { dshSessionPolicy } from '../src/backend/adapters/dsh';
import type { MemberPermissions } from '../src/shared/types';

const base: MemberPermissions = { commands: 'ask', fileScope: 'workspace', network: true };

test('automatic work defaults to write-capable sessions with full-access automatic commands', () => {
  assert.equal(DEFAULT_SETTINGS.defaultWriteMode,true);assert.equal(DEFAULT_SETTINGS.defaultAutoApprove,true);
  for (const member of ['codex', 'claude', 'dsh'] as const) assert.deepEqual(DEFAULT_SETTINGS.permissions[member],{commands:'auto',fileScope:'any',network:true});
  const custom={...DEFAULT_SETTINGS,paths:{claude:'global-claude'},models:{codex:'chosen'},networkMode:'proxy' as const,defaultWriteMode:false,defaultAutoApprove:false};
  const result=automaticWorkSettings(custom);
  assert.equal(result.paths.claude,'global-claude');assert.equal(result.models.codex,'chosen');assert.equal(result.networkMode,'proxy');
  assert.equal(result.defaultWriteMode,true);assert.equal(result.defaultAutoApprove,true);
  result.permissions.codex.commands='deny';assert.equal(DEFAULT_SETTINGS.permissions.codex.commands,'auto');
});

test('older saved settings and unknown values fall back to defaults', () => {
  assert.deepEqual(normalizePermissions(undefined), DEFAULT_SETTINGS.permissions);
  const result = normalizePermissions({ dsh: { commands: 'sudo', fileScope: 'any', network: 'yes' }, claude: { commands: 'deny' } });
  assert.deepEqual(result.dsh, { commands: 'auto', fileScope: 'any', network: true });
  assert.deepEqual(result.claude, { commands: 'deny', fileScope: 'any', network: true });
});

test('Codex maps permissions onto 0.160 approval and sandbox values', () => {
  assert.deepEqual(codexSessionPolicy({ ...base, commands: 'auto' }, true), { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: true }, declineCommands: false });
  assert.equal(codexSessionPolicy(base, true).approvalPolicy, 'untrusted');
  assert.equal(codexSessionPolicy({ ...base, commands: 'deny' }, true).declineCommands, true);
  assert.deepEqual(codexSessionPolicy({ ...base, fileScope: 'any' }, true).sandboxPolicy, { type: 'dangerFullAccess' });
  // Read-only sessions stay read-only whatever the file scope.
  assert.equal(codexSessionPolicy({ ...base, fileScope: 'any', network: false }, false).sandbox, 'read-only');
  assert.deepEqual(codexSessionPolicy({ ...base, network: false }, false).sandboxPolicy, { type: 'readOnly', networkAccess: false });
  const full={...base,commands:'auto' as const,fileScope:'any' as const};
  assert.equal(codexSessionPolicy(full,true,true).approvalPolicy,'never');
  assert.equal(codexSessionPolicy(full,true,true).sandbox,'danger-full-access');
  assert.equal(codexSessionPolicy(full,true,false).approvalPolicy,'on-request');
  assert.equal(codexSessionPolicy(full,false,true).sandbox,'read-only');
  assert.notEqual(codexSessionPolicy(full,false,true).approvalPolicy,'never');
  assert.notEqual(codexSessionPolicy({...full,commands:'ask'},true,true).approvalPolicy,'never');
  assert.notEqual(codexSessionPolicy({...full,fileScope:'workspace'},true,true).approvalPolicy,'never');
});

test('full access omits Windows sandbox selection while bounded runs keep it',()=>{
  assert.ok(!appServerArguments({},false).some(argument=>argument.includes('windows.sandbox')));
  assert.equal(appServerArguments({}).includes('windows.sandbox="unelevated"'),process.platform==='win32');
});

test('Claude exposes tools by permission and runs unrestricted only when the workspace boundary is lifted', () => {
  assert.deepEqual(claudeSessionPolicy(base, false).tools, ['Read', 'Glob', 'Grep', 'AskUserQuestion', 'WebFetch', 'WebSearch']);
  assert.deepEqual(claudeSessionPolicy({ ...base, network: false }, true).tools, ['Read', 'Glob', 'Grep', 'AskUserQuestion', 'Edit', 'Write']);
  assert.ok(!claudeSessionPolicy({ ...base, commands: 'deny' }, true).tools.includes('Bash'));
  assert.equal(claudeSessionPolicy(base, true).restricted, true);
  assert.equal(claudeSessionPolicy({ ...base, fileScope: 'any' }, true).restricted, false);
});

test('Codex disables native command tools for deny and also web/connector tools when offline', () => {
  assert.equal(codexToolConfig(base), undefined);
  const denied = codexToolConfig({...base,commands:'deny'})!;
  assert.equal(denied['features.shell_tool'],false);assert.equal(denied['features.unified_exec'],false);
  assert.equal(denied.web_search,undefined);
  const offline = codexToolConfig({...base,network:false})!;
  assert.equal(offline.web_search,'disabled');assert.equal(offline['features.apps'],false);assert.equal(offline['features.multi_agent'],false);
  assert.equal(codexSessionPolicy({...base,network:false},true).declineCommands,true);
});

test('Windows sandbox preparation is unelevated, preserves notifications and reports setup failure', async () => {
  for(const outcome of ['ready','success','failure','timeout'] as const){
    const calls:Array<{method:string;params:any}>=[];let checked=0,observed=0;
    const notify=(_method:string,_params:any)=>{observed++;};
    const rpc={onNotification:notify,async request(method:string,params:any){
      calls.push({method,params});
      if(method==='windowsSandbox/readiness')return {status:outcome==='ready'||checked++>0?'ready':'notConfigured'};
      if(outcome!=='timeout')queueMicrotask(()=>rpc.onNotification('windowsSandbox/setupCompleted',{mode:'unelevated',success:outcome==='success',error:'fixture failed'}));
      return {started:true};
    }};
    const result=await ensureWindowsSandbox(rpc as unknown as JsonLineRpc,'win32',30);
    assert.equal(result?.ready,outcome==='ready'||outcome==='success');assert.equal(rpc.onNotification,notify);
    assert.ok(calls.filter(x=>x.method.endsWith('setupStart')).every(x=>x.params.mode==='unelevated'));
    if(outcome==='failure')assert.match(result!.detail!,/fixture failed/);
    if(outcome==='timeout')assert.match(result!.detail!,/超时/);
    if(outcome==='success'||outcome==='failure')assert.equal(observed,1);
  }
  assert.equal(await ensureWindowsSandbox({} as JsonLineRpc,'linux'),undefined);
});

test('DSH sandbox mode follows session write mode and file scope', () => {
  assert.equal(dshSessionPolicy(base, false).sandboxMode, 'read-only');
  assert.equal(dshSessionPolicy(base, true).sandboxMode, 'workspace-write');
  assert.equal(dshSessionPolicy({ ...base, fileScope: 'any' }, true).sandboxMode, 'danger-full-access');
});
