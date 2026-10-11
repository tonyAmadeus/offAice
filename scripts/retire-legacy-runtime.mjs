import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const user=process.env.USERPROFILE,legacy=path.join(user,'.airoom'),desktop=path.join(user,'AIROOM');
const receipt=JSON.parse(await fs.readFile(path.join(desktop,'deployment-receipt.json'),'utf8').then(text=>text.replace(/^\uFEFF/,'')));
if(path.resolve(receipt.target)!==desktop||path.resolve(receipt.dataDirectory)!==path.join(legacy,'data'))throw new Error('Desktop installation has not verified the existing daily profile.');
const manifest=JSON.parse(await fs.readFile(path.join(desktop,'build-manifest.json'),'utf8').then(text=>text.replace(/^\uFEFF/,'')));
for(const [relative,expected] of Object.entries(manifest.hashes)){const file=path.resolve(desktop,relative);if(!file.startsWith(desktop+path.sep)||createHash('sha256').update(await fs.readFile(file)).digest('hex')!==expected)throw new Error('Desktop runtime validation failed.');}
const db=new DatabaseSync(path.join(legacy,'data','airoom.sqlite'),{readOnly:true});let settings;try{settings=db.prepare("SELECT value FROM entities WHERE entity IN ('settings','executors','sessions')").all().map(row=>JSON.parse(row.value));}finally{db.close();}
const referenced=JSON.stringify(settings).toLowerCase().replaceAll('\\\\','\\');
if(referenced.includes(path.join(legacy,'resources').toLowerCase()))throw new Error('An executor still references the old program resources; keep them until explicitly migrated.');
const electron=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../node_modules/electron/dist');
const allowed=new Set(['AIROOM.exe','build-manifest.json','deployment-receipt.json','LICENSE.electron.txt','resources',...(await fs.readdir(electron)).filter(n=>!['electron.exe'].includes(n))]);
const candidates=(await fs.readdir(legacy)).filter(n=>allowed.has(n));
const retainedArg=process.argv.indexOf('--retained-copy');
const retired=retainedArg>=0?path.resolve(process.argv[retainedArg+1]):path.join(user,'.airoom-retired-'+new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date()));
if(path.dirname(retired)!==path.resolve(user)||!path.basename(retired).startsWith('.airoom-retired-'))throw new Error('Invalid retained copy path.');
if(retainedArg>=0&&!await fs.stat(path.join(retired,'data','airoom.sqlite')).then(info=>info.isFile()).catch(()=>false))throw new Error('Retained full data copy is missing.');
if(!process.argv.includes('--execute')){console.log(JSON.stringify({legacy,retired,candidates,dataRetained:path.join(legacy,'data'),note:'Preview only. The desktop already uses this daily data path; it will stay in place to preserve executor and login identities.'},null,2));}
else{
  const count=execFileSync('powershell.exe',['-NoProfile','-Command',"@(Get-CimInstance Win32_Process -Filter \"Name='AIROOM.exe'\").Count"],{encoding:'utf8',windowsHide:true}).trim();if(count!=='0')throw new Error('Quit AIROOM normally before retiring its old runtime.');
  for(const target of [legacy,desktop])if((await fs.lstat(target)).isSymbolicLink())throw new Error('Runtime roots must not be directory links.');
  await fs.mkdir(retired,{recursive:true});
  const removed=[],record={at:new Date().toISOString(),desktop,sourceCommit:receipt.sourceCommit,candidates,removed,dataDirectory:path.join(legacy,'data'),dataMoved:false,reason:'The verified desktop already shares the daily data; preserve its absolute paths. Only allowlisted legacy program files are removed.'};
  await fs.writeFile(path.join(retired,'retirement.json'),JSON.stringify(record,null,2));
  try{for(const name of candidates){const from=path.resolve(legacy,name);if(path.dirname(from)!==legacy||name==='data')throw new Error('Unsafe retirement path.');await fs.rm(from,{recursive:true,force:true,maxRetries:20,retryDelay:100});removed.push(name);}}
  finally{await fs.writeFile(path.join(retired,'retirement.json'),JSON.stringify(record,null,2));}
  console.log(JSON.stringify({retired,programEntriesRemoved:removed.length,dataDirectory:path.join(legacy,'data')},null,2));
}
