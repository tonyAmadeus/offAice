/** Opt-in official-network acceptance. Uses a signed-out profile and never sends a model prompt. */
import './test-bootstrap.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {Engine} from '../src/backend/engine';
import {AcpAdapter} from '../src/backend/adapters/acp';
import {latestCursorVersion} from '../src/backend/cursor-install';
import {catalogCandidate} from '../src/backend/executor-catalog';
import {catalogEntry,CATALOG_REVISION,type CatalogStatus} from '../src/shared/executor-catalog';
import {buildEnvironment} from '../src/backend/security';

const output=path.resolve('.test-cache/cursor-cli-smoke'),engine=new Engine(process.env.AIROOM_DATA_DIR!,()=>{},()=>{}),receipt:any={startedAt:new Date().toISOString(),realAccountUsed:false,modelPrompts:0};
await mkdir(output,{recursive:true});
try{
  const env=buildEnvironment(engine.settings),version=await latestCursorVersion(env);receipt.latestVersion=version;
  assert.equal(version,catalogEntry('cursor').recommendedVersion,'Review a new official version before changing the baseline.');
  let start=Date.now();const status=await engine.invoke('catalog.install',{id:'cursor',version,agree:true,revision:CATALOG_REVISION}) as CatalogStatus;
  receipt.installMs=Date.now()-start;receipt.selectedVersion=status.selectedVersion;
  const info=engine.snapshot().providers.find(item=>item.id==='acp-catalogcursor');assert.equal(info?.runtimeReady,true);assert.equal(info?.auth,'none');receipt.provider=info;
  const marker=JSON.parse(await readFile(path.join(path.dirname(path.dirname(status.selectedPath!)),'.airoom-install.json'),'utf8'));
  receipt.package={source:marker.source,archiveSha256:marker.archiveSha256,nodeVersion:marker.nodeVersion,fileCount:marker.files.length};
  start=Date.now();for(let index=0;index<10;index++)await engine.invoke('catalog.list');receipt.averageCatalogListMs=(Date.now()-start)/10;
  const adapter=new AcpAdapter(catalogCandidate('cursor',status.selectedPath!));let urlFound=false;
  const timer=setTimeout(()=>void adapter.stop(),30_000);
  try{
    await adapter.authenticate(env,'cursor_login',state=>{if(state.url&&!urlFound){urlFound=true;const url=new URL(state.url);receipt.loginPage=url.origin+url.pathname;void adapter.stop();}});
    assert.fail('The signed-out smoke must cancel before completing account login.');
  }catch(error){if(!urlFound)throw error;receipt.loginCancelled=true;}
  finally{clearTimeout(timer);await adapter.dispose();}
  assert.equal(urlFound,true);assert.equal(engine.store.list('runs').length,0);receipt.passed=true;
}catch(error){receipt.passed=false;receipt.error=(error as Error).message;process.exitCode=1;}
finally{receipt.completedAt=new Date().toISOString();await engine.close();await writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));}
