import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { attachmentPath, describeAttachments, importAttachments, pruneAttachments, resolveAttachments } from '../src/backend/attachments';
import { attachmentKind, safeAttachmentName } from '../src/shared/attachments';

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'AIROOM attach-'));
  const data = path.join(root, 'data'), files = path.join(root, '原始文件');
  await fs.mkdir(files, { recursive: true });
  return { root, data, files, dispose: () => fs.rm(root, { recursive: true, force: true }) };
}

test('kinds and safe names', () => {
  assert.deepEqual(['a.PNG', 'b.md', 'c.pdf', 'd.tsx', 'noext'].map(attachmentKind), ['image', 'text', 'file', 'text', 'file']);
  assert.equal(safeAttachmentName('C:\\Users\\me\\报告:v1?.txt'), '报告_v1_.txt');
  assert.equal(safeAttachmentName('..\\..\\.secret'), 'secret');
});

test('imported files are copies in the store; folders, oversized files and too many files are refused', async () => {
  const w = await workspace();
  try {
    const note = path.join(w.files, '需求.md'), picture = path.join(w.files, 'screen.png');
    await fs.writeFile(note, '# 需求\n先做登录页'); await fs.writeFile(picture, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const [text, image] = importAttachments(w.data, [note, picture]);
    assert.deepEqual([text.name, text.kind, text.mime, image.kind, image.mime], ['需求.md', 'text', 'text/plain', 'image', 'image/png']);
    assert.equal(await fs.readFile(attachmentPath(w.data, text), 'utf8'), '# 需求\n先做登录页');
    assert.equal(await fs.readFile(note, 'utf8'), '# 需求\n先做登录页', 'the original stays put');
    assert.throws(() => importAttachments(w.data, [w.files]), /不是文件/);
    const big = path.join(w.files, 'big.bin'); await fs.writeFile(big, ''); await fs.truncate(big, 21 * 1024 * 1024);
    assert.throws(() => importAttachments(w.data, [big]), /超过 20\.0 MB/);
    assert.throws(() => importAttachments(w.data, Array.from({ length: 11 }, () => note)), /最多附 10 个/);
    assert.throws(() => importAttachments(w.data, ['relative.txt']), /没有收到/);
  } finally { await w.dispose(); }
});

test('only stored copies are accepted, with kind and size taken from disk', async () => {
  const w = await workspace();
  try {
    const note = path.join(w.files, 'a.txt'); await fs.writeFile(note, 'hello');
    const [stored] = importAttachments(w.data, [note]);
    const [resolved] = resolveAttachments(w.data, [{ ...stored, kind: 'image', size: 1 }]);
    assert.deepEqual([resolved.kind, resolved.size, resolved.path], ['text', 5, attachmentPath(w.data, stored)]);
    assert.equal(resolveAttachments(w.data, [stored, stored]).length, 1, 'duplicates collapse');
    assert.deepEqual(resolveAttachments(w.data, undefined), []);
    assert.throws(() => resolveAttachments(w.data, [{ id: stored.id, name: '..\\a.txt' }]), /附件无效/);
    assert.throws(() => resolveAttachments(w.data, [{ id: 'not-an-id', name: 'a.txt' }]), /附件无效/);
    assert.throws(() => resolveAttachments(w.data, [{ id: '00000000-0000-0000-0000-000000000000', name: 'a.txt' }]), /已不存在/);
  } finally { await w.dispose(); }
});

test('members get text inline, images as pictures or an honest note, and other files by path only where they can open them', async () => {
  const w = await workspace();
  try {
    await fs.writeFile(path.join(w.files, '需求.md'), '先做登录页');
    await fs.writeFile(path.join(w.files, 'shot.png'), Buffer.from([1, 2, 3]));
    await fs.writeFile(path.join(w.files, 'spec.pdf'), Buffer.from([0, 1, 2]));
    const stored = resolveAttachments(w.data, importAttachments(w.data, ['需求.md', 'shot.png', 'spec.pdf'].map(name => path.join(w.files, name))));
    const room = describeAttachments(stored, { images: false, paths: false });
    assert.match(room, /- 需求\.md（文本，内容在下方）/);
    assert.match(room, /#### 需求\.md\n```\n先做登录页\n```/);
    assert.match(room, /shot\.png（图片）：你当前的程序收不到图片内容，不要猜测/);
    assert.match(room, /spec\.pdf（3 B）：聊天室里无法打开/);
    assert.doesNotMatch(room, /attachments[\\/]/, 'no paths in the room');
    const project = describeAttachments(stored, { images: true, paths: true });
    assert.match(project, /shot\.png（图片，已随消息附上）/);
    assert.ok(project.includes(stored[2].path), 'other files are given by path in projects');
    assert.equal(describeAttachments([], { images: true, paths: true }), '');
  } finally { await w.dispose(); }
});

test('cleanup removes copies nothing refers to: released ids at once, other leftovers only after the grace period', async () => {
  const w = await workspace();
  try {
    const files = ['a.txt', 'b.txt', 'c.txt'].map(name => path.join(w.files, name));
    for (const file of files) await fs.writeFile(file, 'x');
    const [kept, released, fresh] = importAttachments(w.data, files);
    const exists = (id: string) => fs.stat(path.join(w.data, 'attachments', id)).then(() => true, () => false);
    assert.equal(pruneAttachments(w.data, new Set([kept.id]), { only: [kept.id, released.id] }), 1);
    assert.deepEqual([await exists(kept.id), await exists(released.id), await exists(fresh.id)], [true, false, true], 'a referenced copy and one not released stay');
    assert.equal(pruneAttachments(w.data, new Set([kept.id])), 0, 'a fresh copy may still be waiting in a composer');
    assert.equal(pruneAttachments(w.data, new Set([kept.id]), { now: Date.now() + 25 * 3600_000 }), 1);
    assert.deepEqual([await exists(kept.id), await exists(fresh.id)], [true, false]);
  } finally { await w.dispose(); }
});
