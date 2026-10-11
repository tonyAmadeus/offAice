import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { fetch, ProxyAgent } from 'undici';
import { collectCommand } from './adapters/common';
import { portableNode } from './portable-node-path';

const VERSION='26.4.0',NAME=`node-v${VERSION}-win-x64`,ARCHIVE=NAME+'.zip';
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
/** Used only for the documented DSH native-loader incompatibility, never as a prerequisite for other downloads. */
export async function ensurePortableNode(data:string,env:NodeJS.ProcessEnv){
  const found=portableNode(data);if(found)return found;
  if(process.platform!=='win32'||process.arch!=='x64')throw new Error('该执行端需要标准 Node.js，本平台尚未提供经过验证的便携备用环境。');
  const root=path.resolve(data,'runtimes');await mkdir(root,{recursive:true});
  if(lstatSync(root).isSymbolicLink()||path.relative(realpathSync(data),realpathSync(root)).startsWith('..'))throw new Error('运行环境目录超出 AIROOM 管理范围。');
  const temporary=path.join(root,'.install-node-'+randomUUID()),target=path.join(root,NAME);
  if(existsSync(target))throw new Error('便携运行环境校验失败，请先核对该目录，未覆盖现有文件。');
  await mkdir(temporary);const proxy=env.HTTPS_PROXY?new ProxyAgent(env.HTTPS_PROXY):undefined;
  async function download(name:string){
    const response=await fetch(`https://nodejs.org/dist/v${VERSION}/${name}`,{dispatcher:proxy,redirect:'error',signal:AbortSignal.timeout(120_000)});
    if(!response.ok)throw new Error('Node.js 官方下载返回 '+response.status);
    const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>100*1024*1024)throw new Error('运行环境下载大小异常。');return bytes;
  }
  try{
    const sums=(await download('SHASUMS256.txt')).toString('utf8');
    const expected=sums.split(/\r?\n/).map(line=>line.trim().split(/\s+/)).find(item=>item[1]===ARCHIVE)?.[0];
    if(!expected||!/^[a-f0-9]{64}$/.test(expected))throw new Error('官方校验清单中缺少便携运行环境。');
    const bytes=await download(ARCHIVE);if(sha(bytes)!==expected)throw new Error('Node.js 便携环境哈希不匹配，未安装。');
    const archive=path.join(temporary,ARCHIVE);await writeFile(archive,bytes);
    const powershell=path.join(env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    // Paths are passed as data through the child environment; no string-built filesystem command.
    const unpack=await collectCommand({command:powershell,path:powershell,prefix:[]},['-NoProfile','-NonInteractive','-Command','Expand-Archive -LiteralPath $env:AIROOM_NODE_ARCHIVE -DestinationPath $env:AIROOM_NODE_UNPACK'],{...env,AIROOM_NODE_ARCHIVE:archive,AIROOM_NODE_UNPACK:temporary},temporary,120_000);
    if(unpack.code!==0)throw new Error('便携运行环境解压失败。');
    const directory=path.join(temporary,NAME),node=path.join(directory,'node.exe');
    const result=await collectCommand({command:node,path:node,prefix:[]},['--version'],env,temporary);
    if(result.code!==0||result.stdout.trim()!==`v${VERSION}`)throw new Error('便携运行环境不能启动。');
    await writeFile(path.join(directory,'.airoom-node.json'),JSON.stringify({version:VERSION,archiveSha256:expected,nodeSha256:sha(readFileSync(node)),source:`https://nodejs.org/dist/v${VERSION}/${ARCHIVE}`}));
    for(let attempt=0;;attempt++){
      try{await rename(directory,target);break;}
      catch(error){if(attempt>=12||!['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??''))throw error;await new Promise(resolve=>setTimeout(resolve,250));}
    }
    return path.join(target,'node.exe');
  }finally{
    await proxy?.close();
    if(path.dirname(temporary)===root&&!lstatSync(temporary).isSymbolicLink())await rm(temporary,{recursive:true,force:true});
  }
}
