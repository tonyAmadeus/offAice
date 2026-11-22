import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/backend/engine';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';

// Room speech may act, but only one speaker per room at a time; votes stay read-only.
function engine(active: any[] = []) {
  const project = { id: 'lounge', name: '茶歇室', directory: 'C:\\lounge', createdAt: '', collaborationPaused: false, kind: 'lounge', roomId: 'global' };
  const fake: any = {
    settings: DEFAULT_SETTINGS, key: undefined,
    active: new Map(active.map((ctx, i) => [`other-${i}`, { ctx }])),
    require: () => project,
    memberFor: () => ({ id: 'claude', name: 'Claude', executor: 'claude' }),
    runConfiguration: () => ({ model: 'm', effort: 'e' }),
    persistRun() {}, projectRoomDirectory: () => undefined, roomContextInputs: new Map(),
    store: { dataDirectory: 'C:\\data', get: () => undefined, put() {}, members: () => [], profile: () => ({}) },
  };
  return (purpose?: string) => (Engine.prototype as any).context.call(fake,
    { id: 'run-1', provider: 'claude', requestedConfig: { model: 'm', effort: 'e' } },
    { id: 's1', projectId: 'lounge', provider: 'claude', writeMode: false, purpose });
}

test('room speech acts when no one else is acting in the room', () => {
  const ctx = engine()();
  assert.equal(ctx.session.writeMode, true);
  assert.notEqual(ctx.settings.permissions.claude.commands, 'deny');
});

test('a second speaker in the same room talks read-only while another acts', () => {
  const ctx = engine([{ run: { id: 'run-0' }, session: { projectId: 'lounge', writeMode: true } }])();
  assert.equal(ctx.session.writeMode, false);
  assert.equal(ctx.settings.permissions.claude.commands, 'deny');
});

test('an acting speaker in another room does not block this one', () => {
  assert.equal(engine([{ run: { id: 'run-0' }, session: { projectId: 'elsewhere', writeMode: true } }])().session.writeMode, true);
});

test('hand votes stay read-only', () => {
  const ctx = engine()('room-hand');
  assert.equal(ctx.session.writeMode, false);
  assert.equal(ctx.settings.permissions.claude.commands, 'deny');
});
