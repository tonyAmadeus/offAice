import path from 'node:path';
import {mkdir,realpath,unlink} from 'node:fs/promises';
import type {AcpExecutor,Settings} from '../shared/types';
import {isAcpId} from '../shared/defaults';
import {getCodexBrowserLoginLaunch} from './adapters/codex';
import {getClaudeLoginLaunch} from './adapters/claude';
import {DshAdapter} from './adapters/dsh';
import {prepareCliLaunch} from './adapters/common';
import {spawnOwned,stopOwned} from './process-supervisor';
import {resolveAcpProgram} from './adapters/acp';
import {managedCatalogEnvironment} from './executor-catalog';

/** Deletes only the OAuth grant in the managed home; sessions and settings are retained. */
export async function clearManagedOAuth(home:string,kind:'gemini'|'qwen'){
  const directory=path.join(home,'.'+kind);
  let parent:string;
  try{parent=await realpath(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  const root=await realpath(home),relative=path.relative(root,parent);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('账号目录指向管理范围之外，未删除登录资料。');
  await unlink(path.join(directory,'oauth_creds.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});
}

/** Uses each official logout entry in AIROOM's own profile, without any model request. */
export async function logoutProvider(provider:string,settings:Settings,base:NodeJS.ProcessEnv,executor?:AcpExecutor){
  let launch:{command:string;args:string[];env:NodeJS.ProcessEnv;cwd?:string};
  if(provider==='codex'||provider==='claude'){
    const login=provider==='codex'?getCodexBrowserLoginLaunch(settings,base):getClaudeLoginLaunch(settings,base);
    launch={...login,args:[...login.args.slice(0,-1),'logout']};
  }else if(provider==='dsh')launch=await new DshAdapter().accountLaunch(settings,base,'logout');
  else if(isAcpId(provider)&&executor?.catalogId){
    if(!base.AIROOM_ACP_HOME||!path.isAbsolute(base.AIROOM_ACP_HOME))throw new Error('独立账号目录尚未准备好。');
    const home=path.join(base.AIROOM_ACP_HOME,executor.id);await mkdir(home,{recursive:true});
    if(executor.catalogId==='gemini'||executor.catalogId==='qwen'){await clearManagedOAuth(home,executor.catalogId);return;}
    const env=managedCatalogEnvironment(executor,base,home),program=resolveAcpProgram(executor.command,env);
    if(executor.catalogId==='zcode')env.ZCODE_DATA_BASE_DIR=home;
    const args=executor.catalogId==='cursor'?['--disable-auto-update','logout']:['logout'];
    launch={...prepareCliLaunch({command:program.script?process.execPath:program.file,prefix:program.script?[program.file]:[],path:program.file},args,env),cwd:home};
  }else throw new Error('手动 ACP 连接没有统一登出协议，请使用该程序的官方登出入口。');
  await new Promise<void>((resolve,reject)=>{
    const child=spawnOwned(launch.command,launch.args,{env:launch.env,cwd:launch.cwd??base.AIROOM_APP_ROOT??process.cwd()});
    child.stdout?.resume();child.stderr?.resume();
    const timer=setTimeout(()=>{void stopOwned(child,1500).catch(()=>{});reject(new Error('官方登出等待超时，请检查后重试。'));},30_000);
    child.once('error',()=>{clearTimeout(timer);reject(new Error('官方登出程序未能启动，请检查程序路径。'));});
    child.once('close',code=>{clearTimeout(timer);if(code===0)resolve();else reject(new Error('官方程序未确认登出，请检查连接和程序版本后重试。'));});
  });
}
