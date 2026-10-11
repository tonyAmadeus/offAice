import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fetch,ProxyAgent} from 'undici';
import {spawnCli,type CliCommand} from './adapters/common';
import {waitForNpmOutput,UnconfirmedNpmStop,type InstallProgress} from './member-versions';

export type QoderEdition='qoder'|'qodercn';
const DISTRIBUTIONS={qoder:{origin:'https://qoder-ide.oss-accelerate.aliyuncs.com/qodercli',entry:'qodercli.exe'},qodercn:{origin:'https://static.qoder.com.cn/qoder-cli-cn',entry:'qoderclicn.exe'}};
const MARKER='.airoom-install.json';
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function qoderRelease(version:string,metadata:unknown,edition:QoderEdition='qoder'){
  const {origin,entry}=DISTRIBUTIONS[edition];
  if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Qoder 官方版本号无效。');
  const value=metadata as any,url=`${origin}/releases/${version}/${entry.slice(0,-4)}-windows-x64.zip`;
  const file=value?.files?.find((item:any)=>item.os==='windows'&&item.arch==='amd64'&&item.variant==='standard');
  if(value?.latest!==version||file?.url!==url||! /^[a-f0-9]{64}$/.test(file?.sha256??''))throw new Error('Qoder 官方发行校验清单无效。');
  return {url,sha256:String(file.sha256)};
}
export function completeQoderEntry(prefix:string,version?:string,edition:QoderEdition='qoder'):string|undefined{
  const ENTRY=DISTRIBUTIONS[edition].entry;
  try{
    const marker=JSON.parse(readFileSync(path.join(prefix,MARKER),'utf8')),entry=path.join(prefix,ENTRY),info=lstatSync(entry);
    if(lstatSync(prefix).isSymbolicLink()||marker.schema!==1||marker.member!==edition||version&&marker.version!==version||marker.entry!==ENTRY||info.isSymbolicLink()||!info.isFile()||info.size!==marker.entrySize||sha(readFileSync(entry))!==marker.entrySha256)return;
    return entry;
  }catch{return;}
}
export async function latestQoderVersion(env:NodeJS.ProcessEnv,edition:QoderEdition='qoder'){
  const ORIGIN=DISTRIBUTIONS[edition].origin;
  const proxy=env.HTTPS_PROXY?new ProxyAgent(env.HTTPS_PROXY):undefined;
  try{const response=await fetch(ORIGIN+'/channels/manifest.json',{dispatcher:proxy,redirect:'error',signal:AbortSignal.timeout(30_000)});if(!response.ok)throw new Error('Qoder 官方版本查询失败。');const metadata:any=await response.json();qoderRelease(metadata.latest,metadata,edition);return String(metadata.latest);}finally{await proxy?.close();}
}
/** Download the official native executable without running its system-wide installer. */
export async function installQoder(root:string,version:string,env:NodeJS.ProcessEnv,progress?:(value:InstallProgress)=>void,publish:(source:string,target:string)=>Promise<void>=rename,edition:QoderEdition='qoder'){
  const {origin:ORIGIN,entry:ENTRY}=DISTRIBUTIONS[edition];
  if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Qoder 自动下载目前支持 Windows x64。');
  if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Qoder 官方版本号无效。');
  root=path.resolve(root);const target=path.join(root,version),existing=completeQoderEntry(target,version,edition);
  if(existing)return {version,entry:existing};
  if(existsSync(target))throw new Error('这个 Qoder 版本不完整，请先核对已有文件。');
  const stage=path.join(root,'.install-'+version+'-'+randomUUID()),proxy=env.HTTPS_PROXY?new ProxyAgent(env.HTTPS_PROXY):undefined;
  await mkdir(stage);let preserve=false;
  const command=async(program:CliCommand,args:string[],timeout:number)=>{try{return await waitForNpmOutput(spawnCli(program,args,{cwd:stage,env}),timeout);}catch(error){if(error instanceof UnconfirmedNpmStop)preserve=true;throw error;}};
  try{
    const metadata=await fetch(`${ORIGIN}/channels/${version}/manifest.json`,{dispatcher:proxy,redirect:'error',signal:AbortSignal.timeout(30_000)});
    if(!metadata.ok)throw new Error('Qoder 官方校验清单下载失败。');const release=qoderRelease(version,await metadata.json(),edition);
    const response=await fetch(release.url,{dispatcher:proxy,redirect:'error',signal:AbortSignal.timeout(15*60_000)});
    if(!response.ok||!response.body)throw new Error('Qoder 官方程序下载失败。');
    const chunks:Buffer[]=[],hash=createHash('sha256');let size=0,last=0;
    for await(const chunk of response.body){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>512*1024*1024)throw new Error('Qoder 下载包大小异常。');chunks.push(bytes);hash.update(bytes);if(Date.now()-last>1000){progress?.({phase:'installing',writtenBytes:size,lastProgressAt:new Date().toISOString()});last=Date.now();}}
    if(hash.digest('hex')!==release.sha256)throw new Error('Qoder 下载包与官方 SHA-256 不一致，未安装。');
    const archive=path.join(stage,'qoder.zip');await writeFile(archive,Buffer.concat(chunks));progress?.({phase:'files',writtenBytes:size});
    const require=createRequire(import.meta.url),seven=path.join(path.dirname(require.resolve('7zip-bin/package.json')),'win/x64/7za.exe');
    if((await command({command:seven,path:seven,prefix:[]},['x',archive,'-o'+stage,ENTRY,'-y','-bso0','-bsp0'],120_000)).code!==0)throw new Error('Qoder 官方程序解压失败。');
    const entry=path.join(stage,ENTRY);progress?.({phase:'launch'});
    const check=await command({command:entry,path:entry,prefix:[]},['--version'],30_000);
    if(check.code!==0||check.stdout.trim()!==version)throw new Error('Qoder 官方程序启动检查失败。');
    const bytes=readFileSync(entry);await rm(archive);await writeFile(path.join(stage,MARKER),JSON.stringify({schema:1,member:edition,version,entry:ENTRY,entrySize:bytes.length,entrySha256:sha(bytes),source:release.url,archiveSha256:release.sha256}));
    if(path.dirname(stage)!==root||path.dirname(target)!==root||lstatSync(root).isSymbolicLink())throw new Error('Qoder 安装路径超出管理范围。');
    await publish(stage,target);return {version,entry:path.join(target,ENTRY)};
  }finally{await proxy?.close();if(!preserve&&existsSync(stage)&&path.dirname(stage)===root&&!lstatSync(stage).isSymbolicLink())await rm(stage,{recursive:true,force:true});}
}
