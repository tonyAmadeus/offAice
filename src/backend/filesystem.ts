import {lstat,rename} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';

/** Retry an atomic rename after a short Windows sharing violation. Never copy,
 * remove a destination, or repeat the operation that produced the source. */
export async function renameWithWindowsRetry(from:string,to:string,options:{move?:(from:string,to:string)=>Promise<void>;platform?:NodeJS.Platform;replaceExisting?:boolean}={}){
  const move=options.move??rename,platform=options.platform??process.platform,waits=[50,100,200,400,750,1000,1500];
  for(let attempt=0;;attempt++){
    try{await move(from,to);return;}catch(error){
      if(platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??'')||attempt>=waits.length)throw error;
      if(!options.replaceExisting){
        const destination=await lstat(to).then(()=> 'exists',error=>(error as NodeJS.ErrnoException).code==='ENOENT'?'missing':'unknown');
        if(destination!=='missing')throw error;
      }
      await delay(waits[attempt]);
    }
  }
}
