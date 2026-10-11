import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,rename,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ZcodeAdapter} from '../src/backend/adapters/zcode';
import {completeZcodeEntry,zcodeRelease} from '../src/backend/zcode-install';
import {DEFAULT_SETTINGS} from '../src/shared/defaults';
import type {AcpExecutor,AdapterContext,TimelineEvent} from '../src/shared/types';
import {Engine} from '../src/backend/engine';
import {zcodeFailure} from '../src/backend/adapters/zcode-account';
import {loginZcodeBigmodel} from '../src/backend/zcode-login';
import {zcodeLoginService} from './fixtures/zcode-login';
import {ZcodeTaskOutput} from '../src/backend/adapters/zcode-model';
import {acknowledgedNativeContext} from '../src/backend/native-context';
import {zcodeRoomTools,ZCODE_ROOM_DISABLED_TOOLS} from '../src/backend/adapters/zcode-chat';

const root=path.resolve('.test-cache/zcode-tests');
const native=await readFile(new URL('./fixtures/zcode-cli.cjs',import.meta.url),'utf8');
async function fixture(){
  await mkdir(root,{recursive:true});const directory=await mkdtemp(path.join(root,'中文 空格-')),command=path.join(directory,'zcode.cjs');await writeFile(command,native);
  const executor:AcpExecutor={id:'acp-catalogzcode',name:'ZCode CLI',command,args:[],env:{},permissions:{commands:'auto',fileScope:'any',network:true},createdAt:'',catalogId:'zcode',authentication:'zai'};
  const env={...process.env,AIROOM_ACP_HOME:path.join(directory,'owned'),ZAI_API_KEY:'host-key',OPENAI_API_KEY:'host-openai-key',ZCODE_HOST_MARKER:'host-data'};
  const events:{kind:TimelineEvent['kind'];text:string;data:unknown}[]=[],deliveries:string[]=[],configs:any[]=[];
  const context:AdapterContext={
    cwd:directory,env,settings:{...DEFAULT_SETTINGS,models:{},efforts:{},permissions:{...DEFAULT_SETTINGS.permissions,[executor.id]:executor.permissions}},
    run:{id:'run',sessionId:'session',projectId:'project',provider:executor.id,revision:1,status:'running',input:'',createdAt:'',updatedAt:'',bootId:'fixture',delivery:'prepared'},
    session:{id:'session',projectId:'project',provider:executor.id,title:'fixture',revision:1,writeMode:true,createdAt:'',updatedAt:''},
    recordConfig:value=>configs.push(value),persona:'人物设定',emit:(kind,text,data)=>events.push({kind,text,data}),approve:async()=>assert.fail('headless ZCode cannot request interactive approval'),
    persistNativeSession(id,home){context.session.nativeId=id;context.session.nativeHome=home;},markDelivery(state,turn){deliveries.push(state);context.run.delivery=state;context.run.nativeTurnId=turn;},registerProcess(){},
    persistNativePersona(nativeId,hash){context.session.nativePersona={nativeId,hash};},
  };
  const loginService=zcodeLoginService(),adapter=new ZcodeAdapter(executor,(home,command,env,signal,progress)=>loginZcodeBigmodel(home,command,env,signal,progress,loginService.request),async()=>[...ZCODE_ROOM_DISABLED_TOOLS]),home=path.join(env.AIROOM_ACP_HOME,executor.id);
  await mkdir(path.join(directory,'provider'),{recursive:true});await writeFile(path.join(directory,'provider/zcode-builtin.json'),JSON.stringify({schemaVersion:1,revision:30,config:{providerConfigRules:{providerRules:['zai','bigmodel'].map(account=>({providerId:'account:'+account+'-individual-coding-plan',config:{access:{type:'zhipu-account',accountType:account,mode:'individual-coding-plan'},builtinModelIds:['fixture-'+account,'fixture-'+account+'-fast']}}))}}}));
  await mkdir(path.join(home,'.zcode/v2'),{recursive:true});await writeFile(path.join(home,'.zcode/v2/credentials.json'),JSON.stringify({'oauth:zai:access_token':'fixture-access',zcodejwttoken:'fixture-jwt','account-provider:account:zai-individual-coding-plan:identity':'fixture-user','account-provider:coding-plan:account:zai-individual-coding-plan:account:fixture-user:api-key':'fixture-api-key'}));await writeFile(path.join(home,'.zcode/v2/provider_config.json'),JSON.stringify({config:{defaultModelSelection:{providerId:'account:zai-individual-coding-plan',modelId:'fixture-zai'}}}));
  return {directory,executor,context,events,deliveries,configs,adapter,home,loginService,calls:async()=>JSON.parse('['+(await readFile(path.join(home,'calls.jsonl'),'utf8')).trim().split('\n').join(',')+']'),cleanup:async()=>{await adapter.stop();assert.equal(path.dirname(directory),root);await rm(directory,{recursive:true,force:true});}};
}

