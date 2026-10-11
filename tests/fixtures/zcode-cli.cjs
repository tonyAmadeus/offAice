const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto'),args=process.argv.slice(2),home=process.env.ZCODE_DATA_BASE_DIR;
if(!home||home!==process.env.HOME||home!==process.env.USERPROFILE)process.exit(91);
if(process.env.ZAI_API_KEY||process.env.OPENAI_API_KEY||process.env.ZCODE_HOST_MARKER)process.exit(92);
const json=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return {};}};
const defaultSelection=()=>json(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE||path.join(home,'.zcode/v2/provider_config.json')).config?.defaultModelSelection;
const saved=id=>path.join(home,'fixture-session-'+id+'.json');
if(args[0]==='doctor'){console.log(JSON.stringify({cli:{name:'zcode',version:'0.16.9'}}));process.exit(0);}
if(args[0]==='login'){
 const account=args[1];if(account!=='zai'||!args.includes('--no-browser'))process.exit(93);
 const folder=path.join(home,'.zcode/v2'),provider='account:'+account+'-individual-coding-plan';fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'credentials.json'),JSON.stringify({['oauth:'+account+':access_token']:'fixture-only-not-a-real-token',zcodejwttoken:'fixture-jwt',['account-provider:'+provider+':identity']:'fixture-user',['account-provider:coding-plan:'+provider+':account:fixture-user:api-key']:'fixture-api-key'}));
 fs.writeFileSync(path.join(folder,'provider_config.json'),JSON.stringify({schemaVersion:1,config:{defaultModelSelection:{providerId:provider,modelId:'fixture-'+account}}}));
 fs.appendFileSync(path.join(home,'login-calls.jsonl'),JSON.stringify({args})+'\n');console.log(JSON.stringify({success:true}));process.exit(0);
}
if(args[0]==='app-server'){
 const readline=require('node:readline'),sessions=new Map();let overlay;
 const output=value=>process.stdout.write(JSON.stringify(value)+'\n');
 const state=id=>{
  const selection=sessions.get(id),control=json(path.join(home,'control.json')),rules=json(process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).config.providerConfigRules.providerRules;
  const available=control.noModels?[]:rules.filter(rule=>overlay?.providers?.[rule.providerId]?.access.entitled).flatMap(rule=>rule.config.builtinModelIds.map(modelId=>({ref:{providerId:rule.providerId,modelId},label:modelId,reasoning:control.noEffort?undefined:{levels:[{value:'low'},{value:'high'}],defaultLevel:'high'}})));
  return {protocol:{name:'ZCode Protocol',version:1},session:{sessionId:control.wrongSession?'foreign-session':id},settings:{model:{current:selection,available}}};
 };
 const input=readline.createInterface({input:process.stdin});input.on('line',line=>{
  const message=JSON.parse(line),p=message.params||{},control=json(path.join(home,'control.json'));if(!message.method)return;
  fs.appendFileSync(path.join(home,'model-control-calls.jsonl'),JSON.stringify({method:message.method,params:p})+'\n');
  try{
   let result;
   if(control.waitForControl&&message.method==='session/create')return;
   switch(message.method){
    case 'provider/updateAccountConfig':if(control.overlayFailure)throw new Error('fixture overlay unavailable');overlay=p;result={status:'received'};break;
    case 'session/create':{const id='scratch_'+randomUUID(),selection={...defaultSelection()};if(!control.noEffort)selection.options={reasoningLevel:'high'};sessions.set(id,selection);result=state(id);break;}
    case 'session/resume':if(!fs.existsSync(saved(p.sessionId)))throw new Error('Session not found');sessions.set(p.sessionId,json(saved(p.sessionId)));result=state(p.sessionId);break;
    case 'session/setModel':if(control.rejectModel)throw new Error('Model switch rejected');if(!control.setMismatch)sessions.set(p.sessionId,p.model);if(fs.existsSync(saved(p.sessionId))&&!control.persistenceFailure)fs.writeFileSync(saved(p.sessionId),JSON.stringify(sessions.get(p.sessionId)));result=state(p.sessionId);break;
    case 'session/close':sessions.delete(p.sessionId);result={closed:true};break;
    default:throw new Error('unsupported fixture method '+message.method);
   }
   output({id:message.id,result});
  }catch(error){output({id:message.id,error:{code:-32004,message:error.message}});}
 });input.on('close',()=>process.exit(0));return;
}
if(!args.includes('--output-format')||args[args.indexOf('--output-format')+1]!=='stream-json')process.exit(94);
fs.appendFileSync(path.join(home,'calls.jsonl'),JSON.stringify({args,cwd:process.cwd(),home,personalFile:process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE})+'\n');
const prompt=args[args.indexOf('-p')+1],id=args.includes('--resume')?args[args.indexOf('--resume')+1]:'sess_fixture',selection=args.includes('--resume')?json(saved(id)):defaultSelection();
fs.writeFileSync(saved(id),JSON.stringify(selection));
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
if(!prompt.includes('no-model-report'))emit({type:'session.updated',sessionId:id,turnId:'turn_fixture',payload:{providerId:selection.providerId,modelId:prompt.includes('wrong-model-report')?'wrong-model':selection.modelId,messageCount:1,iteration:0}});
emit({type:'model.streaming',sessionId:id,turnId:'turn_fixture',payload:{kind:'text_delta',delta:'生成中的内容不会重复显示'}});
if(prompt.includes('quota-')){process.stderr.write("ProviderBusinessError: [1113][Insufficient balance or no resource package.]\n providerCode: '1113',\n responseStatus: 429,\n 'set-cookie': 'session=quota-cookie-secret;HttpOnly;Max-Age=1800',\n authorization: 'Bearer fixture-authorization-secret'\n");if(prompt.includes('quota-long'))process.stderr.write('header-padding'.repeat(2500));if(prompt.includes('quota-no-final')||prompt.includes('quota-long')){process.stdout.write('incomplete');process.exit(1);}}
if(prompt.includes('no-final')){process.stdout.write('incomplete');process.exit(0);}
if(prompt.includes('wait-for-stop')){setInterval(()=>{},1000);return;}
const result={type:'result',sessionId:id,turnId:'turn_fixture',response:'完整回复只出现一次',projection:{status:prompt.includes('native-failure')||prompt.includes('quota-final')?'error':'idle'},usage:{totalTokens:42}};
const output=JSON.stringify(result),mid=Math.floor(output.length/2);process.stdout.write(output.slice(0,mid));setTimeout(()=>{process.stdout.write(output.slice(mid)+'\n');},20);
