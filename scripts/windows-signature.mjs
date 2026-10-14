import {execFileSync} from 'node:child_process';
import path from 'node:path';

/** Read the Windows trust result without altering the machine's trust settings. */
export function executableSignature(file){
  if(process.platform!=='win32')return {status:'unverified',trusted:false};
  const command=`$ErrorActionPreference='Stop'
$signature=Get-AuthenticodeSignature -LiteralPath $env:AIROOM_SIGNATURE_FILE
[pscustomobject]@{status=$signature.Status.ToString();trusted=($signature.Status -eq 'Valid')} | ConvertTo-Json -Compress`;
  const shell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const env={...process.env,AIROOM_SIGNATURE_FILE:path.resolve(file)};
  // A build started in PowerShell 7 otherwise points Windows PowerShell at incompatible modules.
  for(const key of Object.keys(env))if(/^PSModulePath$/i.test(key))delete env[key];
  return JSON.parse(execFileSync(shell,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true,timeout:30000,env}).trim().replace(/^\uFEFF/,''));
}
