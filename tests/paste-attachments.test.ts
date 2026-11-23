import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { attachmentPath, importPastedImages } from '../src/backend/attachments';
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_MAX } from '../src/shared/attachments';

test('pasted images are stored, and bad pastes are refused', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'airoom-paste-'));
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const [saved] = importPastedImages(dir, [{ type: 'image/png', data: png.toString('base64') }]);
    assert.equal(saved.kind, 'image'); assert.equal(saved.mime, 'image/png'); assert.equal(saved.size, png.length);
    assert.deepEqual(readFileSync(attachmentPath(dir, saved)), png);
    assert.equal(importPastedImages(dir, [{ type: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64') }])[0].name.endsWith('.jpg'), true);
    assert.throws(() => importPastedImages(dir, [{ type: 'image/jpeg', data: 'AAAA' }]), /不是有效的图片/);
    assert.throws(() => importPastedImages(dir, [{ type: 'image/png', data: png.toString('base64') }, { type: 'image/png', data: 'AAAA' }]));
    assert.equal(readdirSync(path.join(dir, 'attachments')).length, 2, 'a batch with any invalid image is refused before anything is written');
    assert.throws(() => importPastedImages(dir, [{ type: 'toString', data: 'AAAA' }]));
    assert.throws(() => importPastedImages(dir, []));
    assert.throws(() => importPastedImages(dir, [{ type: 'text/html', data: 'AAAA' }]));
    assert.throws(() => importPastedImages(dir, [{ type: 'image/png', data: '../../x' }]));
    assert.throws(() => importPastedImages(dir, [{ type: 'image/png', data: 'A'.repeat(Math.ceil(ATTACHMENT_MAX_BYTES * 4 / 3) + 8) }]));
    assert.throws(() => importPastedImages(dir, Array(ATTACHMENTS_MAX + 1).fill({ type: 'image/png', data: 'AAAA' })));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
