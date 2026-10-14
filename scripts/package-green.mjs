import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,readdir,lstat,mkdir,mkdtemp,access,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {verifyRuntimeDependencies} from './runtime-dependencies.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.join(root,'release','win-unpacked');
const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const archive=path.join(root,'release',`AIROOM-${version}-Windows-x64-Green.zip`);
try{await access(archive);throw new Error('Green archive already exists; preserve or explicitly retire it before rebuilding.');}catch(error){if(error.code!=='ENOENT')throw error;}
const manifest=JSON.parse(await readFile(path.join(source,'build-manifest.json'),'utf8'));
assert.equal(manifest.sourceDirty,false,'Build tracked changes must be committed before distribution.');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const [relative,hash] of Object.entries(manifest.hashes)){
  const file=path.resolve(source,relative);
  assert.ok(file.startsWith(source+path.sep),'Manifest escaped runtime root.');
  assert.equal(digest(await readFile(file)),hash,`Build hash mismatch: ${relative}`);
}
const dependencies=await verifyRuntimeDependencies(path.join(source,'resources','app'));
const expectedRoot=new Set((await readdir(path.join(root,'node_modules','electron','dist'))).filter(name=>!['electron.exe','resources'].includes(name)));
for(const name of ['AIROOM.exe','resources','build-manifest.json','使用说明.txt','LICENSE.electron.txt'])expectedRoot.add(name);
const guide=`AIROOM ${version} · Windows x64 免安装版\r\n\r\n`+
  '1. 完整解压本压缩包到一个文件夹，不要在压缩包内直接运行。\r\n'+
  '2. 双击 AIROOM.exe。无需安装 Node.js、npm 或开发工具。\r\n'+
  '3. 首次打开时人物卡和执行端连接为空；在“设置与连接”中下载或手动配置需要的程序，用自己的账号登录，再自行添加人物卡。下载和使用成员需要联网。\r\n'+
  '4. 关闭窗口会缩到托盘；需要彻底退出时，请在托盘菜单选择退出。\r\n\r\n'+
  '本包只包含程序和必要运行依赖，不包含开发者的账号、密钥、聊天记录、工作副本或测试数据。\r\n'+
  '聊天记录、人物配置和成员登录资料默认保存在 %USERPROFILE%\\.airoom\\data。\r\n'+
  '同一 Windows 账号下，本程序与安装版共用资料；同时打开会唤起已有窗口。\r\n'+
  '备份与恢复可在“设置与连接 → 工作台 → 备份”中操作。\r\n'+
  '移除免安装版时，退出程序后删除解压文件夹即可；用户目录中的资料保留。\r\n\r\n'+
  '适用系统：Windows 10 / 11，x64。\r\n'+
  (manifest.windowsSignature?.trusted?'Windows 已校验程序的代码签名；首次下载仍可能需要建立 SmartScreen 信誉。\r\n':'当前构建未通过 Windows 受信任代码签名校验，首次下载可能显示“Windows 已保护你的电脑”或“未知发布者”。\r\n');
await writeFile(path.join(source,'使用说明.txt'),'\uFEFF'+guide,'utf8');
for(const name of await readdir(source))assert.ok(expectedRoot.has(name),`Unexpected runtime root entry: ${name}`);
assert.deepEqual((await readdir(path.join(source,'resources'))).sort(),['app']);
assert.deepEqual((await readdir(path.join(source,'resources','app'))).sort(),['dist','node_modules','package-lock.json','package.json']);
const inventory=[];
async function inspect(relative=''){
  for(const name of await readdir(path.join(source,relative))){
    const next=path.join(relative,name),info=await lstat(path.join(source,next));
    assert.ok(!info.isSymbolicLink(),`Distribution contains a link: ${next}`);
    assert.ok(!/(?:^\.env(?:\.|$)|\.sqlite(?:-|$)|\.secret$|\.lnk$|^auth\.json$|^credentials\.json$|\.log$|^Uninstall )/i.test(name),`Non-distribution file: ${next}`);
    assert.ok(!(next.startsWith('resources'+path.sep+'app'+path.sep+'dist'+path.sep)&&name.endsWith('.map')),`Development source map: ${next}`);
    if(info.isDirectory())await inspect(next);
    else{assert.ok(info.isFile(),`Unsupported distribution entry: ${next}`);inventory.push({path:next.replaceAll('\\','/'),bytes:info.size,sha256:digest(await readFile(path.join(source,next)))});}
  }
}
await inspect();
const require=createRequire(import.meta.url),{path7za}=require('7zip-bin');
const run=args=>execFileSync(path7za,args,{cwd:source,windowsHide:true,timeout:600000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']});
console.log(`Packing ${inventory.length} clean files (${(inventory.reduce((sum,item)=>sum+item.bytes,0)/1024/1024).toFixed(1)} MiB)…`);
run(['a','-tzip','-mx=7','-mmt=4',archive,'.']);
run(['t',archive]);
// Workspace files may inherit a low-integrity label from an agent sandbox.
// ZIP does not carry Windows ACLs; validate normal extraction outside that workspace.
const verificationParent=process.env.AIROOM_DESKTOP_RUNTIME_PARENT??path.join(process.env.LOCALAPPDATA,'Temp');await mkdir(verificationParent,{recursive:true});
const verificationDirectory=await mkdtemp(path.join(verificationParent,'AIROOM-绿色解压试用-'));
const verificationTool=path.join(verificationDirectory,'7za.exe');
// Copy bytes only: launching the workspace's low-labelled 7za would also be low.
await copyFile(path7za,verificationTool);
const extracted=path.join(verificationDirectory,'AIROOM');
execFileSync(verificationTool,['x',archive,'-o'+extracted,'-y'],{windowsHide:true,timeout:600000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']});
for(const item of inventory)assert.equal(digest(await readFile(path.join(extracted,item.path))),item.sha256,`Extracted file mismatch: ${item.path}`);
await verifyRuntimeDependencies(path.join(extracted,'resources','app'));
const receipt={builtAt:new Date().toISOString(),version,sourceCommit:manifest.sourceCommit,sourceDirty:false,archive,archiveBytes:(await lstat(archive)).size,archiveSha256:digest(await readFile(archive)),fileCount:inventory.length,uncompressedBytes:inventory.reduce((sum,item)=>sum+item.bytes,0),dependencies,privacy:'fresh staging; only application and production dependencies; no user profile or acquired CLI copied',archiveIntegrity:'passed',extractedFilesVerified:inventory.length,extracted,desktopAcceptance:'pending',modelCalls:0};
receipt.windowsSignature=manifest.windowsSignature??{status:'unverified',trusted:false};
await writeFile(path.join(root,'release','green-receipt.json'),JSON.stringify(receipt,null,2));
await writeFile(archive+'.sha256',`${receipt.archiveSha256}  ${path.basename(archive)}\r\n`);
console.log(JSON.stringify(receipt,null,2));
