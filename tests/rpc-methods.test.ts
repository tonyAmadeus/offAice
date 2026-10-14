import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { RENDERER_METHODS } from '../src/shared/rpc-methods';
import { ROUNDTABLE_READS, ROUNDTABLE_WRITES } from '../src/shared/roundtable';
import { PROJECT_FLOW_METHODS } from '../src/shared/project-flow';
import { AUTOMATION_RPC_METHODS } from '../src/shared/automation';

const source = (file: string) => readFileSync(path.join('src', file), 'utf8');
const files = (directory: string) => readdirSync(path.join('src', directory)).filter(name => /\.tsx?$/.test(name)).map(name => source(path.join(directory, name)));
const quoted = (text: string, pattern: RegExp) => new Set([...text.matchAll(pattern)].map(match => match[2]));

test('the allowlist has no duplicates', () => {
  assert.equal(new Set(RENDERER_METHODS).size, RENDERER_METHODS.length);
});

test('every request the workbench names literally is on the allowlist', () => {
  const renderer = files('renderer').join('\n');
  const named = quoted(renderer, /(?:invoke|perform)(?:<[^>()]*>)?\(\s*(['"])([a-zA-Z]+\.[a-zA-Z.]+)\1/g);
  assert.ok(named.size > 50, `found ${named.size} request names`);
  const allowed = new Set(RENDERER_METHODS);
  assert.deepEqual([...named].filter(method => !allowed.has(method)).sort(), []);
});

test('every allowlisted request has a handler in the main process or the backend', () => {
  const backend = files('backend').join('\n'), main = source('main/main.ts');
  const handled = new Set([
    ...quoted(backend, /case (['"])([^'"]+)\1:/g),
    ...quoted(backend, /method ?=== ?(['"])([^'"]+)\1/g),
    ...quoted(main, /method ?=== ?(['"])([^'"]+)\1/g),
    ...ROUNDTABLE_READS, ...ROUNDTABLE_WRITES, ...PROJECT_FLOW_METHODS, ...AUTOMATION_RPC_METHODS,
  ]);
  assert.deepEqual(RENDERER_METHODS.filter(method => !handled.has(method)).sort(), []);
});
