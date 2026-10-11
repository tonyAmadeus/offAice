import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Adapter, AdapterContext } from '../shared/types';
import { stopOwned } from './process-supervisor';
import { plainRoomSpeech } from './adapters/chat-policy';

export const ROOM_RUNTIME_IDLE_MS = 10 * 60 * 1000;
export const ROOM_RUNTIME_LIMIT = 8;

/** Metadata only. Credential contents are neither read nor included in diagnostics. */
export function fileStamp(file: string) {
  try { const value = statSync(file); return [path.resolve(file), value.size, value.mtimeMs, value.ctimeMs, value.ino]; }
  catch { return [path.resolve(file), 'missing']; }
}
export function runtimeFingerprint(ctx: AdapterContext, files: string[] = [], extra?: unknown): string {
  const id = ctx.run.provider;
  // Include the launched program's package manifest, so an in-place update invalidates the lease.
  const manifests = files.flatMap(file => [file, path.join(path.dirname(file), 'package.json'), path.join(path.dirname(file), '..', 'package.json')]);
  const environment = Object.fromEntries(Object.entries(ctx.env).sort(([a], [b]) => a.localeCompare(b)));
  const authFiles = id==='codex'&&ctx.env.AIROOM_CODEX_HOME?[path.join(ctx.env.AIROOM_CODEX_HOME,'auth.json')]
    :id==='claude'&&ctx.env.AIROOM_CLAUDE_HOME?[path.join(ctx.env.AIROOM_CLAUDE_HOME,'.credentials.json')]:[];
  const configFiles = id==='codex'&&ctx.env.AIROOM_CODEX_HOME?[path.join(ctx.env.AIROOM_CODEX_HOME,'config.toml'),path.join(ctx.env.AIROOM_CODEX_HOME,'AGENTS.md'),path.join(ctx.cwd,'AGENTS.md')]
    :id==='claude'&&ctx.env.AIROOM_CLAUDE_HOME?[path.join(ctx.env.AIROOM_CLAUDE_HOME,'settings.json'),path.join(ctx.env.AIROOM_CLAUDE_HOME,'CLAUDE.md'),path.join(ctx.cwd,'CLAUDE.md'),path.join(ctx.cwd,'.claude','CLAUDE.md'),path.join(ctx.cwd,'.claude','settings.json'),path.join(ctx.cwd,'.claude','settings.local.json')]:[];
  const value = { cwd: path.resolve(ctx.cwd), provider: id, member: ctx.session.memberId, purpose: ctx.session.purpose,
    write: ctx.session.writeMode, conversation: ctx.conversation, roomSpeech:plainRoomSpeech(ctx), autoApprove: ctx.session.autoApprove, permissions: id==='deepseek'?undefined:ctx.settings.permissions[id],
    model: ctx.settings.models[id], effort: ctx.settings.efforts[id], persona: ctx.persona,
    network: [ctx.settings.networkMode, ctx.settings.proxyUrl], dsh: [ctx.settings.dshProfile, ctx.settings.deepseekBaseUrl],
    environment, files: [...new Set([...manifests,...authFiles,...configFiles])].map(fileStamp), extra };
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

interface Entry {
  key: string; fingerprint: string; adapter: Adapter; busy: boolean; invalid: boolean;
  used: number; children: Set<ChildProcess>; timer?: NodeJS.Timeout;
  closing?: Promise<void>;
}
export interface RuntimeLease {
  adapter: Adapter; cached: boolean; reused: boolean; children: Set<ChildProcess>;
  release(keep: boolean, record?: (conditions: Record<string, boolean>) => void): Promise<void>;
}

/** One serial lease per AIROOM room session. Idle processes never consume execution slots. */
export class RoomRuntimePool {
  private entries = new Map<string, Entry>();
  private epoch = 0;
  constructor(private options: { idleMs?: number; limit?: number; closeTimeoutMs?: number } = {}) {}
  get size() { return this.entries.size; }
  async acquire(key: string, fingerprint: string, create: () => Adapter): Promise<RuntimeLease> {
    const epoch = this.epoch;
    let entry = this.entries.get(key), reused = false;
    if (entry?.busy) throw new Error('该聊天室会话已有活动请求。');
    const retired: Entry[] = [];
    if (entry && (entry.invalid || entry.fingerprint !== fingerprint || !entry.adapter.canReuse?.())) {
      this.entries.delete(key); entry.invalid = true; retired.push(entry); entry = undefined;
    }
    if (entry) { reused = true; clearTimeout(entry.timer); entry.busy = true; }
    else {
      const limit = this.options.limit ?? ROOM_RUNTIME_LIMIT;
      if (this.entries.size >= limit) {
        const oldest = [...this.entries.values()].filter(value => !value.busy).sort((a, b) => a.used - b.used)[0];
        if (oldest) { this.entries.delete(oldest.key); oldest.invalid = true; retired.push(oldest); }
        else return { adapter: create(), cached: false, reused: false, children: new Set(), release: async (keep,record) => { record?.({cached:false,requested:keep,retained:false}); } };
      }
      entry = { key, fingerprint, adapter: create(), busy: true, invalid: false, used: Date.now(), children: new Set() };
      this.entries.set(key, entry); // Reserve capacity before awaiting old process shutdown.
    }
    const acquired = entry;
    try { for (const old of retired) await this.closeEntry(old); }
    catch (error) { await this.drop(acquired); throw error; }
    if (epoch !== this.epoch || acquired.invalid || this.entries.get(key) !== acquired) {
      await this.drop(acquired); throw new Error('聊天室程序已回收，本次请求尚未发送。');
    }
    return { adapter: acquired.adapter, cached: true, reused, children: acquired.children,
      release: async (keep,record) => {
        const current=this.entries.get(key)===acquired, adapterReusable=!!acquired.adapter.canReuse?.();
        const retained=keep&&!acquired.invalid&&current&&adapterReusable;
        record?.({cached:true,requested:keep,invalidated:acquired.invalid,current,adapterReusable,retained});
        if (!retained) { await this.drop(acquired); return; }
        acquired.busy = false; acquired.used = Date.now();
        acquired.timer = setTimeout(() => { void this.drop(acquired).catch(() => {}); }, this.options.idleMs ?? ROOM_RUNTIME_IDLE_MS);
        acquired.timer.unref();
      } };
  }
  private async closeEntry(entry: Entry) {
    if (entry.closing) return entry.closing;
    clearTimeout(entry.timer); entry.invalid = true;
    entry.closing = (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = Math.max(1, Math.min(this.options.closeTimeoutMs ?? 5000, 60000));
        await Promise.race([
          Promise.resolve().then(() => entry.adapter.dispose ? entry.adapter.dispose() : entry.adapter.stop()),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('旧执行端回收超时，已隔离该会话；本次新请求尚未发送。')), timeout);
          }),
        ]);
      }
      finally {
        if (timer) clearTimeout(timer);
        await Promise.all([...entry.children].map(child => stopOwned(child, 2000))); entry.children.clear();
      }
    })();
    return entry.closing;
  }
  private async drop(entry: Entry) {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    await this.closeEntry(entry);
  }
  /** Active leases are retired when their turn finishes; never silently retarget their callbacks. */
  async invalidate(match: (key: string, adapter: Adapter) => boolean = () => true) {
    const entries = [...this.entries.values()].filter(entry => match(entry.key, entry.adapter));
    for (const entry of entries) entry.invalid = true;
    await Promise.all(entries.filter(entry => !entry.busy).map(entry => this.drop(entry)));
  }
  /** Stop/exit also cancels acquisitions waiting for another runtime to close. */
  async closeAll() {
    this.epoch++;
    const entries = [...this.entries.values()]; this.entries.clear();
    for (const entry of entries) entry.invalid = true;
    await Promise.all(entries.map(entry => this.closeEntry(entry)));
  }
  async closeSession(id: string) { await this.invalidate(key => key === id); }
  /** A maintenance tick also handles sleep/wake; active turns are never reclaimed. */
  async reapIdle(at=Date.now()) { const idle=this.options.idleMs??ROOM_RUNTIME_IDLE_MS;await Promise.all([...this.entries.values()].filter(entry=>!entry.busy&&entry.used+idle<=at).map(entry=>this.drop(entry))); }
}
