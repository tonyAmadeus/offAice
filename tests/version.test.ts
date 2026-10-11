import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { acceptRunningVersion, runningVersion } from '../src/main/version';

async function deployed(receipt: Record<string, unknown> | undefined, commit = 'eaced6f89f73ec468c39640fe5c4cf6ce3cc558c') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'AIROOM version-'));
  await writeFile(path.join(directory, 'build-manifest.json'), JSON.stringify({ builtAt: '2026-10-05T05:50:23.879Z', sourceCommit: commit, sourceDirty: false, hashes: {} }));
  // PowerShell writes the receipt with a byte-order mark.
  if (receipt) await writeFile(path.join(directory, 'deployment-receipt.json'), '\uFEFF' + JSON.stringify(receipt));
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('the running build, its deployment and the user\'s acceptance are read and recorded in the receipt', async () => {
  const d = await deployed({ deployedAt: '2026-10-05T13:51:40+08:00', sourceCommit: 'eaced6f89f73ec468c39640fe5c4cf6ce3cc558c', hashes: { 'AIROOM.exe': 'x' }, userSessionAcceptance: 'pending' });
  try {
    const before = runningVersion(d.directory, true);
    assert.deepEqual({ ...before }, { development: false, sourceCommit: 'eaced6f89f73ec468c39640fe5c4cf6ce3cc558c', builtAt: '2026-10-05T05:50:23.879Z', sourceDirty: false, deployedAt: '2026-10-05T13:51:40+08:00', acceptance: 'pending' });
    const after = acceptRunningVersion(d.directory, true, new Date('2026-10-06T01:00:00Z'));
    assert.equal(after.acceptance, 'accepted'); assert.equal(after.acceptedAt, '2026-10-06T01:00:00.000Z');
    const saved = JSON.parse(await readFile(path.join(d.directory, 'deployment-receipt.json'), 'utf8'));
    assert.deepEqual(saved.hashes, { 'AIROOM.exe': 'x' }, 'the rest of the receipt is kept');
    assert.equal(acceptRunningVersion(d.directory, true).acceptedAt, '2026-10-06T01:00:00.000Z', 'accepting again keeps the first time');
  } finally { await d.cleanup(); }
});

test('a development run, a missing receipt or a receipt for another build cannot be accepted', async () => {
  assert.deepEqual(runningVersion('C:\\nowhere', false), { development: true });
  assert.throws(() => acceptRunningVersion('C:\\nowhere', false), /开发版本/);
  const missing = await deployed(undefined), other = await deployed({ sourceCommit: '009a1ac', userSessionAcceptance: 'pending' });
  try {
    assert.equal(runningVersion(missing.directory, true).acceptance, undefined);
    assert.throws(() => acceptRunningVersion(missing.directory, true), /部署记录/);
    assert.equal(runningVersion(other.directory, true).mismatch, true);
    assert.throws(() => acceptRunningVersion(other.directory, true), /部署记录/);
  } finally { await missing.cleanup(); await other.cleanup(); }
});
