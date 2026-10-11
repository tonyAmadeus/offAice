import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,lstatSync} from 'node:fs';
import {mkdir,writeFile,rename,rm,readdir,lstat,readFile,copyFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fetch,ProxyAgent} from 'undici';
import {spawnCli,type CliCommand} from './adapters/common';
import {waitForNpmOutput,UnconfirmedNpmStop,type InstallProgress} from './member-versions';

const CDN='https://cdn-zcode.z.ai/zcode/electron/releases/';
const ENTRY='resources/glm/zcode.cjs',MARKER='.airoom-install.json';
export const ZCODE_PROVIDER_CONFIG='resources/glm/provider/zcode-builtin.json';
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function completeZcodeEntry(prefix:string,version?:string):string|undefined{
  try{
    const marker=JSON.parse(readFileSync(path.join(prefix,MARKER),'utf8'));
    if(lstatSync(prefix).isSymbolicLink()||marker.schema!==3||marker.member!=='zcode'||version&&marker.version!==version||marker.entry!==ENTRY||!Array.isArray(marker.files)||!marker.files.some((item:any)=>item.path===ZCODE_PROVIDER_CONFIG))return;
    const checked=new Set<string>();
    for(const item of marker.files){
      if(typeof item.path!=='string'||!item.path.startsWith('resources/')||item.path.split('/').some((part:string)=>!part||part==='..'||part==='.')||/[\\:\0]/.test(item.path))return;
      const parts=item.path.split('/');
      for(let i=1;i<parts.length;i++){
        const folder=path.join(prefix,...parts.slice(0,i));if(checked.has(folder))continue;
        const info=lstatSync(folder);if(info.isSymbolicLink()||!info.isDirectory())return;checked.add(folder);
      }
      const file=path.join(prefix,item.path),info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size!==item.size)return;
    }
    const config=marker.files.find((item:any)=>item.path===ZCODE_PROVIDER_CONFIG);
    if(sha(readFileSync(path.join(prefix,ZCODE_PROVIDER_CONFIG)))!==config.sha256)return;
    const entry=path.join(prefix,ENTRY);if(sha(readFileSync(entry))!==marker.entrySha256)return;return entry;
  }catch{return;}
}
/** Recognize the older managed layout without changing its program path or session bindings. */
export function zcodeRepairVersion(data:string,command:string|undefined):string|undefined{
  if(!command)return;
  try{
    const prefix=path.resolve(path.dirname(command),'../..'),version=path.basename(prefix),expected=path.resolve(data,'members','zcode',version);
    if(!/^\d+\.\d+\.\d+$/.test(version)||prefix.toLowerCase()!==expected.toLowerCase()||path.resolve(command).toLowerCase()!==path.join(expected,ENTRY).toLowerCase()||completeZcodeEntry(expected,version))return;
    const marker=JSON.parse(readFileSync(path.join(expected,MARKER),'utf8'));
    if(marker.member==='zcode'&&marker.version===version&&[2,3].includes(marker.schema))return version;
  }catch{return;}
}
function dispatcher(env:NodeJS.ProcessEnv){return env.HTTPS_PROXY?new ProxyAgent(env.HTTPS_PROXY):undefined;}
export async function latestZcodeVersion(env:NodeJS.ProcessEnv):Promise<string>{
  const proxy=dispatcher(env);
  try{
    const response=await fetch('https://zcode.z.ai/en',{dispatcher:proxy,redirect:'error',signal:AbortSignal.timeout(30_000)});
    if(!response.ok)throw new Error('无法读取 ZCode 官方版本。');
    const html=await response.text(),match=html.match(/\/zcode\/electron\/releases\/(\d+\.\d+\.\d+)\/windows-x64\/ZCode-/);
    if(!match)throw new Error('官网尚未提供可识别的 Windows 发行版，请保留当前版本。');return match[1];
  }finally{await proxy?.close();}
}
export function zcodeRelease(version:string,metadata:string){
  if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('ZCode 官方发行版本号无效。');
  const name=`ZCode-${version}-win-x64.exe`,hash=metadata.match(/^sha512:\s*([A-Za-z0-9+/]{86}==)\s*$/m)?.[1];
  if(metadata.match(/^version:\s*(\S+)\s*$/m)?.[1]!==version||metadata.match(/^path:\s*(\S+)\s*$/m)?.[1]!==name||!hash)throw new Error('ZCode 官方发行校验清单无效。');
  return {name,sha512:hash,url:CDN+version+'/windows-x64/'+name};
}
export async function installZcode(root:string,version:string,env:NodeJS.ProcessEnv,progress?:(progress:InstallProgress)=>void,publish:(source:string,target:string)=>Promise<void>=rename){
  if(process.platform!=='win32'||process.arch!=='x64')throw new Error('ZCode 自动下载目前支持 Windows x64。');
  if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('ZCode 官方发行版本号无效。');
  root=path.resolve(root);const target=path.join(root,version),existing=completeZcodeEntry(target,version);
  if(existing)return {version,entry:existing};
  if(existsSync(target)&&lstatSync(target).isSymbolicLink())throw new Error('ZCode 安装目录不能是链接。');
  const stage=path.join(root,'.install-'+version+'-'+randomUUID()),proxy=dispatcher(env);await mkdir(stage);
  let preserveStage=false,retired:string|undefined;
  const command=async(program:CliCommand,args:string[],environment:NodeJS.ProcessEnv,timeout:number)=>{
    try{return await waitForNpmOutput(spawnCli(program,args,{cwd:stage,env:environment}),timeout);}
    catch(error){if(error instanceof UnconfirmedNpmStop)preserveStage=true;throw new Error('ZCode 安装检查未完成：'+(error as Error).message.replaceAll('npm','安装进程'));}
  };
  try{
    const metadata=await fetch(CDN+version+'/windows-x64/latest.yml',{dispatcher:proxy,redirect:'error',signal:AbortSignal.timeout(30_000)});
    if(!metadata.ok)throw new Error('ZCode 官方校验清单下载失败：'+metadata.status);
    const release=zcodeRelease(version,await metadata.text());
    const response=await fetch(release.url,{dispatcher:proxy,redirect:'error',signal:AbortSignal.timeout(15*60_000)});
    if(!response.ok||!response.body)throw new Error('ZCode 官方安装包下载失败：'+response.status);
    const chunks:Buffer[]=[],hash=createHash('sha512');let size=0,last=0;
    for await(const chunk of response.body){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>512*1024*1024)throw new Error('ZCode 下载包大小异常。');chunks.push(bytes);hash.update(bytes);if(Date.now()-last>1000){progress?.({phase:'installing',writtenBytes:size,lastProgressAt:new Date().toISOString()});last=Date.now();}}
    if(hash.digest('base64')!==release.sha512)throw new Error('ZCode 下载包与官方 SHA-512 不一致，未安装。');
    const archive=path.join(stage,release.name);await writeFile(archive,Buffer.concat(chunks));progress?.({phase:'files',writtenBytes:size});
    const require=createRequire(import.meta.url),seven=path.join(path.dirname(require.resolve('7zip-bin/package.json')),'win','x64','7za.exe');
    const unpack=await command({command:seven,path:seven,prefix:[]},['x',archive,'-o'+stage,'resources\\glm\\*','resources\\tools\\ripgrep\\rg.exe','resources\\config\\provider\\zcode-builtin.json','-y','-bso0','-bsp0'],env,120_000);
    if(unpack.code!==0)throw new Error('ZCode 官方 CLI 解压失败。');
    // This is an unmodified official resource. The standalone CLI resolves it next to its entry.
    const provider=path.join(stage,ZCODE_PROVIDER_CONFIG);await mkdir(path.dirname(provider),{recursive:true});
    await copyFile(path.join(stage,'resources/config/provider/zcode-builtin.json'),provider);
    const config=JSON.parse(await readFile(provider,'utf8'));if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('ZCode 官方登录配置无效。');
    const files:{path:string;size:number;sha256:string}[]=[];
    const inventory=async(directory:string):Promise<void>=>{for(const item of await readdir(directory,{withFileTypes:true})){const file=path.join(directory,item.name),info=await lstat(file);if(info.isSymbolicLink())throw new Error('ZCode 发行包含链接，未启用。');if(info.isDirectory())await inventory(file);else if(info.isFile())files.push({path:path.relative(stage,file).replaceAll('\\','/'),size:info.size,sha256:sha(await readFile(file))});else throw new Error('ZCode 发行包含异常文件。');}};
    await inventory(path.join(stage,'resources'));
    const entry=path.join(stage,ENTRY);progress?.({phase:'launch'});
    const check=await command({command:process.execPath,prefix:[entry],path:entry},['doctor','--json'],{...env,AIROOM_NODE_CHILD_MODE:'1'},30_000);
    let doctor;try{doctor=JSON.parse(check.stdout);}catch{throw new Error('ZCode 官方 CLI 没有返回有效运行信息。');}
    if(check.code!==0||doctor.cli?.name!=='zcode'||typeof doctor.cli.version!=='string')throw new Error('ZCode 官方 CLI 启动检查失败。');
    await rm(archive);
    await writeFile(path.join(stage,MARKER),JSON.stringify({schema:3,member:'zcode',version,cliVersion:doctor.cli.version,entry:ENTRY,entrySha256:sha(await readFile(entry)),source:release.url,archiveSha512:release.sha512,files}));
    if(path.dirname(stage)!==root||path.dirname(target)!==root||lstatSync(root).isSymbolicLink())throw new Error('ZCode 安装路径超出管理范围。');
    if(existsSync(target)){retired=path.join(root,'.replaced-'+version+'-'+randomUUID());await publish(target,retired);}
    try{await publish(stage,target);}catch(error){if(retired){await publish(retired,target);retired=undefined;}throw error;}
    if(retired&&path.dirname(retired)===root&&!lstatSync(retired).isSymbolicLink())await rm(retired,{recursive:true,force:true}).catch(()=>{});
    return {version,entry:path.join(target,ENTRY)};
  }finally{await proxy?.close();if(!preserveStage&&existsSync(stage)&&path.dirname(stage)===root&&!lstatSync(stage).isSymbolicLink())await rm(stage,{recursive:true,force:true});}
}
