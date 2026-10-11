import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CLAUDE_DEBUG_FILES, claudeDebugArgs } from '../src/backend/adapters/claude-debug';
import { getClaudeLoginLaunch } from '../src/backend/adapters/claude';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';

async function data() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'AIROOM claude-debug-')), home = path.join(directory, 'data', 'native', 'claude');
  await mkdir(home, { recursive: true });
  return { directory, home, logs: path.join(directory, 'data', 'logs', 'claude-debug'), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('each Claude process gets its own debug log beside AIROOM\'s logs, and it can be turned off', async () => {
  const d = await data();
  try {
    const [flag, file] = claudeDebugArgs({ AIROOM_CLAUDE_HOME: d.home }, 'auth-status');
    assert.equal(flag, '--debug-file'); assert.equal(path.dirname(file), d.logs); assert.match(path.basename(file), /-auth-status-[0-9a-f]{6}\.log$/);
    assert.notEqual(claudeDebugArgs({ AIROOM_CLAUDE_HOME: d.home }, 'auth-status')[1], file, 'two processes never share a log');
    assert.deepEqual(claudeDebugArgs({ AIROOM_CLAUDE_HOME: d.home, AIROOM_CLAUDE_DEBUG: '0' }, 'usage'), []);
    assert.deepEqual(claudeDebugArgs({}, 'usage'), [], 'no AIROOM login folder, no log');
    const login = getClaudeLoginLaunch({ ...DEFAULT_SETTINGS, paths: { claude: process.execPath } }, { ...process.env, AIROOM_CLAUDE_HOME: d.home });
    assert.ok(login.args.includes('--debug-file') && login.args.indexOf('--debug-file') < login.args.indexOf('auth'), 'the login itself is recorded too');
  } finally { await d.cleanup(); }
});

test('old debug logs are removed beyond the newest files kept', async () => {
  const d = await data();
  try {
    await mkdir(d.logs, { recursive: true });
    for (let i = 0; i < CLAUDE_DEBUG_FILES + 5; i++) {
      const file = path.join(d.logs, `old-${String(i).padStart(2, '0')}.log`); await writeFile(file, 'x');
      const at = new Date(Date.UTC(2026, 9, 1, 0, i)); await utimes(file, at, at);
    }
    claudeDebugArgs({ AIROOM_CLAUDE_HOME: d.home }, 'run');
    const left = (await readdir(d.logs)).sort();
    assert.equal(left.length, CLAUDE_DEBUG_FILES); assert.equal(left[0], 'old-05.log', 'the five oldest were removed');
  } finally { await d.cleanup(); }
});
