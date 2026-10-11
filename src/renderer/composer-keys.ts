import type { KeyboardEvent } from 'react';

/** Enter sends and Shift + Enter starts a new line. An Enter that confirms an input-method candidate (pinyin) never sends. */
export function isSendKey(event: KeyboardEvent<HTMLTextAreaElement>) {
  return event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing && event.keyCode !== 229;
}
