import {createHash} from 'node:crypto';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyRuntimeDependencies} from './runtime-dependencies.mjs';

/** Written before installers are archived, so installed copies identify their actual source. */
export async function writeBuildManifest(directory,dependencies){
  const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const files=['AIROOM.exe','resources/app/package.json','resources/app/package-lock.json'];
  async function collect(relative){for(const entry of await readdir(path.join(directory,relative),{withFileTypes:true})){const file=relative+'/'+entry.name;if(entry.isDirectory())await collect(file);else files.push(file);}}
  await collect('resources/app/dist');const hashes={};
  for(const file of files)hashes[file]=createHash('sha256').update(await readFile(path.join(directory,file))).digest('hex');
  const receipt={builtAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:workspace,encoding:'utf8',windowsHide:true}).trim(),sourceDirty:!!execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:workspace,encoding:'utf8',windowsHide:true}).trim(),deployment:'pending-installation',dependencies,hashes};
  await writeFile(path.join(directory,'build-manifest.json'),JSON.stringify(receipt,null,2));return receipt;
}

// Electron Builder calls this after editing executable icons/metadata, before archiving either target.
export default async function afterSign(context){
  const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),output=path.resolve(context.appOutDir);
  if(output!==path.join(workspace,'release','win-unpacked')||context.electronPlatformName!=='win32')throw new Error('Unexpected build manifest target');
  await writeBuildManifest(output,await verifyRuntimeDependencies(path.join(output,'resources/app')));
}
