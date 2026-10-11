import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { isolatedTestEnvironment, cleanupTestEnvironment } from '../scripts/test-environment.mjs';
import { assertRealAccountConsent } from '../scripts/real-account/guard.mjs';
import { getClaudeLoginLaunch } from '../src/backend/adapters/claude';
import { getCodexLoginLaunch } from '../src/backend/adapters/codex';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';

test('inherited daily account and host variables cannot select ordinary test login homes', () => {
  const profile = isolatedTestEnvironment({ ...process.env, USERPROFILE: 'C:\\daily-user', AIROOM_DATA_DIR: 'C:\\daily-user\\.airoom\\data',
    AIROOM_CLAUDE_HOME: 'C:\\daily-user\\.airoom\\data\\native\\claude', CODEX_HOME: 'C:\\daily-codex',
    CLAUDE_CONFIG_DIR: 'C:\\daily-claude', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
    CODEX_THREAD_ID: 'host-thread', OPENAI_API_KEY: 'host-key', ANTHROPIC_AUTH_TOKEN: 'host-token',
    claude_config_dir:'C:\\daily-claude-lowercase',airoom_codex_home:'C:\\daily-codex-lowercase',userprofile:'C:\\daily-user-lowercase' });
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', 'CODEX_THREAD_ID', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) assert.equal(profile.env[key], undefined, key);
  for (const key of ['claude_config_dir','airoom_codex_home','userprofile'])assert.equal(profile.env[key],undefined,key);
  const settings = { ...DEFAULT_SETTINGS, paths: { codex: process.execPath, claude: process.execPath } };
  const launches = [getClaudeLoginLaunch(settings, profile.env), getCodexLoginLaunch(settings, profile.env)];
  for (const home of [launches[0].env.CLAUDE_CONFIG_DIR!, launches[1].env.CODEX_HOME!]) {
    const relative = path.relative(profile.directory, home);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.equal(existsSync(path.join(home, '.credentials.json')), false);
    assert.equal(existsSync(path.join(home, 'auth.json')), false);
  }
  const second = isolatedTestEnvironment(profile.env);
  assert.notEqual(second.directory, profile.directory, 'each test process gets an independent account');
  cleanupTestEnvironment(profile.directory);cleanupTestEnvironment(second.directory);
});

test('real-account diagnostics fail before touching a profile without explicit consent and a closed app', () => {
  assert.throws(() => assertRealAccountConsent([]), /真实登录/);
  assert.throws(() => assertRealAccountConsent(['--use-real-account']), /退出 AIROOM/);
  assert.throws(() => assertRealAccountConsent(['--app-closed']), /主人同意/);
  assert.doesNotThrow(() => assertRealAccountConsent(['--use-real-account', '--app-closed']));
});
