/** Node launchers must hide their own helpers, including nested command checks. */
export const WINDOWS_CONSOLE_PRELOAD = String.raw`
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
if(process.platform==='win32'){
  const preload='--import='+import.meta.url;
  if(!(process.env.NODE_OPTIONS||'').includes(preload))process.env.NODE_OPTIONS=[process.env.NODE_OPTIONS,preload].filter(Boolean).join(' ');
  for(const method of ['spawn','spawnSync','execFile','execFileSync','exec','execSync','fork']){
    const original=cp[method];
    cp[method]=function(...argv){
      const index=method==='exec'||method==='execSync'?1:Array.isArray(argv[1])?2:1;
      const options=argv[index];
      if(typeof options==='function')argv.splice(index,0,{windowsHide:true});
      else argv[index]={...options,windowsHide:true};
      return original.apply(this,argv);
    };
    if(original[promisify.custom])cp[method][promisify.custom]=function(...argv){
      let child;
      const promise=new Promise((resolve,reject)=>{
        child=cp[method](...argv,(error,stdout,stderr)=>{
          if(error){Object.assign(error,{stdout,stderr});reject(error);}else resolve({stdout,stderr});
        });
      });
      promise.child=child;return promise;
    };
  }
  syncBuiltinESMExports();
}
`;
export const windowsConsoleArguments = () => process.platform==='win32'
  ? ['--import','data:text/javascript,'+encodeURIComponent(WINDOWS_CONSOLE_PRELOAD)] : [];
