import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CLAUDE_TOKEN_PATTERN, claudeEnvironment, claudeOAuthTokenConfigured, getClaudeLoginLaunch, getClaudeTokenLaunch, requireClaudeSubscription, setClaudeOAuthToken } from '../src/backend/adapters/claude';
import { subscriptionEnvironment } from '../src/backend/adapters/common';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';

const FAKE = 'sk-ant-oat01-' + 'x'.repeat(40);

test('a saved long-lived token reaches only Claude processes; a host token never does', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'AIROOM claude-token-'));
  const source = { AIROOM_CLAUDE_HOME: home, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-host-session-token-should-not-pass' };
  try {
    setClaudeOAuthToken(undefined);
    assert.equal(claudeEnvironment(source).CLAUDE_CODE_OAUTH_TOKEN, undefined, 'a token inherited from a host app is stripped');
    assert.equal(claudeOAuthTokenConfigured(), false);
    setClaudeOAuthToken(FAKE);
    assert.equal(claudeEnvironment(source).CLAUDE_CODE_OAUTH_TOKEN, FAKE);
    assert.equal(claudeOAuthTokenConfigured(), true);
    assert.equal(subscriptionEnvironment('codex', source).CLAUDE_CODE_OAUTH_TOKEN, source.CLAUDE_CODE_OAUTH_TOKEN, 'nothing is added to other members');
    assert.ok(!Object.values(subscriptionEnvironment('codex', { AIROOM_CLAUDE_HOME: home })).includes(FAKE), 'Codex never receives the saved token');
    const settings = { ...DEFAULT_SETTINGS, paths: { claude: process.execPath } };
    const tokenLaunch = getClaudeTokenLaunch(settings, source), login = getClaudeLoginLaunch(settings, source);
    assert.equal(tokenLaunch.args.at(-1), 'setup-token');
    assert.equal(tokenLaunch.env.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'making a new token does not run under the old one');
    assert.equal(login.env.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'a browser login does not run under the token either');
  } finally { setClaudeOAuthToken(undefined); await rm(home, { recursive: true, force: true }); }
});

test('the token counts as a subscription login only when AIROOM saved it; API keys and malformed tokens never do', () => {
  setClaudeOAuthToken(undefined);
  assert.throws(() => requireClaudeSubscription({ loggedIn: true, authMethod: 'oauth_token' }), /订阅登录/, 'a token AIROOM did not supply is refused');
  setClaudeOAuthToken(FAKE);
  try { assert.doesNotThrow(() => requireClaudeSubscription({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' })); } finally { setClaudeOAuthToken(undefined); }
  assert.doesNotThrow(() => requireClaudeSubscription({ loggedIn: true, authMethod: 'claude.ai' }));
  assert.throws(() => requireClaudeSubscription({ loggedIn: true, authMethod: 'api_key' }), /未确认订阅登录/);
  assert.throws(() => requireClaudeSubscription({ loggedIn: false, authMethod: 'none' }), /未确认订阅登录/);
  assert.ok(CLAUDE_TOKEN_PATTERN.test(FAKE));
  for (const bad of ['', 'sk-ant-oat01-short', 'hello world', `${FAKE} extra`, 'sk-proj-' + 'x'.repeat(40)]) assert.ok(!CLAUDE_TOKEN_PATTERN.test(bad), bad);
});
