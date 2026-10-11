import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

function scenario(mode:string,state:string,profile:string,authorizeUrl='https://platform.deepseek.com/dsh/authorize?state=test-state',options:{balance?:unknown;failBalance?:boolean;unsupported?:boolean;expire?:boolean;forbidProfile?:boolean;forbidBalance?:boolean}={}){
  const plugin=pathToFileURL(path.resolve('scripts/dsh-account-plugin.mjs')).href;
  const code=`import {apply} from ${JSON.stringify(plugin)};
  let expired=false;
  const ctx={on(){},appReady:{onReady(fn){fn();}},appExit(code){process.exit(code);},webServer:{port:12345},deepseekAccount:{
    async getState(){return {status:expired?'signed-out':${JSON.stringify(state)}};},async getProfile(){if(${!!options.forbidProfile})process.exit(36);return {status:${JSON.stringify(profile)},value:{token:'never-return-this-token',contact:'private-contact'}};},
    ${options.unsupported?'':`async getBalance(client){if(${!!options.forbidBalance})process.exit(37);if(client.locale!=='zh-CN'||!Number.isFinite(client.timezoneOffsetSeconds))throw Error('bad client');if(${!!options.failBalance})throw Error('never-return-this-token private-contact');if(${!!options.expire}){expired=true;return null;}return ${JSON.stringify(options.balance??{status:'failed'})};},`}
    async startSignIn(client,origin,source){if(origin!=='http://127.0.0.1:12345'||source!=='web')throw Error('bad login origin');},
    async *watch(){yield {status:'signed-out',attempt:{phase:'waiting-browser',authorizeUrl:${JSON.stringify(authorizeUrl)}}};yield {status:'credential-stored',attempt:{phase:'succeeded'}};}
  }};apply(ctx,{mode:${JSON.stringify(mode)}});`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:5000});
  assert.ifError(result.error);assert.ok(!result.stdout.includes('never-return-this-token'));assert.ok(!result.stdout.includes('private-contact'));
  return {code:result.status,events:result.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line.slice(19)))};
}
test('independent account probe distinguishes signed out, signed in and failed verification',()=>{
  const accountBalance={status:'unavailable',wallets:[],bonusWallets:[]};
  assert.deepEqual(scenario('probe','signed-out','ready').events,[{type:'status',authenticated:false,state:'signed-out',accountBalance}]);
  const signed=scenario('probe','credential-stored','ready');assert.equal(signed.code,0);
  assert.deepEqual(signed.events,[{type:'status',authenticated:true,state:'signed-in',accountBalance}]);
  const failed=scenario('probe','credential-stored','failed');assert.equal(failed.code,2);assert.equal(failed.events[0].authenticated,false);
});
test('login emits only the validated official authorization URL and safe status',()=>{
  const result=scenario('login','signed-out','ready');assert.equal(result.code,0);assert.equal(result.events[0].type,'login-url');assert.equal(result.events.at(-1).authenticated,true);
});
test('unexpected authorization destination is rejected without opening or printing it',()=>{
  const result=scenario('login','signed-out','ready','https://unapproved.example/dsh/authorize');assert.equal(result.code,2);assert.equal(result.events.some(e=>e.type==='login-url'),false);
});
test('balance-only check uses the official wallet projection without a profile query or private fields',()=>{
  const result=scenario('balance','credential-stored','ready',undefined,{forbidProfile:true,balance:{status:'ready',value:[{currency:'CNY',balance:'123.1234567890123456789',token:'never-return-this-token'}],bonusWallets:[{currency:'USD',balance:'0E-16',contact:'private-contact'}],credential:'never-return-this-token'}});
  assert.equal(result.code,0);assert.deepEqual(result.events[0].accountBalance,{status:'ready',wallets:[{currency:'CNY',balance:'123.1234567890123456789'}],bonusWallets:[{currency:'USD',balance:'0E-16'}]});
});
test('balance network failure and older unsupported services do not undo a verified login',()=>{
  for(const options of [{failBalance:true},{unsupported:true}]){
    const result=scenario('probe','credential-stored','ready',undefined,options);assert.equal(result.code,0);assert.equal(result.events[0].authenticated,true);assert.equal(result.events[0].accountBalance.status,'unavailable');
  }
});
test('expired grants and malformed wallet numbers return unavailable without guessing a zero balance',()=>{
  const expired=scenario('balance','credential-stored','ready',undefined,{expire:true});assert.equal(expired.events[0].authenticated,false);assert.equal(expired.events[0].accountBalance.status,'unavailable');
  const invalid=scenario('probe','credential-stored','ready',undefined,{balance:{status:'ready',value:[{currency:'CNY',balance:'NaN'}],bonusWallets:[]}});assert.equal(invalid.events[0].authenticated,true);assert.equal(invalid.events[0].accountBalance.status,'unavailable');
});
test('ordinary chat preflight and signed-out balance checks never query wallets',()=>{
  assert.equal(scenario('auth','credential-stored','ready',undefined,{forbidBalance:true}).code,0);
  const signedOut=scenario('balance','signed-out','ready',undefined,{forbidBalance:true,forbidProfile:true});assert.equal(signedOut.code,0);assert.equal(signedOut.events[0].accountBalance.status,'unavailable');
});

test('probe reports a native login lost during wallet checking as signed-out, and a final local check needs no network query',()=>{
  const expired=scenario('probe','credential-stored','ready',undefined,{expire:true});assert.equal(expired.code,0);assert.equal(expired.events[0].state,'signed-out');assert.equal(expired.events[0].authenticated,false);assert.equal(expired.events[0].accountBalance.status,'unavailable');
  const local=scenario('state','credential-stored','failed',undefined,{forbidProfile:true,forbidBalance:true});assert.equal(local.code,0);assert.equal(local.events[0].authenticated,true);
});
