import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import {loginZcodeBigmodel,zcodeCredentialCipher,type ZcodeLoginRequest} from '../src/backend/zcode-login';
import {zcodeAccountState} from '../src/backend/adapters/zcode-account';
import {zcodeLoginService} from './fixtures/zcode-login';
import {collectCommand} from '../src/backend/adapters/common';

const root=path.resolve('.test-cache/zcode-login');
async function fixture(){
  await mkdir(root,{recursive:true});const home=await mkdtemp(path.join(root,'国内授权-')),command=path.join(home,'program','zcode.cjs'),folder=path.join(home,'.zcode','v2');
  await mkdir(path.join(home,'program','provider'),{recursive:true});await mkdir(folder,{recursive:true});
  const provider='account:bigmodel-individual-coding-plan';
  await writeFile(path.join(home,'program','provider','zcode-builtin.json'),JSON.stringify({config:{providerConfigRules:{providerRules:[{providerId:provider,config:{access:{type:'zhipu-account',accountType:'bigmodel',mode:'individual-coding-plan'},builtinModelIds:['GLM-5.3'],api:{baseUrl:'https://open.bigmodel.cn/api/anthropic'}}}]}}}));
  const credentialFile=path.join(folder,'credentials.json'),configFile=path.join(folder,'provider_config.json');
  await writeFile(credentialFile,JSON.stringify({'oauth:zai:access_token':'keep-overseas-token',other:'keep-other-credential'}));
  await writeFile(configFile,JSON.stringify({schemaVersion:1,config:{providerOrder:['keep-custom'],providerConfigRules:{keep:true},defaultModelSelection:{providerId:'old',modelId:'old'}}}));
  const before=[await readFile(credentialFile,'utf8'),await readFile(configFile,'utf8')],service=zcodeLoginService(),controller=new AbortController();
  return {home,command,folder,provider,credentialFile,configFile,before,service,controller,login:(request:ZcodeLoginRequest=service.request,progress?:(state:any)=>void)=>loginZcodeBigmodel(home,command,{},controller.signal,progress,request),unchanged:async()=>assert.deepEqual([await readFile(credentialFile,'utf8'),await readFile(configFile,'utf8')],before),close:async()=>{controller.abort();assert.equal(path.dirname(home),root);await rm(home,{recursive:true,force:true});}};
}

test('BigModel uses the actual domestic authorization page and callback; encrypted native credentials retain other accounts',async()=>{
  const f=await fixture();try{
    const states:any[]=[];await f.login(undefined,state=>states.push(state));
    assert.deepEqual(JSON.parse(f.service.calls[0].body!),{provider:'bigmodel'});
    const url=new URL(states.find(state=>state.phase==='waiting').url);assert.equal(url.host,'bigmodel.cn');assert.equal(new URL(url.searchParams.get('redirect')!).pathname,'/api/v1/oauth/cli/callback/bigmodel');
    const raw=await readFile(f.credentialFile,'utf8'),credentials=JSON.parse(raw),cipher=zcodeCredentialCipher(f.home);
    for(const secret of ['fixture-access','fixture-jwt','fixture-secret','fixture-refresh']){assert.ok(!raw.includes(secret));assert.ok(!JSON.stringify(states).includes(secret));}
    assert.equal(credentials['oauth:zai:access_token'],'keep-overseas-token');assert.equal(credentials.other,'keep-other-credential');
    assert.equal(cipher.decrypt(credentials['oauth:active_provider']),'bigmodel');assert.equal(cipher.decrypt(credentials[`account-provider:coding-plan:${f.provider}:account:fixture-user:api-key`]),'fixture-key.fixture-secret');
    const config=JSON.parse(await readFile(f.configFile,'utf8'));assert.deepEqual(config.config.providerOrder,['keep-custom']);assert.deepEqual(config.config.providerConfigRules,{keep:true});
    assert.equal(zcodeAccountState(f.home,f.command,'bigmodel').ready,true);assert.equal(zcodeAccountState(f.home,f.command,'zai').ready,false);
    assert.deepEqual((await readdir(f.folder)).sort(),['credentials.json','provider_config.json']);
  }finally{await f.close();}
});

