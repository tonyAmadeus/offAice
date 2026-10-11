import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { accountBalanceReport,balanceAmount,balanceFresh,quotaReport,mergeQuota,quotaFresh,quotaPreference,quotaAt100,QUOTA_STALE_MS } from '../src/shared/quota';
const at=new Date().toISOString(),clock=Date.parse(at),reset=Math.floor(clock/1000)+3600;
test('author skip needs a fresh 100% window for the actual model; unknown models, native rejection and zero wallets are not proof',()=>{
  const scoped=quotaReport('claude',{rateLimit:{unifiedWindows:{seven_day_sonnet:{utilization:1,resetsAt:reset},seven_day_opus:{utilization:0.1,resetsAt:reset}}}},at,'event')!;
  assert.equal(quotaAt100(scoped,clock,'sonnet'),true);assert.equal(quotaAt100(scoped,clock,'opus'),false);assert.equal(quotaAt100(scoped,clock),false);assert.equal(quotaAt100(scoped,clock+QUOTA_STALE_MS+1,'sonnet'),false);
  const global=quotaReport('claude',{rateLimit:{unifiedWindows:{five_hour:{utilization:1,resetsAt:reset}}}},at,'event')!;assert.equal(quotaAt100(global,clock),true);
  const rejected=quotaReport('claude',{rateLimit:{status:'rejected',rateLimitType:'seven_day_opus'}},at,'event')!;assert.equal(quotaAt100(rejected,clock,'opus'),false);
  assert.equal(quotaAt100(quotaReport('dsh',{accountBalance:{status:'ready',wallets:[{currency:'CNY',balance:'0'}],bonusWallets:[]}},at,'probe'),clock),false);
});
test('native Claude /usage percentages are 0–100 and session tokens never substitute for quota',()=>{
  const payload={accountUsage:{session:{total_cost_usd:999},rate_limits:{limits:[{kind:'session',percent:1,resets_at:new Date(reset*1000).toISOString()},{kind:'weekly_all',percent:100},{kind:'weekly_scoped',percent:99,scope:{model:{display_name:'Claude Opus'}}},{kind:'future',percent:100},{kind:'session',percent:-1}]}}};
  const quota=quotaReport('claude',payload,at,'probe')!;assert.deepEqual(quota.windows.map(row=>row.usedPercent),[1,100,99]);assert.equal(quotaPreference(quota,clock,'sonnet'),0);
  assert.equal(quota.windows[0].resetsAt,reset);assert.equal(quotaReport('claude',{accountUsage:{session:{total_cost_usd:999}}},at,'probe')!.queryStatus,'unavailable');
});
test('Codex reads both native windows and prefers per-limit reports without inventing missing values',()=>{
  const q=quotaReport('codex',{rateLimits:{primary:{usedPercent:99}},rateLimitsByLimitId:{codex:{primary:{usedPercent:24,windowDurationMins:300,resetsAt:reset},secondary:{usedPercent:5,windowDurationMins:10080,resetsAt:reset}}}},at,'probe')!;
  assert.deepEqual(q.windows.map(w=>[w.label,w.usedPercent]),[['5 小时',24],['每周',5]]);
  const unknown=quotaReport('codex',{rateLimits:{primary:{windowDurationMins:300},secondary:{usedPercent:-1,windowDurationMins:10080}}},at,'event')!;
  assert.ok(unknown.windows.every(w=>w.usedPercent===undefined));assert.equal(quotaPreference(unknown,clock),1);
  assert.equal(quotaReport('dsh',{usage:{input_tokens:12000}},at,'event'),undefined);
  assert.equal(quotaReport('codex',{usage:{input_tokens:12000}},at,'event'),undefined);
});
test('Claude normal usage includes 5-hour and weekly utilization, with warning/rejection states kept truthful',()=>{
  const q=quotaReport('claude',{rateLimit:{status:'allowed',rateLimitType:'five_hour',unifiedWindows:{five_hour:{utilization:.21,resetsAt:reset},seven_day:{utilization:.03,resetsAt:reset}}}},at,'event')!;
  assert.deepEqual(q.windows.map(w=>w.usedPercent),[21,3]);assert.equal(quotaPreference(q,clock),1);
  const warning=quotaReport('claude',{rate_limit_info:{status:'allowed_warning',rateLimitType:'five_hour'}},at,'event')!;
  assert.equal(warning.windows[0].usedPercent,undefined);assert.equal(quotaPreference(warning,clock),.35);
  const rejected=quotaReport('claude',{rateLimit:{status:'rejected',rateLimitType:'five_hour'}},at,'event')!;
  assert.equal(rejected.windows[0].usedPercent,undefined);assert.equal(quotaPreference(rejected,clock),0);
  const allowed=quotaReport('claude',{rateLimit:{status:'allowed',rateLimitType:'five_hour'}},new Date(clock+1).toISOString(),'event')!;
  assert.equal(quotaPreference(mergeQuota(rejected,allowed),clock+1),1);
});
test('stale data and a reset window stop influencing discussion; model-specific limits affect their own models',()=>{
  const q=quotaReport('claude',{rateLimit:{unifiedWindows:{five_hour:{utilization:.97,resetsAt:reset},seven_day_opus:{utilization:1,resetsAt:reset}}}},at,'event')!;
  assert.equal(quotaPreference(q,clock,'sonnet'),.1);assert.equal(quotaPreference(q,clock,'opus'),0);
  assert.equal(quotaPreference(q,clock+QUOTA_STALE_MS+1),1);assert.equal(quotaPreference(q,reset*1000),1);
  assert.equal(quotaFresh({...q.windows[0],checkedAt:'bad'},clock),false);assert.equal(quotaFresh({...q.windows[0],checkedAt:new Date(clock+100).toISOString()},clock),false);
});
test('per-window timestamps reject late samples and token-only updates cannot erase quota state',()=>{
  const previous=quotaReport('codex',{rateLimits:{primary:{usedPercent:90,windowDurationMins:300},secondary:{usedPercent:20,windowDurationMins:10080}}},at,'event')!;
  const old=quotaReport('codex',{rateLimits:{primary:{usedPercent:10,windowDurationMins:300}}},new Date(clock-100).toISOString(),'probe')!;
  const merged=mergeQuota(previous,old);assert.equal(merged.windows[0].usedPercent,90);assert.equal(merged.windows[1].usedPercent,20);assert.equal(merged.checkedAt,at);assert.equal(merged.source,'event');
});
const balancePayload=(normal='0E-16',bonus='0')=>({accountBalance:{status:'ready',wallets:[{currency:'CNY',balance:normal}],bonusWallets:[{currency:'CNY',balance:bonus}]}});
test('DSH preserves exact recharge and gift balances and currencies, without subscription windows or private fields',()=>{
  const q=quotaReport('dsh',{accountBalance:{status:'ready',wallets:[{currency:'CNY',balance:'123.1234567890123456789',token:'private'}],bonusWallets:[{currency:'USD',balance:'.5e-9'}],contact:'private'}},at,'probe')!;
  assert.deepEqual(q.windows,[]);assert.deepEqual(q.balance,{status:'ready',wallets:[{currency:'CNY',balance:'123.1234567890123456789'}],bonusWallets:[{currency:'USD',balance:'.5e-9'}],checkedAt:at});
  assert.equal(balanceAmount('0E-16'),'0');assert.equal(balanceAmount('+123.450000000000000000'),'123.45');assert.equal(balanceAmount('.5e-999'),'.5e-999');
});
test('automatic speech uses fresh balances rounded to cents; usable gifts permit it and rounded-zero wallets block it',()=>{
  const zero=quotaReport('dsh',balancePayload(),at,'probe')!;assert.equal(quotaPreference(zero,clock),0);
  for(const values of [['0','.005'],['.005','0'],['-1','1.']] as const)assert.equal(quotaPreference(quotaReport('dsh',balancePayload(...values),at,'probe'),clock),1);
  for(const values of [['0','.1e-999'],['1e-999','0'],['.004999999','.004']] as const)assert.equal(quotaPreference(quotaReport('dsh',balancePayload(...values),at,'probe'),clock),0);
  assert.equal(quotaPreference(zero,clock+QUOTA_STALE_MS+1),1);assert.equal(quotaPreference(zero,clock-1),1);assert.equal(balanceFresh(zero.balance!,clock),true);
  assert.equal(quotaPreference(quotaReport('dsh',{accountBalance:{status:'ready',wallets:[],bonusWallets:[]}},at,'probe'),clock),1);
});
test('failed, absent and malformed balances stay unknown and a new failure clears an older ready sample',()=>{
  const ready=quotaReport('dsh',balancePayload('20'),at,'probe')!;
  const failed=quotaReport('dsh',{accountBalance:{status:'unavailable'}},new Date(clock+1).toISOString(),'probe')!;
  assert.equal(mergeQuota(ready,failed).balance?.status,'unavailable');assert.equal(mergeQuota(failed,ready).balance?.status,'unavailable');
  for(const balance of ['NaN','Infinity','0 CNY',0,'1e',null]){
    const q=quotaReport('dsh',balancePayload(balance as string),at,'event')!;assert.equal(q.balance?.status,'unavailable');assert.equal(quotaPreference(q,clock),1);
  }
  assert.equal(accountBalanceReport({status:'ready',wallets:[{currency:'EUR',balance:'0'}],bonusWallets:[]},at).status,'unavailable');
  assert.equal(quotaReport('dsh',{usage:{cost:0}},at,'event'),undefined);
});
test('renminbi display and automatic speech share exact two-decimal rounding',()=>{
  for(const [input,display] of [['12.34567890123456789','12.35'],['1.005','1.01'],['9.995','10.00'],['1','1.00'],['0E-16','0.00'],['.005','0.01'],['-.005','-0.01'],['1e-999','0.00'],['5e-3','0.01'],['12345678901234567890.125','12345678901234567890.13'],['1e999','1.00e+999']])assert.equal(balanceAmount(input,2),display);
  assert.equal(balanceAmount('.50000000'),'.5');
  assert.equal(quotaPreference(quotaReport('dsh',balancePayload('1e-999'),at,'probe'),clock),0);
});