test('ZCode probe and native login use an isolated home and strip inherited provider credentials',async()=>{
  const f=await fixture();try{
    await rm(path.join(f.home,'.zcode/v2/credentials.json'));
    const unsigned=await f.adapter.probe(f.context.settings,f.context.env);assert.equal(unsigned.runtimeReady,true);assert.equal(unsigned.available,false);assert.equal(unsigned.auth,'none');
    await assert.rejects(f.adapter.authenticate(f.context.env,'other'),/官方登录/);
    await f.adapter.authenticate(f.context.env);const loggedIn=await f.adapter.probe(f.context.settings,f.context.env);assert.equal(loggedIn.available,true);assert.equal(loggedIn.version,'0.16.9');assert.match(loggedIn.detail,/实际调用/);
    await assert.rejects(readFile(path.join(f.directory,'.zcode/v2/credentials.json')),/ENOENT/);
    await assert.rejects(f.calls(),/ENOENT/);
  }finally{await f.cleanup();}
});

for(const account of ['bigmodel','zai'] as const)test(`ZCode ${account} login selects matching credentials, model and official account provider`,async()=>{
  const f=await fixture();try{
    f.executor.authentication=account;await f.adapter.authenticate(f.context.env,account);
    const info=await f.adapter.probe(f.context.settings,f.context.env);assert.equal(info.available,true);assert.equal(info.auth,'subscription');assert.equal(info.model,'fixture-'+account);assert.match(info.detail,account==='bigmodel'?/BigModel 中国区/:/Z.ai 海外/);assert.match(info.configuration!.detail!,new RegExp('fixture-'+account));
    if(account==='zai'){const call=JSON.parse((await readFile(path.join(f.home,'login-calls.jsonl'),'utf8')).trim());assert.deepEqual(call.args,['login',account,'--json','--no-browser']);}
    else {await assert.rejects(readFile(path.join(f.home,'login-calls.jsonl')),/ENOENT/);assert.deepEqual(JSON.parse(f.loginService.calls[0].body!),{provider:'bigmodel'});}
    await f.adapter.start(f.context,'登录后只调用所选地区');assert.equal((await f.calls()).length,1);
    const credentials=JSON.parse(await readFile(path.join(f.home,'.zcode/v2/credentials.json'),'utf8'));assert.ok(credentials['oauth:'+account+':access_token']);
    await f.adapter.authenticate(f.context.env);assert.equal((await f.adapter.probe(f.context.settings,f.context.env)).available,true);
  }finally{await f.cleanup();}
});

test('ZCode rejects an opposite region, JWT-only login and incomplete account entitlement before dispatch',async()=>{
  const f=await fixture();try{
    f.executor.authentication='bigmodel';assert.equal((await f.adapter.probe(f.context.settings,f.context.env)).available,false);await assert.rejects(f.adapter.start(f.context,'must not send'),/BigModel 中国区/);await assert.rejects(f.adapter.authenticate(f.context.env,'zai'),/先保存/);
    await f.adapter.authenticate(f.context.env,'bigmodel');const file=path.join(f.home,'.zcode/v2/credentials.json'),credentials=JSON.parse(await readFile(file,'utf8'));
    await writeFile(file,JSON.stringify({...credentials,'oauth:bigmodel:access_token':''}));assert.equal((await f.adapter.probe(f.context.settings,f.context.env)).available,false);
    await writeFile(file,JSON.stringify(credentials));await writeFile(path.join(f.home,'.zcode/v2/provider_config.json'),JSON.stringify({config:{defaultModelSelection:{providerId:'account:zai-individual-coding-plan',modelId:'wrong-region'}}}));assert.match((await f.adapter.probe(f.context.settings,f.context.env)).detail,/模型通道.*Z.ai.*不一致/);await assert.rejects(f.adapter.start(f.context,'must not send'),/模型通道/);
    await f.adapter.authenticate(f.context.env,'bigmodel');delete credentials['account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:fixture-user:api-key'];await writeFile(file,JSON.stringify(credentials));assert.match((await f.adapter.probe(f.context.settings,f.context.env)).detail,/凭据或模型通道尚未配置完整/);
    assert.deepEqual(f.deliveries,[]);await assert.rejects(f.calls(),/ENOENT/);
  }finally{await f.cleanup();}
});

