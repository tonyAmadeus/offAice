import { realpathSync } from 'node:fs';
import path from 'node:path';

/** Existing aliases resolve to the same folder; missing historical folders still have a stable key. */
export function folderPath(directory:string){
  let actual=path.resolve(directory);
  try{actual=realpathSync.native(actual);}catch{/* History remains readable after a folder moves or disappears. */}
  actual=path.normalize(actual);
  const root=path.parse(actual).root;
  if(actual!==root)actual=actual.replace(/[\\/]+$/,'');
  return {directory:actual,key:process.platform==='win32'?actual.toLowerCase():actual};
}
