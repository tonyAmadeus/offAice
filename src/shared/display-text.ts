/** Text cleanup for display only; stored records keep their original bytes. */

/** Native CLI output keeps terminal colour/cursor codes (ESC[31m…); show the words only. A colour code whose
 *  ESC was already lost upstream still appears as "[2m", so bare SGR codes are dropped too. */
export function terminalText(text: string) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\[(?:\d{1,3};)*\d{1,3}m/g, '');
}

/** Electron wraps handler errors as "Error invoking remote method '…': Error: …"; keep only the reason. */
export function ipcErrorReason(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/, '');
}
