import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { storedDshLogin } from '../src/backend/adapters/dsh';

// Same layout DSH's credentials-local provider writes (values replaced).
const signedIn = 'version: 1\nrecords:\n  deepseek-account-platform/device:\n    kind: grant\n    payload: x\n  deepseek-account-platform/default:\n    kind: grant\n    payload:\n      token: x\n';

test('the chat preflight reads the stored DSH login without starting DSH', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'airoom-dsh-'));
  const file = path.join(home, '.credentials.yaml');
  try {
    assert.equal(await storedDshLogin(home), false, 'no file: signed out');
    writeFileSync(file, signedIn);
    assert.equal(await storedDshLogin(home), true, 'grant stored: signed in');
    writeFileSync(file, signedIn.replace(/\r?\n/g, '\r\n'));
    assert.equal(await storedDshLogin(home), true, 'Windows line endings');
    writeFileSync(file, 'version: 1\nrecords:\n  deepseek-account-platform/device:\n    kind: grant\n    payload: x\n');
    assert.equal(await storedDshLogin(home), false, 'only the device record: signed out');
    writeFileSync(file, signedIn.replace('  deepseek-account-platform/default:', '  "deepseek-account-platform/default":'));
    assert.equal(await storedDshLogin(home), undefined, 'quoted key: ask DSH, never read as signed out');
    writeFileSync(file, 'version: 1\nrecords: {"deepseek-account-platform/default": {kind: grant, payload: {token: x}}}\n');
    assert.equal(await storedDshLogin(home), undefined, 'inline mapping: ask DSH');
    writeFileSync(file, 'version: 2\nrecords: {}\n');
    assert.equal(await storedDshLogin(home), undefined, 'unknown format: ask DSH');
    writeFileSync(file, signedIn.replace('kind: grant\n    payload:\n      token', 'kind: other\n    payload:\n      token'));
    assert.equal(await storedDshLogin(home), undefined, 'unexpected record kind: ask DSH');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
