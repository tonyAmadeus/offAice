import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ExecutorIdentity } from '../shared/compatibility';
import type { PermissionMember } from '../shared/types';
import { extractVersion } from './member-versions';

const programPath=(value:string)=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
const version=(identity:ExecutorIdentity)=>extractVersion(identity.version)??identity.version;
export function sameMemberProgram(a:ExecutorIdentity|undefined,b:ExecutorIdentity|undefined):boolean {
  return !!(a?.path&&b?.path&&a.digest&&b.digest&&programPath(a.path)===programPath(b.path)&&a.digest===b.digest&&a.adapterVersion===b.adapterVersion&&a.protocol===b.protocol&&(!version(a)||!version(b)||version(a)===version(b)));
}
export function memberVersionUseKey(provider:PermissionMember,identity:ExecutorIdentity):string|undefined {
  if(!identity.path||!identity.digest)return;
  return createHash('sha256').update(JSON.stringify([provider,programPath(identity.path),identity.digest,version(identity),identity.adapterVersion,identity.protocol])).digest('hex');
}
