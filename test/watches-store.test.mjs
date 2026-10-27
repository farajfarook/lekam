import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/sqlite.mjs';

const TTL = 3 * 864e5;
const base = { channel: 'CTEAM', thread_ts: '1700000000.000100', host: 'local', owner: 'UOWNER', ttlMs: TTL };

test('register creates, same agent renews (keeping last_seen), other agent supersedes', () => {
  const s = new Store(':memory:');
  const a = s.registerWatch({ ...base, agent_id: 'A', title: 'PR session', message_ts: '1700000000.000200', now: 1000 });
  assert.equal(a.action, 'created');
  assert.equal(a.watch.last_seen_ts, '1700000000.000200', 'replies older than the session post are not replies');
  assert.equal(a.watch.expires_at, 1000 + TTL);
  s.watchSeen(a.watch.id, '1700000000.000300');
  const r = s.registerWatch({ ...base, agent_id: 'A', message_ts: '1700000000.000900', now: 5000 });
  assert.equal(r.action, 'renewed');
  assert.equal(r.watch.id, a.watch.id);
  assert.equal(r.watch.expires_at, 5000 + TTL);
  assert.equal(r.watch.last_seen_ts, '1700000000.000300', 'renewal never moves last_seen forward');
  assert.equal(r.watch.title, 'PR session', 'title kept when not given');
  const b = s.registerWatch({ ...base, agent_id: 'B', now: 6000 });
  assert.equal(b.action, 'replaced');
  assert.equal(s.getWatch(a.watch.id).state, 'superseded');
  assert.equal(s.activeWatchFor(base.channel, base.thread_ts, { now: 7000 }).agent_id, 'B');
  assert.equal(s.listWatches().length, 1);
});

test('renew-only renews an existing watch for that agent and otherwise does nothing', () => {
  const s = new Store(':memory:');
  assert.deepEqual(s.registerWatch({ ...base, agent_id: 'A', renewOnly: true }), { action: 'noop', watch: null });
  assert.equal(s.listWatches().length, 0);
  s.registerWatch({ ...base, agent_id: 'A', now: 1000 });
  assert.equal(s.registerWatch({ ...base, agent_id: 'B', renewOnly: true }).action, 'noop');
  assert.equal(s.registerWatch({ ...base, agent_id: 'A', renewOnly: true, now: 9000 }).watch.expires_at, 9000 + TTL);
});

test('DM watches match any message in the conversation; channel watches only their thread', () => {
  const s = new Store(':memory:');
  s.registerWatch({ ...base, channel: 'DPRIV', agent_id: 'A' });
  assert.ok(s.getWatch(s.listWatches()[0].id).is_dm);
  assert.ok(s.activeWatchFor('DPRIV', '1800000000.000001'), 'unthreaded DM reply matches');
  s.registerWatch({ ...base, agent_id: 'A' });
  assert.ok(s.activeWatchFor('CTEAM', base.thread_ts));
  assert.equal(s.activeWatchFor('CTEAM', '1800000000.000001'), null);
});

test('expiry and unwatch end watches', () => {
  const s = new Store(':memory:');
  const { watch } = s.registerWatch({ ...base, agent_id: 'A', now: 1000 });
  assert.equal(s.activeWatchFor(base.channel, base.thread_ts, { now: 1000 + TTL + 1 }), null, 'past expiry is not active even before the sweep');
  assert.equal(s.expireWatches(1000 + TTL).length, 1);
  assert.equal(s.getWatch(watch.id).state, 'expired');
  s.registerWatch({ ...base, agent_id: 'A' });
  assert.equal(s.stopWatches({ channel: base.channel, thread_ts: base.thread_ts, agent_id: 'Z' }), 0);
  assert.equal(s.stopWatches({ channel: base.channel, thread_ts: base.thread_ts }), 1);
  assert.equal(s.listWatches().length, 0);
});

test('a reply is recorded once; batches group pending replies', () => {
  const s = new Store(':memory:');
  const { watch } = s.registerWatch({ ...base, agent_id: 'A' });
  const r1 = s.addWatchReply(watch.id, { ts: '1700000001.000001', user: 'U1', text: 'one' });
  assert.ok(r1);
  assert.equal(s.addWatchReply(watch.id, { ts: '1700000001.000001', user: 'U1', text: 'one again' }), null);
  const r2 = s.addWatchReply(watch.id, { ts: '1700000002.000001', user: 'U2', text: 'two' });
  s.updateWatchReply(r1.id, { state: 'pending', batch: 'b1' });
  s.updateWatchReply(r2.id, { state: 'pending', batch: 'b1' });
  assert.deepEqual(s.repliesInBatch(watch.id, 'b1').map((r) => r.text), ['one', 'two']);
  assert.equal(s.setBatchState(watch.id, 'b1', 'pending', 'forwarded'), 2);
  assert.equal(s.repliesInBatch(watch.id, 'b1', { state: 'pending' }).length, 0);
});

test('requestBySession finds Lekam-started sessions', () => {
  const s = new Store(':memory:');
  const r = s.createRequest({ kind: 'bot_mention', channel: 'C', thread_ts: '1.1', origin_ts: '1.1', requester: 'U', owner: 'O', request_text: 'x' });
  s.setSession(r.id, 'agent-xyz');
  assert.equal(s.requestBySession('agent-xyz').id, r.id);
  assert.equal(s.requestBySession('nope'), null);
});
