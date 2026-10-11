import { randomUUID } from 'node:crypto';
import type { ModelOption } from '../../shared/types';
import { spawnCli, type CliCommand } from './common';
import { stopOwned } from '../process-supervisor';

export function claudeModelOptions(models: unknown): ModelOption[] {
  if (!Array.isArray(models)) return [];
  return models.filter(item => typeof item?.value === 'string').map(item => ({
    id: item.value, label: typeof item.displayName === 'string' ? item.displayName : item.value,
    description: [item.description, item.resolvedModel].filter(value => typeof value === 'string').join(' · '),
    efforts: item.supportsEffort === true && Array.isArray(item.supportedEffortLevels) ? item.supportedEffortLevels.filter((value: unknown) => typeof value === 'string') : [],
    effortSource: item.supportsEffort === true && Array.isArray(item.supportedEffortLevels) ? 'reported' : item.supportsEffort === false ? 'unsupported' : 'unreported',
    ...(typeof item.resolvedModel === 'string' ? {aliases: [item.resolvedModel]} : {}),
    isDefault: item.value === 'default',
  }));
}

/** SDK initialization only. No user message, model prompt, or account credentials leave this helper. */
export async function readClaudeModels(command: CliCommand, env: NodeJS.ProcessEnv, cwd: string): Promise<ModelOption[]> {
  const child = spawnCli(command, ['--restricted', '-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], { cwd, env });
  const requestId = randomUUID();
  try {
    return await new Promise<ModelOption[]>((resolve, reject) => {
      let buffered = '', settled = false;
      const finish = (models: ModelOption[]) => { if (!settled) { settled = true; clearTimeout(timer); resolve(models); } };
      const timer = setTimeout(() => finish([]), 5000);
      child.once('error', error => { clearTimeout(timer); if (!settled) { settled = true; reject(error); } });
      child.stdin?.on('error', () => finish([]));
      child.once('close', () => finish([]));
      child.stdout?.setEncoding('utf8'); child.stderr?.resume();
      child.stdout?.on('data', (chunk: string) => {
        buffered += chunk;
        if (buffered.length > 2 * 1024 * 1024) { finish([]); return; }
        const lines = buffered.split('\n'); buffered = lines.pop()!;
        for (const line of lines) {
          try {
            const value = JSON.parse(line);
            if (value.type === 'control_response' && value.response?.request_id === requestId) finish(claudeModelOptions(value.response?.response?.models));
          } catch { /* Older CLIs may not expose SDK configuration. */ }
        }
      });
      child.stdin?.write(JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } }) + '\n');
    });
  } finally {
    child.stdin?.end();
    if (child.exitCode === null && child.signalCode === null) await stopOwned(child, 1000);
  }
}
