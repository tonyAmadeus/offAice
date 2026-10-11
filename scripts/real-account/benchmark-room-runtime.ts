import { realAccountTestEnvironment } from './guard.mjs';
const accountEnv=realAccountTestEnvironment();
for(const key of Object.keys(process.env))if(!(key in accountEnv))delete process.env[key];
Object.assign(process.env,accountEnv);
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { CodexAdapter } from '../../src/backend/adapters/codex';
import { ClaudeAdapter } from '../../src/backend/adapters/claude';
import { DshAdapter } from '../../src/backend/adapters/dsh';
import { buildEnvironment } from '../../src/backend/security';
import { disposeOwned, setOwnershipListener } from '../../src/backend/process-supervisor';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { Adapter, AdapterContext, ProviderId, Settings } from '../../src/shared/types';

// Run against native CLIs, without opening/recovering AIROOM's live database or reading credentials.
const option = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const profile = option('profile');
if (!profile || !path.isAbsolute(profile)) throw new Error('Pass --profile=<absolute AIROOM data directory>.');
const output = path.resolve(option('out') ?? '.test-cache/runtime-baseline.json');
const turns = Math.max(1, Math.min(10, Number(option('turns') ?? 3)));
const providers = (option('providers') ?? 'codex,claude,dsh').split(',') as ProviderId[];
if (providers.some(id => !['codex', 'claude', 'dsh'].includes(id))) throw new Error('Only built-in native CLIs are measured here.');
const db = new DatabaseSync(path.join(profile, 'airoom.sqlite'), { readOnly: true });
const row = db.prepare("SELECT value FROM entities WHERE entity='settings' AND id='main'").get() as { value: string } | undefined;
const saved = row ? JSON.parse(row.value) : {};
db.close();
const settings: Settings = { ...DEFAULT_SETTINGS, ...saved, models: { ...saved.models }, efforts: { ...saved.efforts }, paths: { ...saved.paths },
  permissions: { ...DEFAULT_SETTINGS.permissions, ...saved.permissions } };
const root = process.cwd(), cwd = path.join(path.dirname(output), 'benchmark-workspace');
mkdirSync(cwd, { recursive: true }); mkdirSync(path.dirname(output), { recursive: true });
const env = { ...buildEnvironment(settings), AIROOM_APP_ROOT: root, AIROOM_NODE_EXE: process.execPath,
  AIROOM_JOB_HELPER: path.join(root, 'scripts', 'windows-job.ps1'),
  AIROOM_CODEX_HOME: path.join(profile, 'native', 'codex', 'home'), AIROOM_CODEX_STATE_DIR: path.join(profile, 'native', 'codex', 'sqlite'),
  AIROOM_CLAUDE_HOME: path.join(profile, 'native', 'claude'), AIROOM_DSH_HOME: path.join(profile, 'native', 'dsh') };
const records: any[] = [];
let processStarts = 0;
setOwnershipListener(info => { if ('command' in info) processStarts++; });
const makeAdapter = (id: ProviderId): Adapter => id === 'codex' ? new CodexAdapter() : id === 'claude' ? new ClaudeAdapter() : new DshAdapter();
const report = { at: new Date().toISOString(), source: option('label') ?? 'baseline', kind: 'native-short-turns', turns, records };
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
try {
  for (const provider of providers) {
    for (const reuse of option('warm') === '1' ? [false, true] : [false]) {
      let adapter = makeAdapter(provider);
      const sessionId = randomUUID(), stamp = new Date().toISOString();
      const session: AdapterContext['session'] = { id: sessionId, projectId: 'benchmark', provider, title: 'Runtime benchmark', writeMode: false, revision: 1, createdAt: stamp, updatedAt: stamp };
      for (let index = 1; index <= turns; index++) {
        if (!reuse) adapter = makeAdapter(provider);
        const began = performance.now(), starts = processStarts;
        const record: any = { provider, reuse, index, spawned: 0, preflightMs: null, connectedMs: null, sentMs: null, firstBodyMs: null, totalMs: null, bodyCharacters: 0 };
        const native = adapter as any, protocol: Record<string, number> = {};
        const event = provider === 'claude' && option('protocol') === '1' ? native.event : undefined;
        if (event) native.event = function(value: any) {
          const key = [value.type, value.event?.type ?? value.subtype ?? '', value.parent_tool_use_id == null ? 'main' : 'child', value.user_message_uuid ? 'reference' : 'unreferenced'].join('/');
          protocol[key] = (protocol[key] ?? 0) + 1;
          return event.call(this, value);
        };
        const ctx: AdapterContext = { settings: { ...settings, permissions: { ...settings.permissions, [provider]: { commands: 'deny', fileScope: 'workspace', network: true } } }, cwd, env, session,
          run: { id: randomUUID(), sessionId, projectId: 'benchmark', provider, revision: 1, input: '', status: 'running', delivery: 'prepared', bootId: 'benchmark', createdAt: stamp, updatedAt: stamp },
          emit(kind, text, data: any) {
            if (kind === 'session' && record.connectedMs === null) record.connectedMs = Math.round(performance.now() - began);
            if ((kind === 'delta' || kind === 'message' && data?.role !== 'user' && data?.source === 'assistant') && text.trim()) {
              record.firstBodyMs ??= Math.round(performance.now() - began); record.bodyCharacters += text.length;
            }
          },
          async approve() { return { choice: 'deny' }; },
          persistNativeSession(id, home) { session.nativeId = id; session.nativeHome = home; },
          markDelivery(state, id) { ctx.run.delivery = state; ctx.run.nativeTurnId = id; if (state === 'sent') record.sentMs ??= Math.round(performance.now() - began); },
          registerProcess() { record.preflightMs ??= Math.round(performance.now() - began); },
          ...({ roomRuntime: reuse, recordTiming: (phase: string) => { record[`${phase}Ms`] ??= Math.round(performance.now() - began); } } as any),
        };
        const timer = setTimeout(() => { void adapter.stop(); void disposeOwned(); }, 120000); timer.unref();
        try {
          const result = await adapter.start(ctx, `这是第 ${index} 条启动性能测试消息。不要使用任何工具，只回复“收到 ${index}”，不加其他内容。`);
          record.outcome = result.unknown ? 'unknown' : result.stopped ? 'stopped' : result.failure?.kind ?? 'ended';
          record.delivery = ctx.run.delivery;
        } catch (error) { record.outcome = 'failed'; record.error = String((error as Error).message).replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]+\b/g, '[email]').slice(0, 600); }
        finally {
          clearTimeout(timer); if(event) native.event = event;
          record.totalMs = Math.round(performance.now() - began); record.spawned = processStarts - starts;record.runtimeReused=reuse&&!!adapter.supportsRuntimeReuse&&record.spawned===0;
          record.reusable = !!adapter.canReuse?.();
          if(event) record.protocol = protocol;
          if(event) record.correlation = { correlated: native.correlated, stream: native.streamCorrelation, malformed: native.malformed, acknowledged: native.acknowledged, queued: native.result?.queued_turn_count };
          records.push(record); save();
        }
        console.log(JSON.stringify({ provider, reuse, index, outcome: record.outcome, spawned: record.spawned, sentMs: record.sentMs, firstBodyMs: record.firstBodyMs, totalMs: record.totalMs }));
        if (record.outcome !== 'ended') break; // Never retry a failed/unknown delivery.
      }
      await (adapter as Adapter & { dispose?(): Promise<void> }).dispose?.();
    }
  }
} finally { await disposeOwned(); save(); }
