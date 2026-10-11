/** Opt-in network acceptance: signed-out, isolated homes; never prompts a model or uses daily accounts. */
import { Engine } from '../src/backend/engine';
import { EXECUTOR_CATALOG, CATALOG_REVISION, catalogProvider } from '../src/shared/executor-catalog';
import { isolatedTestEnvironment } from './test-environment.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
delete process.env.ELECTRON_RUN_AS_NODE;
const root=process.cwd(),profile=isolatedTestEnvironment(process.env,root);
for(const key of Object.keys(process.env))if(!(key in profile.env))delete process.env[key];
Object.assign(process.env,profile.env,{AIROOM_BUNDLED_NODE_EXE:process.execPath,AIROOM_BUNDLED_NODE_VERSION:process.versions.node,AIROOM_NODE_EXE:process.execPath});
const output=path.resolve('.test-cache/executor-catalog-20261009');mkdirSync(output,{recursive:true});
const mirror=process.argv.includes('--mirror'),selected=process.argv.slice(2).filter(value=>!value.startsWith('--')),entries=selected.length?EXECUTOR_CATALOG.filter(entry=>selected.includes(entry.id)):EXECUTOR_CATALOG;
const receipt=(mirror?'mirror-':'')+(selected.length?'downloads-'+selected.join('-')+'.json':'downloads.json');
if(selected.some(id=>!entries.some(entry=>entry.id===id)))throw new Error('所选执行端已移出下载清单或不存在；没有运行下载验收。');
const engine=new Engine(profile.env.AIROOM_DATA_DIR!,()=>{},()=>{}),results:any[]=[],progress:any[]=[];
async function main(){
  console.log(JSON.stringify({profile:profile.directory,node:process.versions.node,electron:process.versions.electron,mirror}));
  if(mirror)await engine.invoke('settings.save',{settings:{npmRegistry:'npmmirror'}});
  for(const entry of entries){
    const start=Date.now();console.log('Downloading '+entry.id+' '+entry.recommendedVersion);
    const timer=setInterval(()=>void engine.invoke('catalog.installation',{id:entry.id}).then(value=>{if(value)progress.push({id:entry.id,at:new Date().toISOString(),...value});}),1500);
    try{
      const status=await engine.invoke('catalog.install',{id:entry.id,version:entry.recommendedVersion,agree:true,revision:CATALOG_REVISION});
      const info=engine.snapshot().providers.find(info=>info.id===catalogProvider(entry.id));
      results.push({id:entry.id,status,info,elapsedMs:Date.now()-start});console.log(entry.id+': '+info?.auth+' '+info?.detail);
    }catch(error){results.push({id:entry.id,error:(error as Error).message,elapsedMs:Date.now()-start});console.log(entry.id+': FAILED '+(error as Error).message);}
    finally{clearInterval(timer);writeFileSync(path.join(output,receipt),JSON.stringify({profile:profile.directory,results,progress},null,2));}
  }
  const failed=results.filter(item=>item.error||!item.info?.runtimeReady||item.info.auth!=='none');
  await engine.close();if(failed.length)process.exitCode=1;
}
void main().catch(async error=>{console.error(error);await engine.close();process.exitCode=1;});
