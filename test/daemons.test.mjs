import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Daemons } from '../src/executor/daemons.mjs';

function fakeClients(script = {}) {
  const made = [];
  const createClient = async (url, host) => {
    const c = { url, host, connected: false, closed: false, calls: [],
      async connect() { if (script.failConnect?.has(host)) throw new Error('ECONNREFUSED'); this.connected = true; },
      async close() { this.closed = true; },
      async fetchAgents(o) { this.calls.push(['fetchAgents', o]); if (script.failOnce?.has(host)) { script.failOnce.delete(host); throw new Error('socket closed'); } return { entries: script.agents ?? [] }; },
      async fetchAgentTimeline(id, o) { this.calls.push(['timeline', id, o]); return { entries: [{ item: { type: 'tool_call' } }] }; },
      async fetchAgent(id) { this.calls.push(['fetchAgent', id]); return script.agent === null ? null : { agent: script.agent ?? { id, status: 'idle', archivedAt: null, title: 'T' } }; },
      async waitForFinish(id, t) { this.calls.push(['wait', id, t]); return { status: script.waitStatus ?? 'idle' }; },
      async sendAgentMessage(id, text, o) { this.calls.push(['send', id, text, o]); return { accepted: true }; },
    };
    made.push(c); return c;
  };
  return { made, createClient };
}

test('host targets: local means the configured local URL; ssh targets go to the SDK as given', async () => {
  const f = fakeClients();
  const d = new Daemons({ hosts: { a: 'local', b: 'ssh://root@boxb.internal' }, localUrl: 'ws://127.0.0.1:6767/ws', createClient: f.createClient });
  await d.check('a'); await d.check('b'); await d.check('a');
  assert.deepEqual(f.made.map((c) => [c.host, c.url]), [['a', 'ws://127.0.0.1:6767/ws'], ['b', 'ssh://root@boxb.internal']], 'one client per host, reused');
  await assert.rejects(d.check('c'), /unknown host "c"/);
});

test('a failed call drops the connection and the next call reconnects', async () => {
  const f = fakeClients({ failOnce: new Set(['a']) });
  const d = new Daemons({ hosts: { a: 'local' }, createClient: f.createClient });
  await assert.rejects(d.check('a'), /a: socket closed/);
  assert.ok(f.made[0].closed);
  await d.check('a');
  assert.equal(f.made.length, 2);
});

test('recent agents: newest first, stops at the lookback, normalised', async () => {
  const now = Date.now();
  const agents = [
    { agent: { id: 'n1', title: 'New', status: 'Running', updatedAt: new Date(now - 1000).toISOString(), labels: { x: '1' }, archivedAt: null } },
    { agent: { id: 'n2', title: 'Also new', status: 'idle', updatedAt: new Date(now - 60e3).toISOString(), archivedAt: '2026-01-01' } },
    { agent: { id: 'old', status: 'idle', updatedAt: new Date(now - 3600e3).toISOString() } },
  ];
  const f = fakeClients({ agents });
  const d = new Daemons({ hosts: { a: 'local' }, createClient: f.createClient });
  const r = await d.listRecentAgents('a', now - 10 * 60e3);
  assert.deepEqual(r.map((x) => [x.id, x.status, x.archived]), [['n1', 'running', false], ['n2', 'idle', true]]);
  assert.deepEqual(f.made[0].calls[0][1].sort, [{ key: 'updated_at', direction: 'desc' }]);
  await d.timeline('a', 'n1', { limit: 50 });
  assert.deepEqual(f.made[0].calls.at(-1), ['timeline', 'n1', { direction: 'tail', limit: 50 }]);
});

test('status, wait and send', async () => {
  const f = fakeClients({ waitStatus: 'running' });
  const d = new Daemons({ hosts: { a: 'local' }, createClient: f.createClient });
  assert.deepEqual(await d.status({ agent_id: 'x', host: 'a' }), { status: 'idle', archived: false, title: 'T' });
  await assert.rejects(d.waitIdle({ agent_id: 'x', host: 'a' }, 60e3), /still busy/);
  await d.send({ agent_id: 'x', host: 'a' }, 'hello');
  assert.deepEqual(f.made.at(-1).calls.at(-1), ['send', 'x', 'hello', { activeTurnBehavior: 'steer' }], 'never interrupts a turn that started after the wait');
  const g = fakeClients({ agent: null });
  await assert.rejects(new Daemons({ hosts: { a: 'local' }, createClient: g.createClient }).status({ agent_id: 'gone', host: 'a' }), /not found/);
});