test('ZCode 1113 displays the account-specific reason without headers or secrets and never retries unknown delivery',async()=>{
  const f=await fixture();try{
    const result=await f.adapter.start(f.context,'quota-no-final');assert.equal(result.unknown,true);assert.match(result.unknownReason!,/1113.*余额不足/);assert.match(result.unknownReason!,/Z.ai 海外/);assert.deepEqual(f.deliveries,['sent','unknown']);assert.equal((await f.calls()).length,1);assert.equal(f.events.filter(e=>e.kind==='delta').length,0);
    assert.doesNotMatch(JSON.stringify(f.events),/quota-cookie-secret|fixture-authorization-secret|set-cookie|Max-Age|authorization/);assert.match(f.events.at(-1)!.text,/不会自动重发/);assert.equal((f.events.at(-1)!.data as any).providerCode,'1113');
    const final=await f.adapter.start(f.context,'quota-final');assert.equal(final.failure?.kind,'blocked');assert.match(final.failure!.message,/1113/);assert.equal(f.context.run.delivery,'confirmed');assert.equal((await f.calls()).length,2);
    const long=await f.adapter.start(f.context,'quota-long');assert.match(long.unknownReason!,/1113/);assert.doesNotMatch(JSON.stringify(f.events),/quota-cookie-secret|fixture-authorization-secret|header-padding/);assert.equal((await f.calls()).length,3);
    assert.match(zcodeFailure("providerCode: '1113', responseStatus: 429",'bigmodel').message!,/BigModel 中国区/);assert.equal(zcodeFailure('unrelated request id 1113','bigmodel').message,undefined);
  }finally{await f.cleanup();}
});

test('ZCode accepts only a declared model on the native subscription channel',async()=>{
  const f=await fixture();try{
    const file=path.join(f.home,'.zcode/v2/provider_config.json');
    await writeFile(file,JSON.stringify({config:{defaultModelSelection:{providerId:'account:zai-individual-coding-plan',modelId:'unsupported-api-model'}}}));
    assert.equal((await f.adapter.probe(f.context.settings,f.context.env)).available,false);await assert.rejects(f.adapter.start(f.context,'must not send'),/模型通道尚未配置完整/);
    await f.adapter.authenticate(f.context.env);
    const builtin=path.join(f.directory,'provider/zcode-builtin.json'),catalog=JSON.parse(await readFile(builtin,'utf8'));catalog.config.providerConfigRules.providerRules[0].config.access.mode='team-coding-plan';await writeFile(builtin,JSON.stringify(catalog));
    assert.equal((await f.adapter.probe(f.context.settings,f.context.env)).available,false);await assert.rejects(f.adapter.start(f.context,'must not send'),/模型通道尚未配置完整/);assert.deepEqual(f.deliveries,[]);await assert.rejects(f.calls(),/ENOENT/);
  }finally{await f.cleanup();}
});

for(const available of [true,false])test(`ZCode login status finishes after the connection check (${available?'passed':'failed'})`,async()=>{
  const f=await fixture(),previous=process.env.AIROOM_ACP_HOME;
  process.env.AIROOM_ACP_HOME=f.context.env.AIROOM_ACP_HOME;
  const states:any[]=[],engine=new Engine(path.join(f.directory,'engine'),event=>{if(event.type==='executor-login')states.push(event.state);},()=>{},id=>({probe:async()=>({id,name:'ZCode',available,runtimeReady:true,auth:available?'subscription':'unknown',detail:available?'connected':'连接检查超时',capabilities:{steer:false,cancel:'native',streaming:false,write:true,history:true}}),start:async()=>assert.fail('a login check must never prompt a model'),stop:async()=>{}}));
  try{
    engine.store.put('executors',f.executor.id,f.executor);
    await engine.invoke('executor.authenticate',{id:f.executor.id,methodId:'zai'});
    const status=await engine.invoke('executor.loginStatus',{id:f.executor.id}) as {phase:string;message:string;url?:string;code?:string};
    assert.equal(status.phase,'completed');assert.match(status.message,available?/连接检查通过/:/连接检查未通过：连接检查超时/);assert.doesNotMatch(status.message,/正在检查/);assert.equal(status.url,undefined);assert.equal(status.code,undefined);assert.deepEqual(states.at(-1),status);assert.equal(engine.store.list('runs').length,0);
  }finally{if(previous===undefined)delete process.env.AIROOM_ACP_HOME;else process.env.AIROOM_ACP_HOME=previous;await engine.close();await f.cleanup();}
});

