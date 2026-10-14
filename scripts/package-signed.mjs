import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {executableSignature} from './windows-signature.mjs';

const root=fileURLToPath(new URL('..',import.meta.url)),green=process.argv.includes('--green');
assert.equal(process.platform,'win32','Windows signing requires a Windows build host.');
const builderPackage=createRequire(import.meta.url).resolve('electron-builder/package.json');
const builder=path.resolve(path.dirname(builderPackage),JSON.parse(readFileSync(builderPackage,'utf8')).bin['electron-builder']);
const run=(script,args=[])=>execFileSync(process.execPath,[script,...args],{cwd:root,stdio:'inherit',windowsHide:true});
run('scripts/build.mjs');
// Refuse an unsigned distribution when no signing identity is available.
run(builder,['--win',...(green?['--dir']:['nsis','portable']),'--config','electron-builder.json','--config.forceCodeSigning=true']);
const files=[path.join(root,'release','win-unpacked','AIROOM.exe')];
if(!green){const {version}=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));files.push(path.join(root,'release',`AIROOM-Setup-${version}.exe`),path.join(root,'release',`AIROOM-${version}-Windows.exe`));}
for(const file of files)assert.equal(executableSignature(file).trusted,true,`No valid Windows signature: ${file}`);
run(green?'scripts/package-green.mjs':'scripts/package-handoff.mjs');
