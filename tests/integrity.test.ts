import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { integrityRid } from '../src/main/integrity';

test('integrity detection uses SID regardless of Windows display language', () => {
  assert.equal(integrityRid('"Mandatory Label\\Low Mandatory Level","S-1-16-4096"'), 4096);
  assert.equal(integrityRid('"强制标签\\中强制级别","S-1-16-8192"'), 8192);
  assert.equal(integrityRid('"label","S-1-16-12288"'), 12288);
  assert.equal(integrityRid('"untrusted","S-1-16-0"'), 0);
});
test('unknown or ambiguous integrity is not treated as a normal token', () => {
  assert.throws(() => integrityRid('access denied'));
  assert.throws(() => integrityRid('S-1-16-4096 S-1-16-8192'));
});
