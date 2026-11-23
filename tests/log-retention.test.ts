import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/backend/store';

test('daily event logs older than 30 days are removed at start; recent ones and other files stay', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'airoom-logs-')), logs = path.join(dir, 'logs');
  mkdirSync(logs, { recursive: true });
  const day = (ago: number) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10) + '.jsonl';
  for (const name of [day(40), day(29), day(0), 'room-runtime.jsonl']) writeFileSync(path.join(logs, name), '{}\n');
  const store: any = new Store(dir);
  try {
    assert.equal(existsSync(path.join(logs, day(40))), false);
    for (const name of [day(29), day(0), 'room-runtime.jsonl']) assert.equal(existsSync(path.join(logs, name)), true, name);
  } finally { store.db?.close?.(); rmSync(dir, { recursive: true, force: true }); }
});
