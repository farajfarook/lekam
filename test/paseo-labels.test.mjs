import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaseoExecutor } from '../src/executor/paseo.mjs';

function rig({ labels = [], setFails = false } = {}) {
  const calls = [];
  const handle = { id: 'agent1', workspaceId: 'wks_1', current: () => ({ workspaceId: 'wks_1' }), waitForFinish: async () => ({ status: 'idle', lastMessage: 'ok' }) };
  const client = { connect: async () => {}, close: async () => {}, agents: { create: async (o) => { calls.push(['create', o]); return handle; } } };
  const labelClient = {
    connect: async () => calls.push(['connect']), close: async () => {},
    listWorkspaceLabels: async () => ({ labels }),
    setWorkspaceLabel: async (o) => { calls.push(['set', o]); if (setFails) throw new Error('boom'); return {}; },
  };
  const logs = [];
  const ex = new PaseoExecutor({ provider: 'pi/x', cwd: '/tmp/lekam-test-work', config: { guardrails: '', outward_actions: {} }, log: (l, m) => logs.push([l, m]), createClient: async () => client, createLabelClient: async () => labelClient });
  return { ex, calls, logs };
}
const request = { id: 'r1', channel: 'C', thread_ts: '1', owner: 'U', request_text: 'x' };
const brief = { summary: 'Do it', outward_actions: [] };

test('new session workspace gets the existing "Lekam" label, keeping its name and colour', async () => {
  const { ex, calls } = rig({ labels: [{ name: 'Important', color: 'red' }, { name: 'lekam', color: 'teal' }] });
  await ex.start({ request, brief, allowed: [] });
  assert.deepEqual(calls.find((c) => c[0] === 'set')[1], { workspaceId: 'wks_1', label: { name: 'lekam', color: 'teal' }, assigned: true });
});

test('label is created when missing; one connection reused; failures never break the run', async () => {
  let r = rig({ labels: [] });
  await r.ex.start({ request, brief, allowed: [] });
  await r.ex.startInvestigation({ request: { ...request, id: 'r2' }, brief });
  assert.deepEqual(r.calls.filter((c) => c[0] === 'set').map((c) => c[1].label), [{ name: 'Lekam', color: 'amber' }, { name: 'Lekam', color: 'amber' }]);
  assert.equal(r.calls.filter((c) => c[0] === 'connect').length, 1);
  r = rig({ setFails: true });
  const out = await r.ex.start({ request, brief, allowed: [] });
  assert.equal(out.result.text, 'ok');
  assert.ok(r.logs.some(([l, m]) => l === 'warn' && /labelling workspace/.test(m)));
});

test('workspace_label: null turns labelling off', async () => {
  const { ex, calls } = rig();
  ex.workspace_label = null;
  await ex.start({ request, brief, allowed: [] });
  assert.ok(!calls.some((c) => c[0] === 'set'));
});
