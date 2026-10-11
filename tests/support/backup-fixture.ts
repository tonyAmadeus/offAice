import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupDirectory } from '../../src/backend/backup-restore';
import type { BackupManifest, BackupReason } from '../../src/shared/backup';

/** Contract fixture, only used in temporary test directories while R1 is supplied
 * by Claudia. This is never the production backup implementation. */
export async function fixtureBackup(dataDirectory:string,reason:BackupReason){
  const id=`${new Date().toISOString().replaceAll(':','-')}-${reason}-${randomUUID().slice(0,8)}`,directory=path.join(backupDirectory(dataDirectory),id);await mkdir(directory,{recursive:true});
  const db=new DatabaseSync(path.join(dataDirectory,'airoom.sqlite'),{readOnly:true});
  let counts:BackupManifest['counts'];
  try{
    db.exec(`VACUUM INTO '${path.join(directory,'airoom.sqlite').replaceAll("'","''")}'`);
    const count=(entity:string)=>Number((db.prepare('SELECT COUNT(*) AS count FROM entities WHERE entity=?').get(entity) as {count:number}).count);
    counts={threads:count('room_threads'),messages:count('room_messages'),members:count('members'),sessions:count('sessions'),runs:count('runs')};
  }finally{db.close();}
  for(const name of ['assets','attachments'])try{await cp(path.join(dataDirectory,name),path.join(directory,name),{recursive:true});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const files:BackupManifest['files']=[];
  async function walk(relative=''){for(const file of await readdir(path.join(directory,relative),{withFileTypes:true})){const name=(relative?relative+'/':'')+file.name;if(file.isDirectory())await walk(name);else files.push({path:name,size:(await stat(path.join(directory,name))).size,sha256:createHash('sha256').update(await readFile(path.join(directory,name))).digest('hex')});}}
  await walk();const manifest:BackupManifest={formatVersion:1,createdAt:new Date().toISOString(),reason,sourceCommit:'fixture',appVersion:'0.1.0',counts,files};await writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest));return {id,directory,manifest};
}