test('ZCode waits for the final JSON, emits one reply, and resumes the same native session',async()=>{
  const f=await fixture();try{
    const result=await f.adapter.start(f.context,'第一轮');assert.equal(result.summary,'完整回复只出现一次');assert.deepEqual(f.deliveries,['sent','confirmed']);assert.equal(f.events.filter(e=>e.kind==='delta').length,1);assert.equal(f.context.session.nativeId,'sess_fixture');assert.equal(f.context.session.nativeHome,'airoom');
    await f.adapter.start(f.context,'第二轮');const calls=await f.calls();assert.equal(calls.length,2);assert.equal(calls[0].args.includes('--resume'),false);assert.equal(calls[1].args[calls[1].args.indexOf('--resume')+1],'sess_fixture');assert.equal(calls[0].args[calls[0].args.indexOf('--mode')+1],'yolo');assert.match(calls[0].args[calls[0].args.indexOf('-p')+1],/人物设定\n\n第一轮/);assert.equal(f.events.filter(e=>e.kind==='delta').length,2);
  }finally{await f.cleanup();}
});

test('ZCode acknowledges persona only on verified success, resends updated memory, and replays fresh room history',async()=>{
  const f=await fixture();try{
    let fresh=0;f.context.freshInput=()=>{fresh++;return '完整历史：决定保留未完成事项。';};
    await f.adapter.start(f.context,'第一轮');const id=f.context.session.nativeId;
    assert.equal(fresh,1);assert.equal(f.context.session.nativePersona?.nativeId,id);
    f.context.session.nativeContext=acknowledgedNativeContext(f.context.session,10,true,false);
    await f.adapter.start(f.context,'第二轮');assert.equal(fresh,1);
    const prompts=(await f.calls()).map((call:any)=>call.args[call.args.indexOf('-p')+1]);
    assert.match(prompts[0],/人物设定.*\n\n完整历史/s);assert.equal(prompts[1],'第二轮');
    const remembered=f.context.session.nativePersona;f.context.persona='人物设定\n记忆：新要求不要丢。';
    await f.adapter.start(f.context,'no-model-report');assert.deepEqual(f.context.session.nativePersona,remembered);
    await f.adapter.start(f.context,'更新后的对话');assert.notEqual(f.context.session.nativePersona?.hash,remembered?.hash);
    const updated=(await f.calls()).at(-1).args;assert.match(updated[updated.indexOf('-p')+1],/新要求不要丢/);
    f.context.session.nativeId=undefined;await f.adapter.start(f.context,'重建后');assert.equal(fresh,2);
    const reset=(await f.calls()).at(-1).args;assert.match(reset[reset.indexOf('-p')+1],/新要求不要丢.*完整历史/s);
  }finally{await f.cleanup();}
});

test('ZCode unchanged persisted model skips a redundant setter but still verifies every request',async()=>{
  const f=await fixture();try{
    await f.adapter.start(f.context,'首轮');const before=(await readFile(path.join(f.home,'model-control-calls.jsonl'),'utf8')).trim().split('\n').length;
    f.configs.length=0;await f.adapter.start(f.context,'保持模型');
    const calls=(await readFile(path.join(f.home,'model-control-calls.jsonl'),'utf8')).trim().split('\n').slice(before).map(line=>JSON.parse(line));
    assert.equal(calls.filter(call=>call.method==='session/resume').length,1);assert.equal(calls.filter(call=>call.method==='session/setModel').length,0);
    assert.ok(f.configs.some(config=>config.source==='zcode.model-request'&&config.modelStatus==='reported'));
  }finally{await f.cleanup();}
});

test('ZCode room speech omits unused tool schemas; desk work and reports keep read tools',async()=>{
  const f=await fixture();try{
    f.context.session.writeMode=false;f.context.conversation='room';await f.adapter.start(f.context,'普通发言');
    f.context.conversation='desk';await f.adapter.start(f.context,'读取用户给的文件');
    f.context.conversation='room';f.context.session.purpose='room-summary';await f.adapter.start(f.context,'汇报事实');
    const denied=(await f.calls()).map((call:any)=>call.args[call.args.indexOf('--disallowed-tools')+1].split(','));
    assert.ok(['Read','TodoRead','AskUserQuestion','ReadSessionContext','GetWorkflowRun','TaskOutput'].every(tool=>denied[0].includes(tool)));assert.ok(!denied[1].includes('Read')&&!denied[2].includes('Read'));
    assert.equal(f.events.filter(e=>e.kind==='delta').length,3);assert.equal(f.events.filter(e=>e.kind==='status'&&e.text==='ZCode 正在生成回复。').length,3);assert.ok(!f.events.some(e=>e.kind==='output'&&e.text==='ZCode 正在生成回复。'));
  }finally{await f.cleanup();}
});

