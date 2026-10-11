import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {homedir,userInfo} from 'node:os';
import {mkdir,readFile,writeFile,rename,rm,rmdir} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fetch,ProxyAgent} from 'undici';
import {registerSecret} from './security';
import type {CatalogLoginState} from '../shared/executor-catalog';

// Protocol and credential format from zai-org/ZCode: cli-oauth.ts, coding-plan-api-key.ts,
// credential-cipher.ts and standalone-account-provider-runtime.ts. CLI 0.16.9 ignores
// `login bigmodel`, so use the official provider-aware authorization service directly.
const OAUTH='https://zcode.z.ai/api/v1/oauth/cli';
const BIGMODEL='https://bigmodel.cn';
type RequestInput={url:string;method:'GET'|'POST';headers:Record<string,string>;body?:string;signal:AbortSignal};
export type ZcodeLoginRequest=(input:RequestInput)=>Promise<{status:number;body:any}>;
const text=(value:unknown):string=>typeof value==='string'?value.trim():'';

/** Match the official child process's isolated HOME, without reading global credentials. */
export function zcodeCredentialCipher(home:string,env:NodeJS.ProcessEnv={}) {
  let username='unknown';try{username=userInfo().username;}catch{}
  const secret=env.ZCODE_CREDENTIAL_SECRET?.trim()||`zcode-credential-fallback:${process.platform}:${home||homedir()}:${username}`;
  const key=createHash('sha256').update(secret).digest();
  return {
    encrypt(value:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),bytes=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${bytes.toString('base64url')}`;},
    decrypt(value:string){
      if(!value.startsWith('enc:v1:'))return value;
      const parts=value.slice(7).split('.');if(parts.length!==3)throw new Error('ZCode 登录凭据格式无效，请重新授权。');
      const [iv,tag,bytes]=parts.map(part=>Buffer.from(part,'base64url'));
      if(iv.length!==12||tag.length!==16)throw new Error('ZCode 登录凭据格式无效，请重新授权。');
      const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);return Buffer.concat([decipher.update(bytes),decipher.final()]).toString('utf8');
    },
  };
}
async function json(file:string){try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {};throw new Error('ZCode 原有登录配置无法读取，已保留原文件。');}}
function object(value:any){return value&&typeof value==='object'&&!Array.isArray(value);}

/** Cooperate with the native writer's directory lock; never overwrite a concurrent login. */
async function updateJson(file:string,update:(value:any)=>any,signal:AbortSignal) {
  await mkdir(path.dirname(file),{recursive:true});
  const lock=file+'.lock',token=`${process.pid}-${Date.now()}-${randomUUID()}`,owner=path.join(lock,`owner-${token}.json`);
  for(let attempt=0;;attempt++){
    signal.throwIfAborted();
    try{await mkdir(lock);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(attempt>=100)throw new Error('ZCode 配置正在被其他程序写入，请稍后重试。');await delay(50,undefined,{signal});}
  }
  const temporary=path.join(path.dirname(file),`.${path.basename(file)}-${randomUUID()}.tmp`);
  try{
    await writeFile(owner,JSON.stringify({pid:process.pid,createdAt:Date.now(),token}),{flag:'wx',mode:0o600});
    const existing=await json(file);if(!object(existing))throw new Error('ZCode 原有配置格式无效，已保留原文件。');
    const next=update(existing);signal.throwIfAborted();
    await writeFile(temporary,JSON.stringify(next,null,2)+'\n',{flag:'wx',mode:0o600});
    signal.throwIfAborted();
    for(let attempt=0;;attempt++){
      try{await rename(temporary,file);break;}catch(error){if(!['EPERM','EBUSY','EACCES'].includes((error as NodeJS.ErrnoException).code??'')||attempt>=5)throw error;await delay(50*(attempt+1),undefined,{signal});}
    }
  }finally{await rm(temporary,{force:true}).catch(()=>{});await rm(owner,{force:true}).catch(()=>{});await rmdir(lock).catch(()=>{});}
}

/** Sends no model tasks. Tokens stay in memory and the native encrypted credential store. */
export async function loginZcodeBigmodel(home:string,command:string,env:NodeJS.ProcessEnv,signal:AbortSignal,progress?:(state:CatalogLoginState)=>void,injected?:ZcodeLoginRequest) {
  let authSignal=signal;
  const proxy=!injected&&env.HTTPS_PROXY?new ProxyAgent(env.HTTPS_PROXY):undefined;
  const request:ZcodeLoginRequest=injected??(async input=>{
    const response=await fetch(input.url,{method:input.method,headers:input.headers,body:input.body,dispatcher:proxy,redirect:'error',signal:AbortSignal.any([input.signal,AbortSignal.timeout(20_000)])});
    let size=0;const chunks:Buffer[]=[];
    if(response.body)for await(const chunk of response.body){size+=chunk.length;if(size>128*1024)throw new Error('ZCode 官方授权返回的数据异常。');chunks.push(Buffer.from(chunk));}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}
    return {status:response.status,body};
  });
  async function remote(url:string,headers:Record<string,string>,active:AbortSignal,body?:unknown){
    let response;try{response=await request({url,headers:{'Content-Type':'application/json',...headers},method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body),signal:active});}
    catch(error){active.throwIfAborted();if(error instanceof Error&&error.message==='ZCode 官方授权返回的数据异常。')throw error;throw new Error('ZCode 国内授权服务连接失败，请检查网络后重新登录。');}
    active.throwIfAborted();
    if(response.status===429)throw new Error('ZCode 官方授权请求过于频繁（HTTP 429），请稍后重新登录。');
    if(response.status<200||response.status>=300)throw new Error(`ZCode 国内授权服务返回 HTTP ${response.status}，请重新登录。`);
    if(!object(response.body)||![undefined,null,0,200,'0','200'].includes(response.body.code))throw new Error('ZCode 国内授权服务拒绝了本次登录，请重新授权。');
    return response.body.data;
  }
  try{
    progress?.({phase:'starting',message:'正在启动 BigModel 中国区官方授权…'});
    const pollToken=randomBytes(32).toString('hex');registerSecret(pollToken);
    const headers={Authorization:`Bearer ${pollToken}`};
    const init=await remote(OAUTH+'/init',headers,signal,{provider:'bigmodel'});
    let url:URL;try{url=new URL(init?.authorize_url);}catch{throw new Error('ZCode 官方服务没有返回有效的国内授权页面。');}
    if(url.protocol!=='https:'||url.hostname!=='bigmodel.cn'||url.pathname!=='/login'||url.username||url.password||url.port)throw new Error('ZCode 官方服务返回了与 BigModel 中国区不匹配的授权页面，已停止登录。');
    let callback:URL;try{callback=new URL(url.searchParams.get('redirect')??'');}catch{throw new Error('ZCode 国内授权回调地址无效。');}
    if(callback.origin!=='https://zcode.z.ai'||callback.pathname!=='/api/v1/oauth/cli/callback/bigmodel')throw new Error('ZCode 国内授权回调地址与所选账号不匹配。');
    if(!text(init?.flow_id)||!Number.isFinite(init?.expires_at)||!Number.isFinite(init?.poll_interval_sec)||init.poll_interval_sec<1)throw new Error('ZCode 国内授权流程信息不完整。');
    const remaining=Math.min(8*60_000,init.expires_at*1000-Date.now());if(remaining<=0)throw new Error('ZCode 官方授权链接已过期，请重新登录。');
    const active=AbortSignal.any([signal,AbortSignal.timeout(remaining)]);
    authSignal=active;
    progress?.({phase:'waiting',message:'请在 BigModel 中国区官方网页完成授权，AIROOM 会自动核对国内套餐连接。',url:url.href});
    let ready:any;
    for(;;){
      const value=await remote(OAUTH+'/poll/'+encodeURIComponent(init.flow_id),headers,active);
      if(value?.status==='ready'){ready=value;break;}
      if(value?.status==='failed')throw new Error('BigModel 中国区官方授权未完成或已拒绝，请重新登录。');
      if(value?.status!=='pending')throw new Error('ZCode 官方授权状态无效，请重新登录。');
      await delay(Math.min(init.poll_interval_sec,10)*1000,undefined,{signal:active});
    }
    const access=text(ready.bigmodel?.access_token)||text(ready.bigmodel?.accessToken),jwt=text(ready.token),identity=text(ready.user?.user_id);
    if(!access||!jwt||!identity)throw new Error('授权返回的不是完整 BigModel 中国区凭据，请重新选择国内官方登录。');
    for(const value of [access,jwt,text(ready.bigmodel?.refresh_token)||text(ready.bigmodel?.refreshToken)])if(value)registerSecret(value);
    const auth={Authorization:access},customer=await remote(BIGMODEL+'/api/biz/customer/getCustomerInfo',auth,active);
    const organizations=Array.isArray(customer?.organizations)?customer.organizations:[],org=organizations.find((item:any)=>text(item.organizationName).includes('默认机构'))??organizations[0];
    const projects=Array.isArray(org?.projects)?org.projects:[],project=projects.find((item:any)=>text(item.projectName).includes('默认项目'))??projects[0];
    if(!text(org?.organizationId)||!text(project?.projectId))throw new Error('BigModel 已授权，但未能读取账号的编程套餐配置。');
    const keyUrl=BIGMODEL+'/api/biz/v1/organization/'+encodeURIComponent(org.organizationId)+'/projects/'+encodeURIComponent(project.projectId)+'/api_keys';
    const keys=await remote(keyUrl,auth,active);if(!Array.isArray(keys))throw new Error('BigModel 套餐凭据列表格式无效。');
    const entry=keys.find((item:any)=>item.name==='zcode-api-key')??await remote(keyUrl,auth,active,{name:'zcode-api-key'});
    const apiKey=text(entry?.apiKey);if(!apiKey)throw new Error('BigModel 已授权，但未能取得官方编程套餐凭据。');registerSecret(apiKey);
    const copied=await remote(keyUrl+'/copy/'+encodeURIComponent(apiKey),auth,active),secret=text(copied?.secretKey);
    const fullKey=secret?`${apiKey}.${secret}`:apiKey;registerSecret(fullKey);if(secret)registerSecret(secret);
    const builtin=await json(path.join(path.dirname(command),'provider','zcode-builtin.json'));
    const rules=builtin?.config?.providerConfigRules?.providerRules;
    const matches=Array.isArray(rules)?rules.filter((item:any)=>item.config?.access?.type==='zhipu-account'&&item.config.access.accountType==='bigmodel'&&item.config.access.mode==='individual-coding-plan'):[];
    const rule=matches.length===1?matches[0]:undefined,model=rule?.config?.builtinModelIds?.find((item:unknown)=>text(item));
    if(!text(rule?.providerId)||!text(model))throw new Error('ZCode 官方安装缺少中国区编程套餐模型配置，请重新下载执行端。');
    const directory=path.join(home,'.zcode','v2'),cipher=zcodeCredentialCipher(home,env),provider=rule.providerId;
    const credentials:Record<string,string>={'oauth:active_provider':'bigmodel','oauth:bigmodel:access_token':access,zcodejwttoken:jwt,'oauth:bigmodel:user_info':JSON.stringify({id:identity,username:ready.user.name||identity,displayName:ready.user.name||identity,rawProfile:ready.user}),[`account-provider:${provider}:identity`]:identity,[`account-provider:coding-plan:${provider}:account:${encodeURIComponent(identity)}:api-key`]:fullKey};
    const refresh=text(ready.bigmodel?.refresh_token)||text(ready.bigmodel?.refreshToken);if(refresh)credentials['oauth:bigmodel:refresh_token']=refresh;
    const config=await json(path.join(directory,'provider_config.json'));
    if(!object(config)||config.config!==undefined&&!object(config.config))throw new Error('ZCode 原有模型配置格式无效，已保留原文件。');
    await updateJson(path.join(directory,'credentials.json'),existing=>{if(Object.values(existing).some(value=>typeof value!=='string'))throw new Error('ZCode 原有登录配置格式无效，已保留原文件。');return {...existing,...Object.fromEntries(Object.entries(credentials).map(([key,value])=>[key,cipher.encrypt(value)]))};},active);
    await updateJson(path.join(directory,'provider_config.json'),existing=>({...existing,schemaVersion:existing.schemaVersion??1,config:{...existing.config,defaultModelSelection:{providerId:provider,modelId:model}}}),active);
    active.throwIfAborted();return {provider,model};
  }catch(error){
    if(signal.aborted)throw new Error('登录已取消。');
    if(authSignal.aborted||(error as Error).name==='TimeoutError')throw new Error('BigModel 官方授权链接已过期或等待超时，请重新登录。');
    throw error;
  }finally{await proxy?.close();}
}
