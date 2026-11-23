import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DshAdapter, storedDshLogin } from '../src/backend/adapters/dsh';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';

const signedIn = `version: 1
records:
  deepseek-account-platform/default:
    kind: grant
    payload:
      version: 1
      token: test-token
      issuer: https://platform.deepseek.com
`;

const versionTwo = `version: 2
records:
  deepseek-account-platform/default:
    kind: grant
    payload:
      token: test-token
`;

async function homeWith(credentials?: string) {
  const home = await mkdtemp(path.join(tmpdir(), 'airoom-dsh-probe-'));
  if (credentials !== undefined) await writeFile(path.join(home, '.credentials.yaml'), credentials);
  return home;
}

// probe calls these through `this`, so a plain object can stand in for the adapter.
function fakeAdapter(home: string, status: (mode: string) => Promise<any>) {
  const calls: string[] = [];
  const fake: any = {
    home: () => home,
    command: async () => 'dsh',
    collect: async () => '0.2.0-rc.2',
    launch: async () => {},
    request: async (method: string) => method === 'session/new' ? { sessionId: 'session-1', configOptions: [] } : {},
    cleanup: async () => {},
    accountStatus: async (_settings: any, _env: any, mode: string = 'probe') => {
      calls.push(mode);
      return status(mode);
    },
    imagePrompts: false,
  };
  return { fake, calls };
}

function probe(fake: any, home: string) {
  return DshAdapter.prototype.probe.call(fake, DEFAULT_SETTINGS as any, { AIROOM_DSH_HOME: home });
}

test('storedDshLogin reports the stored account grant without starting DSH', async (t) => {
  const signed = await homeWith(signedIn);
  t.after(() => rm(signed, { recursive: true, force: true }));
  assert.equal(await storedDshLogin(signed), true);

  const missing = await homeWith();
  t.after(() => rm(missing, { recursive: true, force: true }));
  assert.equal(await storedDshLogin(missing), false);

  const unknown = await homeWith(versionTwo);
  t.after(() => rm(unknown, { recursive: true, force: true }));
  assert.equal(await storedDshLogin(unknown), undefined);
});

test('a failed online probe falls back to the stored grant and keeps DSH available', async (t) => {
  const home = await homeWith(signedIn);
  t.after(() => rm(home, { recursive: true, force: true }));
  const { fake, calls } = fakeAdapter(home, async () => { throw new Error('probe timed out'); });
  const result = await probe(fake, home);
  assert.equal(result.available, true);
  assert.equal(result.auth, 'account');
  assert.match(result.detail!, /在线核对这次没有完成/);
  // The second confirmation reads the store instead of launching DSH again.
  assert.deepEqual(calls, ['probe']);
});

test('a failed online probe without a stored grant reports signed out', async (t) => {
  const home = await homeWith();
  t.after(() => rm(home, { recursive: true, force: true }));
  const { fake, calls } = fakeAdapter(home, async () => { throw new Error('probe timed out'); });
  const result = await probe(fake, home);
  assert.equal(result.available, false);
  assert.equal(result.auth, 'none');
  assert.equal(result.detail, 'DeepSeek 还未登录，请点击登录。');
  assert.deepEqual(calls, ['probe']);
});

test('a successful online probe never runs the state check when the grant is stored', async (t) => {
  const home = await homeWith(signedIn);
  t.after(() => rm(home, { recursive: true, force: true }));
  const { fake, calls } = fakeAdapter(home, async () => ({ authenticated: true, state: 'signed-in' }));
  const result = await probe(fake, home);
  assert.equal(result.available, true);
  assert.equal(result.auth, 'account');
  assert.deepEqual(calls, ['probe']);
});

test('an unreadable credential version plus a failed state check stays unknown instead of throwing', async (t) => {
  const home = await homeWith(versionTwo);
  t.after(() => rm(home, { recursive: true, force: true }));
  const { fake, calls } = fakeAdapter(home, async (mode) => {
    if (mode === 'state') throw new Error('state timed out');
    return { authenticated: true, state: 'signed-in' };
  });
  const result = await probe(fake, home);
  assert.equal(result.auth, 'unknown');
  assert.match(result.detail!, /登录状态暂时无法确认/);
  assert.deepEqual(calls, ['probe', 'state']);
});