test('unreviewed ZCode upgrades still send room speech with one notice and mandatory permissions; flow and image keep tools',async()=>{
  const f=await fixture();try{
    assert.deepEqual(await zcodeRoomTools(f.executor.command),[]);
    const adapter=new ZcodeAdapter(f.executor);f.context.session.writeMode=false;f.context.conversation='room';
    await adapter.start(f.context,'普通聊天');assert.ok(f.deliveries.includes('confirmed'));
    assert.equal(f.events.filter(e=>e.kind==='warning'&&e.text==='新版 ZCode 的聊天室工具裁剪尚未核对，本轮未裁剪').length,1);
    const first=(await f.calls())[0],denied=first.args[first.args.indexOf('--disallowed-tools')+1].split(',');
    assert.ok(denied.includes('Write')&&denied.includes('Bash'));assert.ok(!denied.includes('Read'));
    // A fresh adapter models another member/room or the next run; a path change is not a new version.
    await new ZcodeAdapter(f.executor).start(f.context,'同版本下一轮');
    const copy=path.join(f.directory,'same-version.cjs');await writeFile(copy,await readFile(f.executor.command));
    await new ZcodeAdapter({...f.executor,command:copy}).start(f.context,'同版本另一入口');
    assert.equal(f.events.filter(e=>e.kind==='warning'&&e.text.includes('聊天室工具裁剪尚未核对')).length,1);
    await writeFile(f.executor.command,native+'\n// upgraded fixture version\n');
    await new ZcodeAdapter(f.executor).start(f.context,'新版第一轮');
    await new ZcodeAdapter(f.executor).start(f.context,'新版第二轮');
    assert.equal(f.events.filter(e=>e.kind==='warning'&&e.text.includes('聊天室工具裁剪尚未核对')).length,2);
    for(const kind of ['flow','image']){
      f.context.run.flowOperationId=kind==='flow'?'flow-operation':undefined;f.context.run.imageGeneration=kind==='image';
      await f.adapter.start(f.context,kind);
    }
    for(const call of await f.calls())assert.ok(!call.args[call.args.indexOf('--disallowed-tools')+1].split(',').includes('Read'));
  }finally{await f.cleanup();}
});

test('ZCode reads the native regional model list and reasoning options without changing defaults or dispatching',async()=>{
  const f=await fixture();try{
    const file=path.join(f.home,'.zcode/v2/provider_config.json'),before=await readFile(file);
    f.context.settings.models[f.executor.id]='fixture-zai-fast';
    const info=await f.adapter.probe(f.context.settings,f.context.env);
    assert.deepEqual(info.modelOptions?.map(option=>option.id),['fixture-zai','fixture-zai-fast']);
    assert.ok(info.modelOptions?.every(option=>option.efforts.join(',')==='low,high'&&option.effortSource==='reported'));
    assert.equal(info.configuration?.model,true);assert.equal(info.configuration?.effort,'reported');assert.equal(info.model,'fixture-zai');
    assert.deepEqual(await readFile(file),before);assert.deepEqual(f.deliveries,[]);await assert.rejects(f.calls(),/ENOENT/);
    const builtin=path.join(f.directory,'provider/zcode-builtin.json'),catalog=JSON.parse(await readFile(builtin,'utf8'));
    catalog.config.providerConfigRules.providerRules[0].config.builtinModelIds.push('fixture-new-release-model');await writeFile(builtin,JSON.stringify(catalog));
    assert.ok((await f.adapter.probe(f.context.settings,f.context.env)).modelOptions?.some(option=>option.id==='fixture-new-release-model'));
  }finally{await f.cleanup();}
});

