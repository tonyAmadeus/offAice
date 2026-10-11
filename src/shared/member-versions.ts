import type { ExecutorIdentity } from './compatibility';
import type { EffectiveRunConfig, RequestedRunConfig } from './executor-config';
import type { PermissionMember } from './types';

/** An observed completed native reply, bound to the actual program rather than a version list. */
export interface MemberVersionUse {
  provider: PermissionMember; identity: ExecutorIdentity; runId: string; completedAt: string;
  requestedConfig?: RequestedRunConfig; effectiveConfig?: EffectiveRunConfig;
}
export interface MemberInstallation {
  version: string; phase: 'installing' | 'files' | 'launch' | 'connection';
  startedAt: string; phaseStartedAt: string; writtenBytes?: number; lastProgressAt?: string;
  detail?:string;
}
export interface MemberVersions {
  member: PermissionMember; packageName: string; current?: string; baselineVersions: string[];
  source: 'airoom' | 'custom' | 'global' | 'bundled'; activeVersion?: string;
  selectedPath: string | null; installed: string[]; latest?: string; latestError?: string;
  installedOnly?: boolean; detail?: string;
  installation?: MemberInstallation;
  connection: { state: 'connected' | 'unchecked' | 'stale' | 'failed'; detail: string; checkedAt?: string };
  successfulUse?: MemberVersionUse;
  lastRun?: { outcome: import('./compatibility').CompatibilityReport['outcome']; completedAt?: string; error?: string };
}
