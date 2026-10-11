import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BackupReason } from '../shared/backup';

/** The agreed R1 writer is a standalone entry shared by the app and deployment. */
export async function writeBackup(dataDirectory:string,reason:BackupReason):Promise<void>{
  const file=path.join(process.env.AIROOM_APP_ROOT??process.cwd(),'dist','backup.mjs');
  if(!existsSync(file))throw new Error('备份写入组件尚未安装，请先更新包含 R1 的桌面版本。');
  const writer=await import(pathToFileURL(file).href);
  if(typeof writer.createBackup!=='function')throw new Error('备份写入组件接口不兼容，未修改当前数据。');
  await writer.createBackup(dataDirectory,reason);
}
