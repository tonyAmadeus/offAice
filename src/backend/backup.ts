import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { renameWithWindowsRetry } from './filesystem';
import { BackupRestorer, backupDirectory } from './backup-restore';
import type { BackupManifest, BackupReason } from '../shared/backup';

/** One verified backup across manual, deployment and restore operations. */
export const BACKUPS_KEPT = 1;
export const DEPLOY_BACKUPS_KEPT = BACKUPS_KEPT;
const writers = new Map<string, Promise<unknown>>();
const REASONS: BackupReason[] = ['deploy', 'manual', 'before-restore'];
const COPIED = ['assets', 'attachments'];
const COUNTED: Record<string, keyof BackupManifest['counts']> = { room_threads: 'threads', room_messages: 'messages', members: 'members', sessions: 'sessions', runs: 'runs' };

async function digest(file: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }

/** Windows scanners can briefly hold newly written files. Retry only the final rename, never the
 * snapshot or copies, and never replace an existing destination. Persistent errors remain failures. */
export async function publishBackupDirectory(partial:string,directory:string,move:(from:string,to:string)=>Promise<void>=rename,platform=process.platform){
  await renameWithWindowsRetry(partial,directory,{move,platform});
}

/** Copies regular files only; a link inside the data folder would be refused by restore, so it is refused here first. */
async function copyTree(source: string, target: string, relative = ''): Promise<void> {
  const from = path.join(source, relative);
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name, file = path.join(source, name);
    if ((await lstat(file)).isSymbolicLink()) throw new Error(`资料目录里有链接，未备份：${name}`);
    if (entry.isDirectory()) { await mkdir(path.join(target, name), { recursive: true }); await copyTree(source, target, name); }
    else if (entry.isFile()) await copyFile(file, path.join(target, name));
  }
}

async function listFiles(root: string, relative = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(root, name)); else if (entry.isFile() && name !== 'manifest.json') files.push(name);
  }
  return files.sort();
}

/** Which build wrote this data: the running deployment's receipt and program version, when present. */
function origin(dataDirectory: string) {
  const parent = path.dirname(path.resolve(dataDirectory));
  const json = (file: string) => { try { return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return undefined; } };
  const appRoot=path.resolve(process.env.AIROOM_APP_ROOT??process.cwd());
  const installedRoot=path.basename(appRoot)==='app'&&path.basename(path.dirname(appRoot))==='resources'?path.resolve(appRoot,'../..'):undefined;
  const receipt = (installedRoot?(json(path.join(installedRoot,'deployment-receipt.json'))??json(path.join(installedRoot,'build-manifest.json'))):undefined)??json(path.join(parent, 'deployment-receipt.json'));
  const app = json(path.join(appRoot,'package.json'))??json(path.join(parent, 'resources', 'app', 'package.json'));
  return { ...(typeof receipt?.sourceCommit === 'string' ? { sourceCommit: receipt.sourceCommit } : {}), ...(typeof app?.version === 'string' ? { appVersion: app.version } : {}) };
}

/** Writes one backup of the user's data (format v1, handoff 12): a consistent database copy, pictures and
 * attachments, and a manifest with counts and file hashes. Logins, program versions, work copies and
 * checkpoints are never included. The folder appears under its final name only once complete. */
export async function createBackup(dataDirectory: string, reason: BackupReason): Promise<{ id: string; directory: string; manifest: BackupManifest }> {
  const key = path.resolve(dataDirectory);
  const previous = writers.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => writeVerifiedBackup(key, reason));
  writers.set(key, next);
  try { return await next; } finally { if (writers.get(key) === next) writers.delete(key); }
}

async function writeVerifiedBackup(dataDirectory: string, reason: BackupReason): Promise<{ id: string; directory: string; manifest: BackupManifest }> {
  if (!REASONS.includes(reason)) throw new Error('备份原因无效。');
  dataDirectory = path.resolve(dataDirectory);
  const database = path.join(dataDirectory, 'airoom.sqlite');
  if (!existsSync(database)) throw new Error('还没有可备份的资料。');
  const root = backupDirectory(dataDirectory);
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('备份目录不能是链接，请先核对存储位置。');
  const createdAt = new Date().toISOString(), id = `${createdAt.replace(/[:.]/g, '-')}-${reason}-${randomUUID().slice(0, 8)}`;
  const partial = path.join(root, `.partial-${id}`), directory = path.join(root, id);
  await mkdir(partial);
  try {
    // VACUUM INTO reads one consistent snapshot, including pages still in the WAL, while the app keeps running.
    const db = new DatabaseSync(database);
    try { db.exec('PRAGMA busy_timeout = 10000'); db.exec(`VACUUM INTO '${path.join(partial, 'airoom.sqlite').replaceAll("'", "''")}'`); } finally { db.close(); }
    const counts: BackupManifest['counts'] = { threads: 0, messages: 0, members: 0, sessions: 0, runs: 0 };
    const copy = new DatabaseSync(path.join(partial, 'airoom.sqlite'), { readOnly: true });
    try { for (const row of copy.prepare('SELECT entity, COUNT(*) AS count FROM entities GROUP BY entity').all() as { entity: string; count: number }[]) if (COUNTED[row.entity]) counts[COUNTED[row.entity]] = Number(row.count); }
    finally { copy.close(); }
    for (const name of COPIED) if (existsSync(path.join(dataDirectory, name))) { await mkdir(path.join(partial, name)); await copyTree(path.join(dataDirectory, name), path.join(partial, name)); }
    const files: BackupManifest['files'] = [];
    for (const name of await listFiles(partial)) files.push({ path: name, size: (await stat(path.join(partial, name))).size, sha256: await digest(path.join(partial, name)) });
    const manifest: BackupManifest = { formatVersion: 1, createdAt, reason, ...origin(dataDirectory), counts, files };
    await writeFile(path.join(partial, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    await publishBackupDirectory(partial, directory);
    const backups = new BackupRestorer(dataDirectory);
    // Never rotate a working backup until the newly published payload, database and counts pass restore validation.
    await backups.preview(id);
    for (const old of await backups.list()) {
      if (old.id === id || !old.manifest || old.error) continue;
      try { await backups.preview(old.id); } catch { continue; }
      try { await backups.remove(old.id); }
      catch (error) { throw new Error(`新备份已保存并校验，但旧备份未能删除：${old.id}。${error instanceof Error ? error.message : String(error)}`); }
    }
    return { id, directory, manifest };
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

// Deployment runs `node dist/backup.mjs <data directory> deploy` before replacing the program.
// A data folder that has never been used has nothing to back up; that is not a failure.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [dataDirectory, reason = 'deploy'] = process.argv.slice(2);
  if (!dataDirectory) { console.error('用法：node backup.mjs <资料目录> [deploy|manual|before-restore]'); process.exit(2); }
  if (!existsSync(path.join(dataDirectory, 'airoom.sqlite'))) { console.log('没有找到资料数据库，跳过备份。'); process.exit(0); }
  createBackup(dataDirectory, reason as BackupReason).then(result => {
    console.log(`已备份：${result.directory}（${result.manifest.counts.messages} 条聊天、${result.manifest.counts.members} 张人物卡、${result.manifest.files.length} 个文件）`);
  }, error => { console.error(`备份失败：${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
}
