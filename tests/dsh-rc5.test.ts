import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDshPatch } from '../src/backend/adapters/dsh';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';

const tools = (executorTools: boolean) => buildDshPatch(DEFAULT_SETTINGS as any, String.raw`C:\work`, false, String.raw`C:\guard.mjs`, undefined, [], executorTools).find((row: any) => row.id === 'tools');

test('DSH tools settings match the installed version', () => {
  // 0.2.0-rc.2 needs the explicit native/serial settings; 0.2.2+ rejects them and defaults to the native executor.
  assert.deepEqual(tools(false), { id: 'tools', config: { mode: 'native', maxParallelSubCalls: 1 } });
  assert.deepEqual(tools(true), { id: 'tools' });
});

test('DSH persona names the working folder directly, without template slots DSH 0.2.2 rejects', () => {
  const suffix = (cwd: string, persona?: string) => (buildDshPatch(DEFAULT_SETTINGS as any, cwd, false, String.raw`C:\guard.mjs`, persona).find((row: any) => row.id === 'system-prompt') as any).config.personaSuffix as string;
  assert.ok(suffix(String.raw`C:\work\{{x}}`).startsWith(String.raw`Your working directory is C:\work\{ {x} }.`));
  // Runs of three or more braces, in the path or the member card, never leave two braces side by side.
  for (const text of [suffix(String.raw`C:\a\{{{x}}}`), suffix(String.raw`C:\work`, '{{{name}}} and }}{{'), suffix('C:/中文 資料夾')]) {
    assert.doesNotMatch(text, /[{}]{2}/);
  }
  assert.ok(suffix('C:/中文 資料夾').includes('C:/中文 資料夾'));
});
