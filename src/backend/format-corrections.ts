import { randomUUID } from 'node:crypto';
import type { Store } from './store';
import type { Run } from '../shared/types';
import { FlowError, type FlowOperation } from '../shared/project-flow';
import { AMBIGUOUS_FIELDS } from '../shared/flow-format';

/**
 * One record per format correction the flows considered: why the reply was refused, which stage
 * and executor produced it, and whether the correction worked. No reply text is kept, so the
 * records can be exported for diagnosis without carrying member output.
 */
export interface FormatCorrection {
  id: string; at: string; area: 'project-flow' | 'joint-review'; stage: string;
  memberId?: string; executor: string; category: FormatCategory; reason: string;
  outcome: 'corrected' | 'failed' | 'skipped';
  operationId?: string; runId?: string; replyAt?: string;
}
export type FormatCategory = 'syntax' | 'envelope' | 'missing-field' | 'extra-field' | 'value' | 'empty-text' | 'evidence' | 'ambiguous' | 'other';

/** Coarse groups are enough to see which tolerance would help most. */
export function formatCategory(error: unknown): FormatCategory {
  const code = error instanceof FlowError ? error.code : '', message = error instanceof Error ? error.message : String(error);
  if (code === AMBIGUOUS_FIELDS) return 'ambiguous';
  if (code === 'UNVERIFIED_EVIDENCE' || /依据|来源|命令/.test(message)) return 'evidence';
  if (/语法|括号|不完整|未找到完整 JSON|JSON 对象|空对象/.test(message)) return 'syntax';
  if (/协议名称|版本或用途/.test(message)) return 'envelope';
  if (/缺少的字段/.test(message)) return 'missing-field';
  if (/不支持的字段/.test(message)) return 'extra-field';
  if (/文字字段不能为空/.test(message)) return 'empty-text';
  if (/只能是|无效|必须|布尔/.test(message)) return 'value';
  return 'other';
}

export function recordFormatCorrection(store: Store, entry: Omit<FormatCorrection, 'id' | 'at' | 'category' | 'reason' | 'replyAt'> & { error: unknown }) {
  const { error, ...rest } = entry, id = randomUUID();
  const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
  const run = entry.runId ? store.get<Run>('runs', entry.runId) : undefined;
  const replyAt = run && ['ended', 'completed'].includes(run.status) ? run.completedAt : undefined;
  store.put('format_corrections', id, { id, at: new Date().toISOString(), ...rest, ...(replyAt ? { replyAt } : {}), category: formatCategory(error), reason } satisfies FormatCorrection);
  store.retainNewest({ format_corrections: 1000 });
}

/** Counts for the diagnostics export, next to how many flow replies were read in the same period. */
export function formatCorrectionSummary(store: Store) {
  const records = store.list<FormatCorrection>('format_corrections');
  if (!records.length) return { corrections: 0 };
  // Link the window to the original reply, not the later correction or operation creation.
  // Old records lack that link: preserve them for diagnosis, but never invent a denominator.
  const linked = records.filter(r => r.runId && r.replyAt), legacyCorrections = records.length - linked.length;
  const since = linked.length ? linked.reduce((first, r) => r.replyAt! < first ? r.replyAt! : first, linked[0].replyAt!) : null;
  const count = (key: (r: FormatCorrection) => string) => linked.reduce<Record<string, number>>((all, r) => ({ ...all, [key(r)]: (all[key(r)] ?? 0) + 1 }), {});
  const operations = store.list<FlowOperation>('flow_operations');
  const replies = (key: 'runId' | 'correctionRunId') => new Set(operations.flatMap(op => {
    const id = op[key], run = id ? store.get<Run>('runs', id) : undefined;
    return since && run?.completedAt && run.completedAt >= since && ['ended', 'completed'].includes(run.status) ? [id!] : [];
  })).size;
  return {
    since, corrections: linked.length, recordedCorrections: records.length, legacyCorrections,
    flowReplies: since ? replies('runId') : null, correctionReplies: since ? replies('correctionRunId') : null,
    byOutcome: count(r => r.outcome), byCategory: count(r => r.category), byStage: count(r => r.stage), byExecutor: count(r => r.executor),
    recent: [...records].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20),
  };
}
