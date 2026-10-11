import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {mkdir,open,readFile,readdir,lstat,rename,rm,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fetch,ProxyAgent} from 'undici';
import {spawnCli,type CliCommand} from './adapters/common';
import {waitForNpmOutput,UnconfirmedNpmStop,type InstallProgress} from './member-versions';

const MARKER='.airoom-install.json',ENTRY='dist-package/index.js',HOST='dist-package/node.exe';
const REQUIRED=[ENTRY,HOST,'dist-package/package.json','dist-package/node_sqlite3.node'];
const VERSION=/^\d{4}\.(?:0?[1-9]|1[0-2])\.(?:0?[1-9]|[12]\d|3[01])(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]{7,40}$/;
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function isCursorVersion(value:unknown):value is string{return typeof value==='string'&&VERSION.test(value);}
export function cursorRelease(version:string){
  if(!isCursorVersion(version))throw new Error('Cursor 官方版本号无效。');
  return {version,url:`https://downloads.cursor.com/lab/${version}/windows/x64/agent-cli-package.zip`};
}
/** Read version declarations only; never execute Cursor's system-wide installer or change PATH. */
export function cursorInstallerRelease(script:string){
  const versions=[...script.matchAll(/^\s*\$version\s*=\s*'([^'\r\n]+)'\s*$/gm)],urls=[...script.matchAll(/^\s*\$downloadUrl\s*=\s*'([^'\r\n]+)'\s*$/gm)];
  if(versions.length!==1||urls.length!==1)throw new Error('Cursor 官方安装清单格式已变化。');
  const release=cursorRelease(versions[0][1]);
  if(urls[0][1]!==`https://downloads.cursor.com/lab/${release.version}/`)throw new Error('Cursor 官方下载地址与版本不一致。');
  return release;
}
/** Validate central and local ZIP paths before extraction, including Windows aliases and link attributes. */
export function cursorArchiveFiles(bytes:Buffer):string[]{
  let end=-1;
  for(let index=bytes.length-22;index>=Math.max(0,bytes.length-65557);index--)if(bytes.readUInt32LE(index)===0x06054b50&&index+22+bytes.readUInt16LE(index+20)===bytes.length){end=index;break;}
  if(end<0||bytes.readUInt16LE(end+4)!==0||bytes.readUInt16LE(end+6)!==0)throw new Error('Cursor 下载包不是单卷 ZIP。');
  const count=bytes.readUInt16LE(end+10),length=bytes.readUInt32LE(end+12),offset=bytes.readUInt32LE(end+16);
  if(!count||count>5000||bytes.readUInt16LE(end+8)!==count||offset+length!==end)throw new Error('Cursor 下载包目录无效。');
  let at=offset,total=0;const names=new Set<string>(),files:string[]=[];
  for(let index=0;index<count;index++){
    if(at+46>end||bytes.readUInt32LE(at)!==0x02014b50)throw new Error('Cursor ZIP 文件清单损坏。');
    const flags=bytes.readUInt16LE(at+8),method=bytes.readUInt16LE(at+10),size=bytes.readUInt32LE(at+24),nameLength=bytes.readUInt16LE(at+28),extraLength=bytes.readUInt16LE(at+30),commentLength=bytes.readUInt16LE(at+32),attrs=bytes.readUInt32LE(at+38),local=bytes.readUInt32LE(at+42);
    const next=at+46+nameLength+extraLength+commentLength;
    if(next>end||local+30>offset||bytes.readUInt32LE(local)!==0x04034b50)throw new Error('Cursor ZIP 文件偏移无效。');
    const nameBytes=bytes.subarray(at+46,at+46+nameLength),name=nameBytes.toString('utf8'),directory=name.endsWith('/'),parts=name.replace(/\/$/,'').split('/');
    const localLength=bytes.readUInt16LE(local+26),localName=bytes.subarray(local+30,local+30+localLength);
    if(!nameBytes.equals(localName)||(flags&1)||![0,8].includes(method)||name.includes('\\')||parts[0]!=='dist-package'||parts.some(part=>!part||part==='.'||part==='..'||/[\x00-\x1f:]/.test(part)||/[. ]$/.test(part)||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))||((attrs>>>16)&0xf000)===0xa000)throw new Error('Cursor 下载包包含不安全路径或链接。');
    const key=name.replace(/\/$/,'').toLowerCase();if(names.has(key))throw new Error('Cursor 下载包包含重复路径。');names.add(key);
    total+=size;if(total>1024*1024*1024)throw new Error('Cursor 下载包展开后过大。');
    if(!directory)files.push(name);at=next;
  }
  if(at!==end||!REQUIRED.every(name=>files.includes(name)))throw new Error('Cursor 下载包缺少运行所需文件。');
  return files.sort();
}
// Catalog snapshots are frequent. Rehash files only when their identity/stat changes.
const hashes=new Map<string,{stamp:string;hash:string}>();
function fileHash(file:string,info:NonNullable<ReturnType<typeof lstatSync>>){
  const stamp=[info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs].join(':');
  let cached=hashes.get(file);if(cached?.stamp!==stamp){cached={stamp,hash:sha(readFileSync(file))};if(hashes.size>10_000)hashes.clear();hashes.set(file,cached);}return cached.hash;
}
export function completeCursorEntry(prefix:string,version?:string):string|undefined{
  try{
    if(lstatSync(prefix).isSymbolicLink())return;
    const marker=JSON.parse(readFileSync(path.join(prefix,MARKER),'utf8'));
    if(marker.schema!==1||marker.member!=='cursor'||!isCursorVersion(marker.version)||version&&version!==marker.version||marker.entry!==ENTRY||marker.source!==cursorRelease(marker.version).url||!/^\d+\.\d+\.\d+$/.test(marker.nodeVersion)||!Array.isArray(marker.files)||!REQUIRED.every(name=>marker.files.some((file:any)=>file.path===name)))return;
    const names=new Set<string>(),directories=new Set<string>();
    for(const file of marker.files){
      if(typeof file.path!=='string'||!file.path.startsWith('dist-package/')||file.path.includes('\\')||file.path.split('/').some((part:string)=>!part||part==='.'||part==='..'||part.includes(':'))||names.has(file.path.toLowerCase())||! /^[a-f0-9]{64}$/.test(file.sha256??''))return;
      names.add(file.path.toLowerCase());
      // Check intermediate directories as well as leaf files, so a directory junction cannot escape the version.
      let parent=prefix;for(const part of file.path.split('/').slice(0,-1)){parent=path.join(parent,part);if(!directories.has(parent)){if(lstatSync(parent).isSymbolicLink())return;directories.add(parent);}}
      const target=path.join(prefix,file.path),info=lstatSync(target);
      if(info.isSymbolicLink()||!info.isFile()||info.size!==file.size||fileHash(target,info)!==file.sha256)return;
    }
    return path.join(prefix,ENTRY);
  }catch{return;}
}
export function cursorNodeEnvironment(command:string,env:NodeJS.ProcessEnv):NodeJS.ProcessEnv{
  const node=path.join(path.dirname(command),'node.exe');
  if(!existsSync(node)||lstatSync(node).isSymbolicLink())throw new Error('Cursor 自带的 Node.js 运行环境缺失，请重新下载该版本。');
  let version='';try{version=JSON.parse(readFileSync(path.join(path.dirname(path.dirname(command)),MARKER),'utf8')).nodeVersion??'';}catch{/* Staging launch has no receipt yet. */}
  return {...env,AIROOM_NODE_EXE:node,AIROOM_NODE_SOURCE:'local',AIROOM_NODE_VERSION:version};
}
export async function latestCursorVersion(env:NodeJS.ProcessEnv){
  const proxy=env.HTTPS_PROXY?new ProxyAgent(env.HTTPS_PROXY):undefined;
  try{
    const response=await fetch('https://cursor.com/install?win32=true',{dispatcher:proxy,redirect:'error',signal:AbortSignal.timeout(30_000)});
    if(!response.ok)throw new Error('Cursor 官方版本查询失败。');
    const script=await response.text();if(script.length>256_000)throw new Error('Cursor 官方安装清单过大。');return cursorInstallerRelease(script).version;
  }finally{await proxy?.close();}
}
/** Keep Cursor's native host and addons together; install only inside AIROOM's version directory. */
export async function installCursor(root:string,version:string,env:NodeJS.ProcessEnv,progress?:(value:InstallProgress)=>void,publish:(source:string,target:string)=>Promise<void>=rename){
  if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Cursor 自动下载目前支持 Windows x64。');
  const release=cursorRelease(version);root=path.resolve(root);
  const target=path.join(root,version),existing=completeCursorEntry(target,version);if(existing)return {version,entry:existing};
  if(existsSync(target))throw new Error('这个 Cursor 版本不完整，请先核对已有文件。');
  const stage=path.join(root,'.install-'+version+'-'+randomUUID()),proxy=env.HTTPS_PROXY?new ProxyAgent(env.HTTPS_PROXY):undefined;
  await mkdir(stage);let preserve=false;
  const command=async(program:CliCommand,args:string[],environment:NodeJS.ProcessEnv,timeout:number)=>{try{return await waitForNpmOutput(spawnCli(program,args,{cwd:stage,env:environment}),timeout);}catch(error){if(error instanceof UnconfirmedNpmStop)preserve=true;throw error;}};
  try{
    const response=await fetch(release.url,{dispatcher:proxy,redirect:'error',signal:AbortSignal.timeout(15*60_000)});
    if(!response.ok||!response.body)throw new Error('Cursor 官方程序下载失败。');
    const archive=path.join(stage,'cursor.zip'),file=await open(archive,'wx'),hash=createHash('sha256');let size=0,last=0;
    try{for await(const chunk of response.body){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>512*1024*1024)throw new Error('Cursor 下载包大小异常。');await file.writeFile(bytes);hash.update(bytes);if(Date.now()-last>1000){progress?.({phase:'installing',writtenBytes:size,lastProgressAt:new Date().toISOString()});last=Date.now();}}}finally{await file.close();}
    const archiveSha256=hash.digest('hex'),files=cursorArchiveFiles(await readFile(archive));progress?.({phase:'files',writtenBytes:size});
    const require=createRequire(import.meta.url),seven=path.join(path.dirname(require.resolve('7zip-bin/package.json')),'win/x64/7za.exe');
    if((await command({command:seven,path:seven,prefix:[]},['x',archive,'-o'+stage,'-y','-bso0','-bsp0'],env,120_000)).code!==0)throw new Error('Cursor 官方程序解压失败。');
    const actual:string[]=[];
    const inventory=async(directory:string):Promise<void>=>{for(const item of await readdir(directory,{withFileTypes:true})){const file=path.join(directory,item.name),info=await lstat(file);if(info.isSymbolicLink())throw new Error('Cursor 发行包含链接，未启用。');if(info.isDirectory())await inventory(file);else if(info.isFile())actual.push(path.relative(stage,file).replaceAll('\\','/'));else throw new Error('Cursor 发行包含异常文件。');}};
    await inventory(path.join(stage,'dist-package'));if(JSON.stringify(actual.sort())!==JSON.stringify(files))throw new Error('Cursor 解压文件与清单不一致。');
    const home=path.join(stage,'.check-home'),launchEnv={...env,AIROOM_NODE_EXE:path.join(stage,HOST),HOME:home,USERPROFILE:home,CURSOR_CONFIG_DIR:path.join(home,'config'),CURSOR_DATA_DIR:path.join(home,'data'),NODE_COMPILE_CACHE:path.join(home,'cache')};
    for(const key of Object.keys(launchEnv))if(/^CURSOR_/i.test(key)&&!['CURSOR_CONFIG_DIR','CURSOR_DATA_DIR'].includes(key))delete (launchEnv as NodeJS.ProcessEnv)[key];
    await mkdir(home);const entry=path.join(stage,ENTRY),program={command:path.join(stage,HOST),path:entry,prefix:[entry]};progress?.({phase:'launch'});
    const check=await command(program,['--disable-auto-update','--version'],launchEnv,30_000),node=await command({command:program.command,path:program.command,prefix:[]},['-p','process.versions.node'],launchEnv,30_000);
    if(check.code!==0||check.stdout.trim()!==version||node.code!==0||!/^\d+\.\d+\.\d+$/.test(node.stdout.trim()))throw new Error('Cursor 官方程序启动检查失败。');
    const pkg=JSON.parse(await readFile(path.join(stage,'dist-package/package.json'),'utf8'));if(pkg.name!=='@anysphere/agent-cli-runtime')throw new Error('Cursor 官方包身份不匹配。');
    const inventoryFiles=[];for(const file of files){const bytes=await readFile(path.join(stage,file));inventoryFiles.push({path:file,size:bytes.length,sha256:sha(bytes)});}
    if(path.dirname(path.resolve(home))!==path.resolve(stage)||lstatSync(home).isSymbolicLink())throw new Error('Cursor 检查目录超出管理范围。');
    await rm(archive);await rm(home,{recursive:true,force:true});
    await writeFile(path.join(stage,MARKER),JSON.stringify({schema:1,member:'cursor',version,entry:ENTRY,source:release.url,archiveSha256,nodeVersion:node.stdout.trim(),files:inventoryFiles}));
    if(path.dirname(stage)!==root||path.dirname(target)!==root||lstatSync(root).isSymbolicLink())throw new Error('Cursor 安装路径超出管理范围。');
    await publish(stage,target);return {version,entry:path.join(target,ENTRY)};
  }finally{await proxy?.close();if(!preserve&&existsSync(stage)&&path.dirname(stage)===root&&!lstatSync(stage).isSymbolicLink())await rm(stage,{recursive:true,force:true});}
}