for(const mode of ['overseas-page','wrong-callback','overseas-credentials','denied','expired','rate-limit','invalid-json'] as const)test(`domestic login rejects ${mode} without changing saved credentials or model`,async()=>{
  const f=await fixture();try{
    const request:ZcodeLoginRequest=async input=>{
      const response=await f.service.request(input),data=response.body.data;
      if(input.url.endsWith('/init')){
        if(mode==='overseas-page')data.authorize_url='https://chat.z.ai/api/oauth/authorize?state=wrong';
        if(mode==='wrong-callback')data.authorize_url='https://bigmodel.cn/login?redirect='+encodeURIComponent('https://zcode.z.ai/api/v1/oauth/cli/callback/zai');
        if(mode==='expired')data.expires_at=1;
        if(mode==='rate-limit')return {status:429,body:{code:1,msg:'private-token-never-surface'}};
        if(mode==='invalid-json')return {status:200,body:undefined};
      }
      if(input.url.includes('/poll/')){
        if(mode==='overseas-credentials'){data.zai=data.bigmodel;delete data.bigmodel;}
        if(mode==='denied')data.status='failed';
      }
      return response;
    };
    await assert.rejects(f.login(request),error=>{assert.ok(!String(error).includes('private-token-never-surface'));return true;});await f.unchanged();
    assert.equal(f.service.calls.some(call=>call.url.includes('/api/biz/')),false);
  }finally{await f.close();}
});

for(const phase of ['poll','key'] as const)test(`cancel during ${phase} ignores a late successful response and preserves saved login`,async()=>{
  const f=await fixture();try{
    await assert.rejects(f.login(async input=>{const response=await f.service.request(input);if(input.url.includes(phase==='poll'?'/poll/':'/copy/'))f.controller.abort();return response;}),/登录已取消/);await f.unchanged();
  }finally{await f.close();}
});

test('login creates the official named plan key only when missing and reads the matching secret',async()=>{
  const f=await fixture();try{
    let creations=0;
    await f.login(async input=>{
      if(input.url.endsWith('/api_keys')){
        if(input.method==='GET')return {status:200,body:{code:0,data:[]}};
        creations++;assert.deepEqual(JSON.parse(input.body!),{name:'zcode-api-key'});return {status:200,body:{code:0,data:{apiKey:'fixture-key'}}};
      }
      return f.service.request(input);
    });assert.equal(creations,1);assert.equal(zcodeAccountState(f.home,f.command,'bigmodel').ready,true);
  }finally{await f.close();}
});

test('the cipher matches the official CLI format and isolated child HOME',async()=>{
  const f=await fixture();try{
    const cipher=zcodeCredentialCipher(f.home),encrypted=cipher.encrypt('fixture-compatibility-token'),script=path.join(f.home,'verify.cjs');
    await writeFile(script,`const {createHash,createDecipheriv}=require('node:crypto'),os=require('node:os');const [iv,tag,bytes]=process.argv[2].slice(7).split('.').map(x=>Buffer.from(x,'base64url'));const key=createHash('sha256').update('zcode-credential-fallback:'+process.platform+':'+os.homedir()+':'+os.userInfo().username).digest();const d=createDecipheriv('aes-256-gcm',key,iv);d.setAuthTag(tag);console.log(Buffer.concat([d.update(bytes),d.final()]).toString()==='fixture-compatibility-token');`);
    const result=await collectCommand({command:process.execPath,path:process.execPath,prefix:[script]},[encrypted],{...process.env,HOME:f.home,USERPROFILE:f.home},f.home,8000);assert.equal(result.code,0);assert.equal(result.stdout.trim(),'true');
  }finally{await f.close();}
});

test('account identity must match the exact key; unreadable encrypted credentials never appear connected',async()=>{
  const f=await fixture();try{
    await f.login();const credentials=JSON.parse(await readFile(f.credentialFile,'utf8'));
    credentials[`account-provider:${f.provider}:identity`]=zcodeCredentialCipher(f.home).encrypt('other-user');await writeFile(f.credentialFile,JSON.stringify(credentials));assert.equal(zcodeAccountState(f.home,f.command,'bigmodel').ready,false);
    credentials['oauth:bigmodel:access_token']='enc:v1:corrupted';await writeFile(f.credentialFile,JSON.stringify(credentials));assert.equal(zcodeAccountState(f.home,f.command,'bigmodel').loggedIn,false);
  }finally{await f.close();}
});
