export interface ExecutorIdentity {
  path?: string; version?: string; versionSource?: 'manifest' | 'native'; digest?: string; argumentsDigest?: string;
  adapterVersion: string; protocol: string; protocolVersion?: string;
}
export interface CompatibilityStage {
  stage: string; method?: string; startedAt: string; durationMs: number; timeoutMs?: number;
  outcome: 'passed' | 'failed'; error?: string; code?: number | string;
}
export interface CompatibilityReport {
  id: string; provider: string; trigger: 'probe' | 'configuration' | 'candidate' | 'run';
  startedAt: string; completedAt?: string; outcome: 'running' | 'passed' | 'needs-auth' | 'failed' | 'unknown' | 'stopped';
  identity: ExecutorIdentity; stages: CompatibilityStage[]; error?: string;
  account?: string; capabilities?: unknown; configuration?: {model?: string; effort?: string};
  effectiveConfig?: import('./executor-config').EffectiveRunConfig;
  runId?: string; sessionId?: string; delivery?: string; restore?: 'bound' | 'legacy-unbound' | 'current-version' | 'new';
  network: {mode: string; proxyHost?: string; tunVerified: false};
  nodeRuntime?: import('./executor-catalog').NodeRuntimeInfo;
}
export const ADAPTER_CONTRACT_VERSION = 'airoom.executor/2';
