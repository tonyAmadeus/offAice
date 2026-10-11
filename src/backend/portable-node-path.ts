import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
/** A receipt alone cannot make an altered executable trusted. */
export function portableNode(data:string){
  const directory=path.join(data,'runtimes','node-v26.4.0-win-x64'),file=path.join(directory,'node.exe');
  try{const marker=JSON.parse(readFileSync(path.join(directory,'.airoom-node.json'),'utf8'));if(marker.version==='26.4.0'&&/^[a-f0-9]{64}$/.test(marker.archiveSha256)&&createHash('sha256').update(readFileSync(file)).digest('hex')===marker.nodeSha256)return file;}catch{}
}
