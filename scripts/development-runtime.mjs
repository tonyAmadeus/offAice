import {spawnSync} from 'node:child_process';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** Copy runtime bytes into the normal user cache so workspace integrity labels are not inherited. */
export async function developmentRuntime(executable,cacheParent=path.join(process.env.LOCALAPPDATA??os.tmpdir(),'AIROOM','development-runtime')){
  if(process.platform!=='win32')return executable;
  const source=path.dirname(executable),version=(await readFile(path.join(source,'version'),'utf8')).trim();
  if(!/^[\w.+-]+$/.test(version))throw Error('Invalid Electron runtime version.');
  const target=path.join(cacheParent,`electron-${version}`);
  await mkdir(target,{recursive:true});
  const copied=spawnSync('robocopy.exe',[source,target,'/E','/COPY:DAT','/DCOPY:DAT','/XJ','/R:1','/W:1','/NFL','/NDL','/NJH','/NJS','/NP'],{encoding:'utf8',windowsHide:true,timeout:120000});
  if(copied.error||copied.status===null||copied.status>=8)throw Error(`Unable to prepare the development runtime: ${copied.error?.message??copied.stderr??copied.status}`);
  return path.join(target,path.basename(executable));
}
