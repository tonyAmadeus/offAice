import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { KeyboardEvent } from 'react';
import { isSendKey } from '../src/renderer/composer-keys';

const key = (init: { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; composing?: boolean; keyCode?: number }) =>
  ({ key: init.key, shiftKey: !!init.shiftKey, altKey: !!init.altKey, ctrlKey: !!init.ctrlKey, keyCode: init.keyCode ?? 13, nativeEvent: { isComposing: !!init.composing } }) as unknown as KeyboardEvent<HTMLTextAreaElement>;

test('Enter sends, Shift + Enter starts a new line, and confirming a pinyin candidate never sends', () => {
  assert.equal(isSendKey(key({ key: 'Enter' })), true);
  assert.equal(isSendKey(key({ key: 'Enter', ctrlKey: true })), true, 'the old Ctrl + Enter habit still sends');
  assert.equal(isSendKey(key({ key: 'Enter', shiftKey: true })), false);
  assert.equal(isSendKey(key({ key: 'Enter', composing: true })), false);
  assert.equal(isSendKey(key({ key: 'Enter', keyCode: 229 })), false);
  assert.equal(isSendKey(key({ key: 'a' })), false);
});
