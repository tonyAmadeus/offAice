import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { AdapterContext } from '../shared/types';

export class RuntimeMetrics {
  private began = performance.now();
  private phases: Record<string, number> = {};
  private done = false;
  private decisions: Record<string, Record<string, boolean | number | string | null>> = {};
  processes = 0;
  reused = false;
  constructor(private directory: string, private ctx: AdapterContext) {}
  mark = (phase: string) => { if (!this.done && /^[a-z-]{1,32}$/.test(phase)) this.phases[phase] ??= Math.round(performance.now() - this.began); };
  decision = (stage: string, conditions: Record<string, boolean | number | string | null>) => {
    if (!this.done && /^[a-z-]{1,32}$/.test(stage)) this.decisions[stage] = { ...conditions };
  };
  finish(outcome: string) {
    if (this.done) return; this.mark('total'); this.done = true;
    try {
      const file = path.join(this.directory, 'logs', 'room-runtime.jsonl'); mkdirSync(path.dirname(file), { recursive: true });
      if (existsSync(file) && statSync(file).size > 512 * 1024) {
        const newest = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-1000).join('\n'); writeFileSync(file, newest + '\n');
      }
      const value = { at: new Date().toISOString(), runId: this.ctx.run.id, provider: this.ctx.run.provider,
        purpose: this.ctx.session.purpose ?? (this.ctx.conversation==='desk'?'desk-chat':'room-speech'), inputChars:this.ctx.run.input.length, reused: this.reused, processes: this.processes, phases: this.phases, decisions: this.decisions, outcome };
      appendFileSync(file, JSON.stringify(value) + '\n');
    } catch { /* Performance diagnostics never change delivery or execution. */ }
  }
}
