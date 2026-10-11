import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { claudeCandidate, codexCandidates, memoryCandidates, memorySources } from '../src/backend/desktop-memory';

const CODEX_SUMMARY = `v1

## User Profile

The user builds Windows-local AI systems
and prefers stable setups.

## User preferences

- 回答先给结论。
- Prefer a desktop app over a browser page.

## Task Group: AIROOM

- 不应导入的项目记录
`;

test('Codex memory: only the profile and preference sections, one item per bullet or paragraph', () => {
  const items = codexCandidates(CODEX_SUMMARY);
  assert.deepEqual(items.map(item => item.text), ['The user builds Windows-local AI systems and prefers stable setups.', '回答先给结论。', 'Prefer a desktop app over a browser page.']);
  assert.deepEqual([...new Set(items.map(item => item.origin))], ['Codex 记忆 · User Profile', 'Codex 记忆 · User preferences']);
});

test('Claude memory: the body is the fact and the front matter names it', () => {
  const item = claudeCandidate('---\nname: review-format\ndescription: x\n---\n\nSplit reviews into 已核实 / 需实测 / 建议. See [[airoom]].\n', 'review.md');
  assert.deepEqual(item, { text: 'Split reviews into 已核实 / 需实测 / 建议. See airoom.', origin: 'Claude 记忆 · review-format' });
  assert.equal(claudeCandidate('---\nname: empty\n---\n', 'empty.md'), undefined);
});

test('sources and candidates come only from the memory folders; a project outside the list is refused', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'AIROOM memory-'));
  try {
    assert.deepEqual(await memorySources('codex', root), [], 'no summary, no source');
    await fs.mkdir(path.join(root, '.codex', 'memories'), { recursive: true });
    await fs.writeFile(path.join(root, '.codex', 'memories', 'memory_summary.md'), CODEX_SUMMARY);
    assert.deepEqual((await memorySources('codex', root)).map(source => source.id), ['codex-summary']);
    assert.equal((await memoryCandidates('codex', 'codex-summary', root)).length, 3);

    const project = path.join(root, '.claude', 'projects', 'C--Users-me-Desktop-app');
    await fs.mkdir(path.join(project, 'memory'), { recursive: true });
    await fs.mkdir(path.join(root, '.claude', 'projects', 'C--empty'), { recursive: true });
    await fs.writeFile(path.join(project, 'memory', 'MEMORY.md'), '- [index](a.md) — not a fact');
    await fs.writeFile(path.join(project, 'memory', 'a.md'), '---\nname: a\n---\nUses TypeScript.');
    await fs.writeFile(path.join(project, 'memory', 'b.md'), 'Likes short answers.');
    const sources = await memorySources('claude', root);
    assert.deepEqual(sources, [{ id: 'claude:C--Users-me-Desktop-app', label: 'Claude 项目记忆：C:\\Users\\me\\Desktop\\app', count: 2 }]);
    assert.deepEqual((await memoryCandidates('claude', sources[0].id, root)).map(item => item.text), ['Uses TypeScript.', 'Likes short answers.']);
    await assert.rejects(memoryCandidates('claude', 'claude:..', root), /没有找到/);
    await assert.rejects(memoryCandidates('claude', 'claude:C--Users-me-Desktop-app/../..', root), /没有找到/);
    await assert.rejects(memoryCandidates('dsh', 'anything', root), /没有可以导入/);
    assert.deepEqual(await memorySources('dsh', root), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
