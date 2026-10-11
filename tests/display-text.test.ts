import test from 'node:test';
import assert from 'node:assert/strict';
import { ipcErrorReason, terminalText } from '../src/shared/display-text';

test('terminal colour and cursor codes are removed from displayed logs, with or without the ESC byte', () => {
  assert.equal(terminalText('\x1b[2m2026-10-08\x1b[0m \x1b[31mERROR\x1b[0m websocket closed'), '2026-10-08 ERROR websocket closed');
  assert.equal(terminalText('[2m2026-10-08[0m [31mERROR[0m codex_api'), '2026-10-08 ERROR codex_api');
  assert.equal(terminalText('\x1b]0;title\x07done\x1b[2K'), 'done');
  assert.equal(terminalText('items[0] = list[12]; [警告] 保留'), 'items[0] = list[12]; [警告] 保留');
});

test('IPC errors show only the reason, not Electron\'s remote-method prefix', () => {
  assert.equal(ipcErrorReason(new Error("Error invoking remote method 'airoom:invoke': Error: 这位成员不在会议里")), '这位成员不在会议里');
  assert.equal(ipcErrorReason(new Error("Error invoking remote method 'airoom:invoke': TypeError: bad")), 'bad');
  assert.equal(ipcErrorReason(new Error('执行服务尚未就绪')), '执行服务尚未就绪');
  assert.equal(ipcErrorReason('plain'), 'plain');
});
