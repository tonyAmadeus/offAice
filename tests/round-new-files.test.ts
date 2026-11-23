import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FlowArtifacts } from '../src/backend/project-flow-artifacts';

// 2026-11-23: QQQ.json was saved into the project after the round began; the integration check could not see it.
test('files the user adds to the project mid-round reach the round copy; existing files are left alone', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'airoom-round-'));
  const project = path.join(dir, 'project'), base = path.join(dir, 'base'), work = path.join(dir, 'work');
  const put = (root: string, name: string, text: string) => { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), text); };
  try {
    put(base, 'report.md', 'old'); put(work, 'report.md', 'member edit');
    put(project, 'report.md', 'user edit after start'); put(project, '探測/QQQ.json', '{"data":1}');
    put(work, 'task-only.txt', 'from the member'); put(project, 'task-only.txt', 'different');
    const artifacts = new FlowArtifacts({ get: () => ({ directory: project }) } as any);
    const added = await artifacts.addProjectFiles('p', base, work);
    assert.deepEqual(added, ['探測/QQQ.json']);
    assert.equal(readFileSync(path.join(work, '探測/QQQ.json'), 'utf8'), '{"data":1}');
    assert.equal(readFileSync(path.join(work, 'report.md'), 'utf8'), 'member edit', 'a file in the base is never overwritten');
    assert.equal(readFileSync(path.join(work, 'task-only.txt'), 'utf8'), 'from the member', 'a file the copy already has is kept');
    assert.equal(existsSync(path.join(base, '探測/QQQ.json')), false, 'the base stays as it was');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
