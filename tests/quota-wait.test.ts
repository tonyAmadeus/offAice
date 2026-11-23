import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectFlowController } from '../src/backend/project-flow';

// A member out of quota: the user is asked at once whether to wait or hand over, not after 10 minutes.
function controller() {
  const rows = new Map<string, Map<string, any>>(), decisions: any[] = [];
  const table = (name: string) => rows.get(name) ?? rows.set(name, new Map()).get(name)!;
  const fake: any = {
    store: { list: (name: string) => [...table(name).values()], put: (name: string, id: string, v: any) => table(name).set(id, v), members: () => [{ id: 'gpt', name: 'GPT' }] },
    host: { changed() {} },
    quotaFor: () => false,
    record: (projectId: string, flowId: string) => ({ id: `w${table('flow_quota_waits').size}`, projectId, flowId, revision: 1, createdAt: '', updatedAt: '' }),
    need: (_: string, id: string) => ({ id, leadMemberId: 'gpt' }),
    lead: () => 'gpt',
    saveDecision: (d: any) => (decisions.push(d), d),
    update: (name: string, v: any, patch: any) => table(name).set(v.id, { ...v, ...patch }),
  };
  const flow = { id: 'f', projectId: 'p', memberIds: ['gpt', 'claude', 'dsh'] };
  const ask = () => (ProjectFlowController.prototype as any).quotaAllows.call(fake, flow, { id: 'round-1' }, 'gpt', 'integration-check');
  return { ask, decisions, waits: () => [...table('flow_quota_waits').values()] };
}

test('an out-of-quota lead is offered a handover immediately', () => {
  const c = controller();
  assert.equal(c.ask(), false);
  assert.equal(c.decisions.length, 1);
  assert.deepEqual(c.decisions[0].options, ['继续等待', '换人接手']);
  assert.deepEqual(c.decisions[0].eligibleMemberIds, ['claude', 'dsh']);
  assert.equal(c.waits()[0].asked, true);
});

test('after choosing to keep waiting, the question waits 10 minutes', () => {
  const c = controller();
  c.ask();
  // What "继续等待" stores: waiting again from now, already asked once.
  Object.assign(c.waits()[0], { status: 'waiting', decisionId: undefined, startedAt: new Date().toISOString() });
  c.ask();
  assert.equal(c.decisions.length, 1);
});
