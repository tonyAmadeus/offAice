import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const ZCODE_ROOM_DISABLED_TOOLS = ['Read','Glob','Grep','TodoRead','TodoWrite','CronList','OffPeakList','WebFetch','WebSearch','AskUserQuestion','EnterPlanMode','ReadSessionContext','ListModels','ListSavedWorkflows','ListWorkflowRuns','GetWorkflowRun','ResumeWorkflowRun','ResolveWorkflowQuestion','RespondToCoordinator','EvalWorkflowSnippet','SendMessage','TaskOutput','TaskStop','escalate','submit_result'];

// The native CLI supports whole-name exclusions, not a wildcard or a CLI allowlist.
// Bind the reviewed list to the exact official CLI validated in handoffs 66/67.
const REVIEWED_CLI = 'fad4c35c4c36ec210d8a06d3fa0e77de23c8545e2eb6ff90aea1eb38d1e6275f';
export async function zcodeRoomTools(file: string, unreviewed?: (hash: string) => void): Promise<string[]> {
  const hash=createHash('sha256').update(await readFile(file)).digest('hex');
  if(hash!==REVIEWED_CLI){unreviewed?.(hash);return [];}
  return [...ZCODE_ROOM_DISABLED_TOOLS];
}
