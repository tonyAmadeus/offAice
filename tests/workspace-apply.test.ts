import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { applyWorkspace, discardWorkspace, prepareWorkspace } from '../src/backend/workspace';
import type { Project, Session } from '../src/shared/types';

test('a git work copy applies tracked changes and deletions but never ignored output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airoom-apply-'));
  try {
    const repo = path.join(root, 'repo'); await fs.mkdir(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true });
    git('init', '-q'); git('config', 'core.autocrlf', 'false');
    await fs.writeFile(path.join(repo, '.gitignore'), 'dist/\n'); await fs.writeFile(path.join(repo, 'a.txt'), 'a'); await fs.writeFile(path.join(repo, 'gone.txt'), 'g');
    git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-qm', 'init');
    const project: Project = { id: 'p', name: 'p', directory: repo, createdAt: '', collaborationPaused: false };
    const session: Session = { id: 's', projectId: 'p', provider: 'codex', title: 't', createdAt: '', updatedAt: '', revision: 1, writeMode: true };
    const prepared = await prepareWorkspace(project, session, true, path.join(root, 'data'));
    assert.equal(prepared.kind, 'worktree');
    await fs.writeFile(path.join(prepared.directory, 'a.txt'), 'a2');
    await fs.unlink(path.join(prepared.directory, 'gone.txt'));
    await fs.mkdir(path.join(prepared.directory, 'dist')); await fs.writeFile(path.join(prepared.directory, 'dist', 'out.js'), 'built');
    const result = await applyWorkspace(prepared.directory, repo);
    assert.deepEqual(result.applied.map(item => `${item.kind}:${item.path}`).sort(), ['deleted:gone.txt', 'modified:a.txt']);
    assert.equal(await fs.readFile(path.join(repo, 'a.txt'), 'utf8'), 'a2');
    await assert.rejects(fs.access(path.join(repo, 'gone.txt')));
    await assert.rejects(fs.access(path.join(repo, 'dist')), 'ignored build output stays in the copy');
    await discardWorkspace({ ...session, workspace: prepared.directory, workspaceKind: 'worktree' }, project, path.join(root, 'data'));
    await assert.rejects(fs.access(prepared.directory));
    assert.ok(!execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' }).includes(path.basename(prepared.directory)), 'the worktree is unregistered');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
