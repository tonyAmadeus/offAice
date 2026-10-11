import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Settings } from '../shared/types';
import type { NodeRuntimeInfo } from '../shared/executor-catalog';

const localVersions=new Map<string,string|undefined>();
export function nodeAtLeast(version:string,minimum:string){
  const a=version.replace(/^v/,'').split('.').map(Number),b=minimum.split('.').map(Number);
  for(let index=0;index<3;index++){if(!Number.isFinite(a[index]))return false;if(a[index]!==b[index])return a[index]>b[index];}return true;
}
function localRuntime(env:NodeJS.ProcessEnv){
  const file=env.AIROOM_LOCAL_NODE_EXE || (!process.versions.electron?env.AIROOM_NODE_EXE:undefined);
  if(!file||!existsSync(file)||!existsSync(path.join(path.dirname(file),'node_modules/npm/bin/npm-cli.js')))return;
  if(!localVersions.has(file)){
    const clean={...env};delete clean.ELECTRON_RUN_AS_NODE;
    const result=spawnSync(file,['-p','process.versions.node'],{encoding:'utf8',timeout:5000,windowsHide:true,env:clean});
    const version=result.status===0?result.stdout.trim():undefined;
    localVersions.set(file,version&&/^\d+\.\d+\.\d+$/.test(version)?version:undefined);
  }
  const version=localVersions.get(file);return version?{file,version}:undefined;
}
export function nodeRuntimeInfo(settings:Settings,env:NodeJS.ProcessEnv=process.env,minimum='26.4.0'):NodeRuntimeInfo {
  const local=localRuntime(env),requested=settings.nodeRuntime==='local';
  const suitable=!!local&&nodeAtLeast(local.version,minimum);
  return {source:requested&&suitable?'local':'bundled',version:requested&&suitable?local!.version:env.AIROOM_BUNDLED_NODE_VERSION||process.versions.node,available:true,
    ...(local?{local:{version:local.version,available:suitable,...(!suitable?{detail:`本机 Node.js 需要 ≥ ${minimum}，当前 ${local.version}；继续使用 AIROOM 自带环境。`}:{})}}:{}),
    ...(requested&&!suitable?{detail:local?`本机版本不满足要求，继续使用 AIROOM 自带环境。`:'未检测到本机 Node.js 和 npm，继续使用 AIROOM 自带环境。'}:{})};
}
/** Only child environments change. The host's Node and Electron settings are never overwritten. */
export function nodeRuntimeEnvironment(settings:Settings,base:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  const info=nodeRuntimeInfo(settings,base),local=info.source==='local'?localRuntime(base):undefined;
  const bundled=base.AIROOM_BUNDLED_NODE_EXE||process.execPath;
  return {...base,AIROOM_NODE_EXE:local?.file||bundled,AIROOM_NODE_SOURCE:info.source,AIROOM_NODE_VERSION:info.version};
}
export function npmLaunch(env:NodeJS.ProcessEnv,cwd:string){
  const node=env.AIROOM_NODE_EXE&&existsSync(env.AIROOM_NODE_EXE)?env.AIROOM_NODE_EXE:process.execPath;
  const root=env.AIROOM_APP_ROOT||process.cwd();
  const choices=env.AIROOM_NODE_SOURCE==='local'
    ?[path.join(path.dirname(node),'node_modules/npm/bin/npm-cli.js')]
    :[path.join(root,'node_modules/npm/bin/npm-cli.js'),path.join(path.dirname(node),'node_modules/npm/bin/npm-cli.js')];
  const cli=choices.find(existsSync);if(!cli)throw new Error('AIROOM 自带的 npm 组件缺失，请重新安装完整工作台。');
  const childEnv={...env};for(const key of Object.keys(childEnv))if(key.toUpperCase()==='ELECTRON_RUN_AS_NODE')delete childEnv[key];
  const electron=path.resolve(node).toLowerCase()===path.resolve(env.AIROOM_BUNDLED_NODE_EXE||process.execPath).toLowerCase()&&!!process.versions.electron;
  const directories=[path.dirname(node)];
  if(electron){
    childEnv.ELECTRON_RUN_AS_NODE='1';
    // npm's approved lifecycle scripts invoke `node`; keep this shim inside the managed staging directory.
    const bin=path.join(cwd,'.airoom-node-bin');mkdirSync(bin,{recursive:true});
    const quote=node.replaceAll('%','%%');
    writeFileSync(path.join(bin,'node.cmd'),`@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${quote}" %*\r\n`);
    directories.unshift(bin);
  }
  const pathKey=Object.keys(childEnv).find(key=>key.toLowerCase()==='path')||'PATH';
  childEnv[pathKey]=[...directories,childEnv[pathKey]].filter(Boolean).join(path.delimiter);
  return {command:node,prefix:[cli],env:childEnv};
}
