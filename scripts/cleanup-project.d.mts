export interface CleanupProcess {
  pid: number;
  parent: number;
  name: string;
  command: string;
}

export interface CleanupSettings {
  tempDays: number;
  cacheDays: number;
  buildDays: number;
}

export interface CleanupPlanOptions extends Partial<CleanupSettings> {
  now?: number;
  processes?: CleanupProcess[];
}

export interface CleanupCandidate {
  path: string;
  days: number;
  reason: string;
}

export interface CleanupFile {
  path: string;
  bytes: number;
  fingerprint: string;
  candidate?: string;
  sha256?: string;
  retained?: string;
}

export interface CleanupSkipped {
  path: string;
  reason: string;
  busy?: Array<Pick<CleanupProcess, 'pid' | 'name'>>;
}

export interface CleanupPlan {
  version: 1;
  root: string;
  at: string;
  settings: CleanupSettings;
  candidates: CleanupCandidate[];
  files: CleanupFile[];
  directories: string[];
  preserved: CleanupFile[];
  skipped: CleanupSkipped[];
  duplicateInstallers: CleanupFile[];
  bytes: number;
}

export interface CleanupResult {
  status: 'complete' | 'partial' | 'interrupted';
  deleted: string[];
  skipped: CleanupSkipped[];
  errors: CleanupSkipped[];
  bytes: number;
  removedEmptyDirectories: number;
}

export interface CleanupApplyOptions {
  processes?: CleanupProcess[];
  shouldStop?: () => boolean;
  progress?: (deleted: number, bytes: number) => void;
}

export function validateRoot(input: string): Promise<string>;
export function runningProcesses(): CleanupProcess[];
export function planCleanup(input: string, options?: CleanupPlanOptions): Promise<CleanupPlan>;
export function applyCleanup(plan: CleanupPlan, options?: CleanupApplyOptions): Promise<CleanupResult>;
export function main(args?: string[]): Promise<number>;
