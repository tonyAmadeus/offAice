export type BackupReason = 'deploy' | 'manual' | 'before-restore';
export interface BackupManifest {
  formatVersion: 1;
  createdAt: string;
  reason: BackupReason;
  sourceCommit?: string;
  appVersion?: string;
  counts: {threads:number;messages:number;members:number;sessions:number;runs:number};
  files: {path:string;size:number;sha256:string}[];
}
export interface BackupEntry {id:string;manifest?:BackupManifest;bytes:number;error?:string}
export interface BackupPreview {id:string;manifest:BackupManifest;bytes:number;memberNames:string[];historyOnlySessions:number}
export interface RestorePreview {token:string;backup:BackupPreview;expiresAt:string}
export interface RestoreResult {restored:boolean;beforeBackupId:string;rollbackDirectory:string;detail:string}