test('ZCode switches a resumed native session, checks the actual model, and preserves the official default and credentials',async()=>{
  const f=await fixture();try{
    const original=await readFile(path.join(f.home,'.zcode/v2/provider_config.json')),credentials=await readFile(path.join(f.home,'.zcode/v2/credentials.json'));
    f.context.settings.models[f.executor.id]='fixture-zai-fast';f.context.settings.efforts[f.executor.id]='low';
    await f.adapter.start(f.context,'首次选模型');const id=f.context.session.nativeId;
    assert.ok(f.configs.some(config=>config.source==='zcode.model-request'&&config.model==='fixture-zai-fast'&&config.modelStatus==='reported'));
    assert.equal((await f.calls())[0].args.includes('--resume'),false);
    f.configs.length=0;f.context.settings.models[f.executor.id]='fixture-zai';f.context.settings.efforts[f.executor.id]='high';
    await f.adapter.start(f.context,'原生续聊换模型');assert.equal(f.context.session.nativeId,id);
    assert.equal(f.configs.at(-1).model,'fixture-zai');assert.equal(f.configs.at(-1).modelStatus,'reported');
    const commands=(await readFile(path.join(f.home,'model-control-calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(commands.some(call=>call.method==='session/setModel'&&call.params.model.modelId==='fixture-zai'&&call.params.persistAsWorkspaceLastUsed===false));
    assert.equal(commands.filter(call=>call.method==='session/resume'&&call.params.sessionId===id).length,2);
    assert.deepEqual(await readFile(path.join(f.home,'.zcode/v2/provider_config.json')),original);assert.deepEqual(await readFile(path.join(f.home,'.zcode/v2/credentials.json')),credentials);
    for(const call of await f.calls()){assert.notEqual(call.personalFile,path.join(f.home,'.zcode/v2/provider_config.json'));await assert.rejects(readFile(call.personalFile),/ENOENT/);}
    assert.equal(f.events.filter(event=>event.kind==='delta').length,2);
  }finally{await f.cleanup();}
});

test('ZCode honors captured session/project/member configuration and an explicit program default',async()=>{
  const f=await fixture();try{
    f.context.settings.models[f.executor.id]='fixture-zai';
    f.context.run.requestedConfig={model:'fixture-zai-fast',effort:'low',modelSource:'session',effortSource:'member',capturedAt:''};
    await f.adapter.start(f.context,'会话覆盖');assert.equal(f.configs.at(-1).model,'fixture-zai-fast');
    f.context.run.requestedConfig={modelSource:'default',effortSource:'default',capturedAt:''};
    f.context.settings.models[f.executor.id]='fixture-zai-fast';
    await f.adapter.start(f.context,'显式恢复官方默认');assert.equal(f.configs.at(-1).model,'fixture-zai');
    assert.equal((await f.calls()).length,2);
  }finally{await f.cleanup();}
});

for(const change of ['model','effort','readback','persistence','overlay'] as const)test(`ZCode rejects ${change} configuration failures before dispatch and can recover`,async()=>{
  const f=await fixture();try{
    if(change==='persistence')await f.adapter.start(f.context,'建立原生历史');
    const sent=f.deliveries.length,calls=await f.calls().catch(()=>[]);
    if(change==='model')f.context.settings.models[f.executor.id]='account:bigmodel-individual-coding-plan/fixture-bigmodel';
    if(change==='effort')f.context.settings.efforts[f.executor.id]='unsupported';
    if(change==='readback'){f.context.settings.models[f.executor.id]='fixture-zai-fast';await writeFile(path.join(f.home,'control.json'),JSON.stringify({setMismatch:true}));}
    if(change==='persistence'){f.context.settings.models[f.executor.id]='fixture-zai-fast';await writeFile(path.join(f.home,'control.json'),JSON.stringify({persistenceFailure:true}));}
    if(change==='overlay')await writeFile(path.join(f.home,'control.json'),JSON.stringify({overlayFailure:true}));
    await assert.rejects(f.adapter.start(f.context,'不得发出'),change==='model'?/当前账号套餐/:change==='effort'?/思考程度/:change==='overlay'?/overlay/:/读回核对/);
    assert.equal(f.deliveries.length,sent);assert.equal((await f.calls().catch(()=>[])).length,calls.length);assert.equal(f.configs.at(-1).modelStatus,'rejected');
    await rm(path.join(f.home,'control.json'),{force:true});f.context.settings.models[f.executor.id]='fixture-zai-fast';f.context.settings.efforts[f.executor.id]='low';
    assert.equal((await f.adapter.start(f.context,'修正后继续')).failure,undefined);assert.equal(f.configs.at(-1).modelStatus,'reported');
  }finally{await f.cleanup();}
});

for(const prompt of ['wrong-model-report','no-model-report'])test(`ZCode never labels ${prompt} as verified or sends the task twice`,async()=>{
  const f=await fixture();try{
    const result=await f.adapter.start(f.context,prompt);assert.equal(result.failure?.kind,'failed');assert.match(result.failure!.message,/不会自动重发/);
    assert.equal(f.configs.at(-1).modelStatus,prompt==='wrong-model-report'?'rejected':'unreported');assert.deepEqual(f.deliveries,['sent','confirmed']);assert.equal((await f.calls()).length,1);assert.equal(f.events.filter(event=>event.kind==='delta').length,0);
  }finally{await f.cleanup();}
});

test('ZCode rejects an empty native catalog and reports unsupported reasoning without inventing options',async()=>{
  const f=await fixture();try{
    await writeFile(path.join(f.home,'control.json'),JSON.stringify({noModels:true}));
    const unavailable=await f.adapter.probe(f.context.settings,f.context.env);assert.equal(unavailable.available,false);assert.equal(unavailable.configuration?.model,false);
    await assert.rejects(f.adapter.start(f.context,'不得发出'),/当前账号套餐/);await assert.rejects(f.calls(),/ENOENT/);
    await writeFile(path.join(f.home,'control.json'),JSON.stringify({noEffort:true}));
    const info=await f.adapter.probe(f.context.settings,f.context.env);assert.equal(info.configuration?.model,true);assert.equal(info.configuration?.effort,'unsupported');assert.ok(info.modelOptions?.every(option=>!option.efforts.length));
  }finally{await f.cleanup();}
});

test('ZCode cancellation during native model inspection does not send a task and clears the process',async()=>{
  const f=await fixture();try{
    await writeFile(path.join(f.home,'control.json'),JSON.stringify({waitForControl:true}));
    const running=f.adapter.start(f.context,'不得发出');
    for(let tries=0;;tries++){
      const log=await readFile(path.join(f.home,'model-control-calls.jsonl'),'utf8').catch(()=>'');if(log.includes('session/create'))break;
      assert.ok(tries<100);await new Promise(resolve=>setTimeout(resolve,25));
    }
    await f.adapter.stop();assert.equal((await running).stopped,true);assert.deepEqual(f.deliveries,[]);await assert.rejects(f.calls(),/ENOENT/);
    await rm(path.join(f.home,'control.json'));assert.equal((await f.adapter.start(f.context,'重新开始')).failure,undefined);
  }finally{await f.cleanup();}
});

test('ZCode task parser retains model provenance and one final result across fragmented UTF-8 text',()=>{
  const parser=new ZcodeTaskOutput();
  const stream=[{type:'session.updated',sessionId:'native',turnId:'turn',payload:{providerId:'account',modelId:'模型',messageCount:1}}, {type:'model.streaming',payload:{delta:'流式内容'}},{type:'result',sessionId:'native',turnId:'turn',response:'完整回复'}].map(value=>JSON.stringify(value)).join('\n');
  for(let i=0;i<stream.length;i+=7)parser.feed(stream.slice(i,i+7));parser.finish();
  assert.equal(parser.invalid,false);assert.equal(parser.result.response,'完整回复');assert.deepEqual(parser.models,[{sessionId:'native',turnId:'turn',providerId:'account',modelId:'模型'}]);
  parser.feed('\n'+JSON.stringify({type:'result',response:'重复结算'})+'\n');assert.equal(parser.invalid,true);
  const invalid=new ZcodeTaskOutput();invalid.feed('not json\n');assert.equal(invalid.invalid,true);
});

test('ZCode refuses unsupported writes and model overrides before dispatch; read-only combines all tool restrictions',async()=>{
  const f=await fixture();try{
    f.context.settings.permissions[f.executor.id]={commands:'ask',fileScope:'workspace',network:false};
    await assert.rejects(f.adapter.start(f.context,'must not send'),/写入任务需要/);assert.deepEqual(f.deliveries,[]);await assert.rejects(f.calls(),/ENOENT/);
    f.context.session.writeMode=false;await f.adapter.start(f.context,'只读检查');const [call]=await f.calls();assert.equal(call.args[call.args.indexOf('--mode')+1],'plan');assert.equal(call.args.filter((s:string)=>s==='--disallowed-tools').length,1);for(const tool of ['Bash','Write','Edit','Task','WebFetch','WebSearch'])assert.ok(call.args[call.args.indexOf('--disallowed-tools')+1].split(',').includes(tool));
    f.context.settings.models[f.executor.id]='unsupported';await assert.rejects(f.adapter.start(f.context,'must not send'),/不在当前账号套餐/);assert.equal((await f.calls()).length,1);
  }finally{await f.cleanup();}
});

test('ZCode missing final result remains unknown and never retries; a confirmed native failure is not success',async()=>{
  const f=await fixture();try{
    assert.equal((await f.adapter.start(f.context,'no-final')).unknown,true);assert.deepEqual(f.deliveries,['sent','unknown']);assert.equal((await f.calls()).length,1);assert.equal(f.events.filter(e=>e.kind==='delta').length,0);
    const result=await f.adapter.start(f.context,'native-failure');assert.equal(result.failure?.kind,'failed');assert.equal(f.context.run.delivery,'confirmed');assert.equal(f.events.filter(e=>e.kind==='delta').length,0);
  }finally{await f.cleanup();}
});

test('ZCode stop cancels its owned process without producing a second reply',async()=>{
  const f=await fixture();try{
    const running=f.adapter.start(f.context,'wait-for-stop');await new Promise<void>((resolve,reject)=>{const deadline=Date.now()+8000;const poll=()=>void f.calls().then(()=>resolve(),()=>Date.now()>deadline?reject(new Error('fixture did not start')):setTimeout(poll,50));poll();});
    await f.adapter.stop();assert.equal((await running).stopped,true);assert.equal(f.events.filter(e=>e.kind==='delta').length,0);
  }finally{await f.cleanup();}
});

test('ZCode release metadata accepts only the exact official version and artifact',()=>{
  const hash=Buffer.alloc(64,1).toString('base64'),metadata=`version: 3.14.5\npath: ZCode-3.14.5-win-x64.exe\nsha512: ${hash}\n`;
  assert.equal(zcodeRelease('3.14.5',metadata).url,'https://cdn-zcode.z.ai/zcode/electron/releases/3.14.5/windows-x64/ZCode-3.14.5-win-x64.exe');
  for(const value of ['../3.14.5','3.14.5?x','3.14.6'])assert.throws(()=>zcodeRelease(value,metadata));assert.throws(()=>zcodeRelease('3.14.5',metadata.replace('path: ZCode-','path: Other-')));assert.throws(()=>zcodeRelease('3.14.5',metadata.replace(hash,'invalid')));
});

test('ZCode completed installation rejects changed entry, missing dependencies, and directory junctions',async()=>{
  await mkdir(root,{recursive:true});const directory=await mkdtemp(path.join(root,'inventory-')),prefix=path.join(directory,'3.14.5'),entry=path.join(prefix,'resources/glm/zcode.cjs'),contents=Buffer.from('fixture');await mkdir(path.dirname(entry),{recursive:true});await writeFile(entry,contents);
  const provider=path.join(prefix,'resources/glm/provider/zcode-builtin.json');await mkdir(path.dirname(provider),{recursive:true});await writeFile(provider,'{}');
  const marker={schema:3,member:'zcode',version:'3.14.5',entry:'resources/glm/zcode.cjs',entrySha256:createHash('sha256').update(contents).digest('hex'),files:[{path:'resources/glm/zcode.cjs',size:contents.length},{path:'resources/glm/provider/zcode-builtin.json',size:2,sha256:createHash('sha256').update('{}').digest('hex')}]};
  try{
    await writeFile(path.join(prefix,'.airoom-install.json'),JSON.stringify(marker));assert.equal(completeZcodeEntry(prefix,'3.14.5'),entry);assert.equal(completeZcodeEntry(prefix,'3.14.6'),undefined);
    await writeFile(provider,'[]');assert.equal(completeZcodeEntry(prefix),undefined);await writeFile(provider,'{}');
    await writeFile(path.join(prefix,'.airoom-install.json'),JSON.stringify({...marker,schema:2}));assert.equal(completeZcodeEntry(prefix),undefined);await writeFile(path.join(prefix,'.airoom-install.json'),JSON.stringify(marker));
    await writeFile(entry,'changed');assert.equal(completeZcodeEntry(prefix),undefined);await writeFile(entry,contents);
    // Build the junction case independently: renaming the just-read inventory can race Windows scanners.
    const external=path.join(directory,'external'),linked=path.join(directory,'linked');
    await mkdir(path.join(external,'provider'),{recursive:true});await writeFile(path.join(external,'zcode.cjs'),contents);await writeFile(path.join(external,'provider/zcode-builtin.json'),'{}');
    await mkdir(path.join(linked,'resources'),{recursive:true});await writeFile(path.join(linked,'.airoom-install.json'),JSON.stringify(marker));
    await symlink(external,path.join(linked,'resources/glm'),process.platform==='win32'?'junction':'dir');assert.equal(completeZcodeEntry(linked),undefined);
    await rm(path.join(linked,'resources/glm'),{force:true});
  }finally{if((await lstat(path.join(prefix,'resources/glm')).catch(()=>undefined))?.isSymbolicLink())await rm(path.join(prefix,'resources/glm'),{force:true});assert.equal(path.dirname(directory),root);await rm(directory,{recursive:true,force:true});}
});
