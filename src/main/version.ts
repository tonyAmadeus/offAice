import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RunningVersion } from '../shared/version';


const read = (file: string) => { try { return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return undefined; } };
const RECEIPT = 'deployment-receipt.json', MANIFEST = 'build-manifest.json';

/** appDirectory is the folder holding AIROOM.exe; running from source has neither file. */
export function runningVersion(appDirectory: string, packaged: boolean): RunningVersion {
  if (!packaged) return { development: true };
  const manifest = read(path.join(appDirectory, MANIFEST)), receipt = read(path.join(appDirectory, RECEIPT));
  const version: RunningVersion = { development: false };
  if (typeof manifest?.sourceCommit === 'string') version.sourceCommit = manifest.sourceCommit;
  if (typeof manifest?.builtAt === 'string') version.builtAt = manifest.builtAt;
  if (typeof manifest?.sourceDirty === 'boolean') version.sourceDirty = manifest.sourceDirty;
  if (receipt && typeof receipt.sourceCommit === 'string') {
    if (receipt.sourceCommit !== version.sourceCommit) version.mismatch = true;
    else {
      if (typeof receipt.deployedAt === 'string') version.deployedAt = receipt.deployedAt;
      version.acceptance = receipt.userSessionAcceptance === 'accepted' ? 'accepted' : 'pending';
      if (typeof receipt.acceptedAt === 'string') version.acceptedAt = receipt.acceptedAt;
    }
  }
  return version;
}

/** Records in the deployment receipt that the user has confirmed the running version. */
export function acceptRunningVersion(appDirectory: string, packaged: boolean, at = new Date()): RunningVersion {
  const current = runningVersion(appDirectory, packaged);
  if (current.development) throw new Error('从源码运行的开发版本没有部署记录，无法验收。');
  if (!current.sourceCommit || current.mismatch || !current.acceptance) throw new Error('没有找到这个版本的部署记录，请通过正式部署后再验收。');
  if (current.acceptance === 'accepted') return current;
  const file = path.join(appDirectory, RECEIPT), receipt = read(file);
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...receipt, userSessionAcceptance: 'accepted', acceptedAt: at.toISOString() }, null, 2), 'utf8');
  renameSync(temporary, file);
  return runningVersion(appDirectory, packaged);
}

