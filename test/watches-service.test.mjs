import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, cls, OWNER, REQ, CHAN } from './helpers.mjs';
import { ACTIONS } from '../src/approvals/cards.mjs';

const TTL = 3 * 864e5;
const ack = () => cls({ intent: 'chitchat', actionable: false, brief: null, reply_to_user: null });
const info = () => cls({ intent: 'fyi', actionable: true, brief: null, reply_to_user: null });

/** The session (posting as the owner) starts a thread and registers a watch on it. */
function sessionPost(h, { agent = 'ag1', host = 'local', channel = CHAN, title = 'PR-42 review' } = {}) {
  const ts = h.chat.ts();
  h.chat.thread(channel, ts).push({ user: OWNER, text: 'hey @Priya, ready for review', ts });
  const { watch } = h.store.registerWatch({ channel, thread_ts: ts, agent_id: agent, host, owner: OWNER, title, message_ts: ts, ttlMs: TTL });
  return { ts, watch };
}
const watchCards = (h) => h.chat.dms.filter((d) => JSON.stringify(d.blocks ?? []).includes(ACTIONS.WATCH_FORWARD));
const buttonValue = (msg, action) => msg.blocks.flatMap((b) => b.elements ?? []).find((e) => e.action_id === action)?.value;
const lastUpdate = (h, card) => [...h.chat.updates].reverse().find((u) => u.ts === card.ts);
const text = (m) => JSON.stringify(m.blocks ?? m.text);

test('a reply in a watched thread becomes a card; Forward sends it to the waiting session and renews the watch', async () => {
  const h = await harness({ brainScript: info, watchAgents: { ag1: { status: 'idle' } } });
  const { ts, watch } = sessionPost(h);
  assert.equal(await h.svc.isEngagedThread(CHAN, ts), true, 'watched threads are engaged so untagged replies come through');
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: ts, user: REQ, text: 'I left two comments on the PR' });
  const cards = watchCards(h);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].user, OWNER);
  assert.match(text(cards[0]), /I left two comments on the PR/);
  assert.match(text(cards[0]), /PR-42 review/);
  assert.equal(h.watchExec.calls.length, 0, 'nothing reaches the session before the tap');
  assert.equal(h.brain.calls[0].input.kind, 'watch_reply');
  assert.equal(h.brain.calls[0].input.watchedSession, 'PR-42 review');

  const before = h.store.getWatch(watch.id).expires_at;
  await new Promise((r) => setTimeout(r, 2));
  await h.chat.click(ACTIONS.WATCH_FORWARD, buttonValue(cards[0], ACTIONS.WATCH_FORWARD), OWNER, cards[0]);
  const send = h.watchExec.calls.find((c) => c[0] === 'send');
  assert.ok(send);
  assert.equal(send[1], 'ag1');
  assert.match(send[3], /<chat-followup from="name:UREQ"/);
  assert.match(send[3], /I left two comments on the PR/);
  assert.match(send[3], /not from Faraj/);
  assert.match(text(lastUpdate(h, cards[0])), /Forwarded/);
  assert.ok(h.store.getWatch(watch.id).expires_at > before, 'forwarding renews the watch');
  assert.ok(h.store.auditTail(20).some((r) => r.type === 'watch_delivered'));
});

test('a tag of the owner in a watched thread goes to the watch, not the owner-tag flow', async () => {
  const h = await harness({ brainScript: info, watchAgents: { ag1: {} } });
  const { ts } = sessionPost(h);
  await h.chat.inject({ kind: 'owner_mention', owner: OWNER, channel: CHAN, thread_ts: ts, user: REQ, text: '@Faraj I have approved your PR' });
  assert.equal(watchCards(h).length, 1);
  assert.equal(h.store.findByThread(CHAN, ts), null, 'no Lekam request created');
  assert.ok(!h.store.auditTail(20).some((r) => r.type === 'decision'), 'no owner-tag decision');
});

test('acknowledgements are dropped silently; the brain being down still cards', async () => {
  let mode = 'ack';
  const h = await harness({ brainScript: () => { if (mode === 'down') throw new Error('brain down'); return ack(); }, watchAgents: { ag1: {} } });
  const { ts, watch } = sessionPost(h);
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: ts, user: REQ, text: 'thanks!' });
  assert.equal(watchCards(h).length, 0);
  assert.ok(h.store.auditTail(10).some((r) => r.type === 'watch_reply' && r.data.reason === 'acknowledgement'));
  mode = 'down';
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: ts, user: REQ, text: 'approved' });
  assert.equal(watchCards(h).length, 1);
  assert.equal(h.store.getWatch(watch.id).state, 'active');
});

test('replies before the owner acts join one card, Forward sends them in one turn; a later reply gets a new threaded card', async () => {
  const h = await harness({ brainScript: info, watchAgents: { ag1: {} } });
  const { ts } = sessionPost(h);
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: ts, user: REQ, text: 'first comment' });
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: ts, user: 'UOTHER', text: 'second comment' });
  assert.equal(watchCards(h).length, 1);
  const card = watchCards(h)[0];
  assert.match(text(lastUpdate(h, card)), /first comment[\s\S]*second comment/);
  await h.chat.click(ACTIONS.WATCH_FORWARD, buttonValue(card, ACTIONS.WATCH_FORWARD), OWNER, card);
  const sends = h.watchExec.calls.filter((c) => c[0] === 'send');
  assert.equal(sends.length, 1);
  assert.match(sends[0][3], /2 replies[\s\S]*first comment[\s\S]*second comment/);
  // Pressing again does nothing.
  await h.chat.click(ACTIONS.WATCH_FORWARD, buttonValue(card, ACTIONS.WATCH_FORWARD), OWNER, card);
  assert.equal(h.watchExec.calls.filter((c) => c[0] === 'send').length, 1);
  assert.equal(h.chat.ephemerals.at(-1).text, 'Already handled.');
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: ts, user: REQ, text: 'one more thing' });
  const cards = watchCards(h);
  assert.equal(cards.length, 2);
  assert.equal(cards[1].thread_ts, card.ts, 'later cards go in the first card\'s DM thread');
  assert.match(cards[1].blocks[0].elements[0].text, new RegExp(`<@${OWNER}>`));
});

test('only the watch owner can act on its card', async () => {
  const h = await harness({ brainScript: info, watchAgents: { ag1: {} } });
  const { ts } = sessionPost(h);
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: ts, user: REQ, text: 'please also merge it' });
  const card = watchCards(h)[0];
  await h.chat.click(ACTIONS.WATCH_FORWARD, buttonValue(card, ACTIONS.WATCH_FORWARD), REQ, card);
  assert.equal(h.watchExec.calls.length, 0);
  assert.equal(h.chat.ephemerals[0].text, 'Not yours to approve.');
  assert.ok(h.store.auditTail(10).some((r) => r.type === 'watch_action_rejected_identity'));
});

test('a busy session is waited for, never interrupted; an archived one is not sent to and the card can retry', async () => {
  const agents = { ag1: { status: 'running' }, ag2: { status: 'idle', archived: true } };
  const h = await harness({ brainScript: info, watchAgents: agents });
  const { ts } = sessionPost(h);
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: ts, user: REQ, text: 'done testing' });
  let card = watchCards(h)[0];
  await h.chat.click(ACTIONS.WATCH_FORWARD, buttonValue(card, ACTIONS.WATCH_FORWARD), OWNER, card);
  assert.deepEqual(h.watchExec.calls.map((c) => c[0]), ['status', 'wait', 'send']);

  const other = sessionPost(h, { agent: 'ag2' });
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: other.ts, user: REQ, text: 'any update?' });
  card = watchCards(h).at(-1);
  h.watchExec.calls.length = 0;
  await h.chat.click(ACTIONS.WATCH_FORWARD, buttonValue(card, ACTIONS.WATCH_FORWARD), OWNER, card);
  assert.ok(!h.watchExec.calls.some((c) => c[0] === 'send'));
  const shown = lastUpdate(h, card);
  assert.match(text(shown), /archived/);
  assert.ok(text(shown).includes(ACTIONS.WATCH_FORWARD), 'buttons are back for a retry');
  agents.ag2.archived = false;
  await h.chat.click(ACTIONS.WATCH_FORWARD, buttonValue(card, ACTIONS.WATCH_FORWARD), OWNER, card);
  assert.ok(h.watchExec.calls.some((c) => c[0] === 'send' && c[1] === 'ag2'));
});

test('Stop watching ends the watch; replies after that, or after expiry, make no card', async () => {
  const h = await harness({ brainScript: info, watchAgents: { ag1: {} } });
  const { ts, watch } = sessionPost(h);
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: ts, user: REQ, text: 'lgtm' });
  const card = watchCards(h)[0];
  await h.chat.click(ACTIONS.WATCH_STOP, buttonValue(card, ACTIONS.WATCH_STOP), OWNER, card);
  assert.equal(h.store.getWatch(watch.id).state, 'stopped');
  assert.match(text(lastUpdate(h, card)), /Stopped watching/);
  assert.equal(await h.svc.isEngagedThread(CHAN, ts), false);
  await h.chat.inject({ kind: 'owner_mention', owner: OWNER, channel: CHAN, thread_ts: ts, user: REQ, text: '@Faraj one more' });
  assert.equal(watchCards(h).length, 1);

  const second = sessionPost(h, { agent: 'ag1' });
  h.store.updateWatch(second.watch.id, { expires_at: Date.now() - 1 });
  await h.svc.watchTick();
  assert.equal(h.store.getWatch(second.watch.id).state, 'expired');
  await h.chat.inject({ kind: 'owner_mention', owner: OWNER, channel: CHAN, thread_ts: second.ts, user: REQ, text: '@Faraj approved' });
  assert.equal(watchCards(h).length, 1);
});

test('catch-up handles replies Lekam missed, and the live copy of the same message does nothing', async () => {
  const h = await harness({ brainScript: info, watchAgents: { ag1: {} } });
  const { ts, watch } = sessionPost(h);
  const missed = h.chat.ts();
  h.chat.thread(CHAN, ts).push({ user: REQ, text: 'reviewed, two comments', ts: missed });
  h.chat.thread(CHAN, ts).push({ user: OWNER, text: 'posted by the session again', ts: h.chat.ts(), app_id: 'A_MCP' });
  h.chat.thread(CHAN, ts).push({ user: 'UBOTX', bot_id: 'B1', text: 'CI passed', ts: h.chat.ts() });
  await h.svc.watchTick();
  assert.equal(watchCards(h).length, 1);
  assert.ok(h.store.getWatch(watch.id).checked_at);
  assert.equal(Number(h.store.getWatch(watch.id).last_seen_ts) > Number(missed), true);
  // The same message delivered live later (Socket Mode replay) is ignored.
  await h.svc.onMessage({ kind: 'followup', channel: CHAN, thread_ts: ts, ts: missed, user: REQ, text: 'reviewed, two comments', event_id: 'EvLate' });
  assert.equal(watchCards(h).length, 1);
  assert.equal(h.chat.updates.length, 0);
});

test('a watch Lekam cannot read is marked no-access and the owner is told once', async () => {
  const h = await harness({ brainScript: info, watchAgents: { ag1: {} } });
  h.chat.noAccess = new Set(['CSECRET']);
  const { watch } = sessionPost(h, { channel: 'CSECRET' });
  await h.svc.watchTick();
  await h.svc.watchTick();
  assert.equal(h.store.getWatch(watch.id).state, 'no_access');
  const told = h.chat.dms.filter((d) => /can't watch/.test(d.text ?? ''));
  assert.equal(told.length, 1);
  assert.match(told[0].text, /invite me/);
});

test('the session posting again is bookkeeping only; a live Lekam request keeps the thread; bot mentions keep their flow', async () => {
  const h = await harness({ watchAgents: { ag1: {} } });
  const { ts, watch } = sessionPost(h);
  const again = h.chat.ts();
  await h.svc.onMessage({ kind: 'followup', channel: CHAN, thread_ts: ts, ts: again, user: OWNER, via_app: 'A_MCP', text: 'pushed the fix', event_id: 'Ev1' });
  assert.equal(watchCards(h).length, 0);
  assert.equal(h.store.getWatch(watch.id).last_seen_ts, again);

  await h.chat.inject({ kind: 'bot_mention', channel: CHAN, thread_ts: ts, user: REQ, text: '@Lekam can you check the build' });
  const req = h.store.findByThread(CHAN, ts);
  assert.equal(req.state, 'PENDING_APPROVAL', 'a bot mention opens a normal request');
  assert.equal(watchCards(h).length, 0);
  // While that request is live, plain replies are its follow-ups, not watch replies.
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: ts, user: 'UOTHER', text: 'it failed on lint' });
  assert.equal(watchCards(h).length, 0);
});

test('a watched DM: the next message from the other person becomes a card', async () => {
  const h = await harness({ brainScript: info, watchAgents: { ag1: {} } });
  const { watch } = sessionPost(h, { channel: 'DTING' });
  assert.ok(watch.is_dm);
  await h.chat.inject({ kind: 'owner_mention', owner: OWNER, dm: true, channel: 'DTING', user: 'UTING', text: 'yes, the endpoint is merged' });
  const cards = watchCards(h);
  assert.equal(cards.length, 1);
  assert.match(text(cards[0]), /a DM with name:UTING/);
  await h.chat.click(ACTIONS.WATCH_FORWARD, buttonValue(cards[0], ACTIONS.WATCH_FORWARD), OWNER, cards[0]);
  assert.match(h.watchExec.calls.find((c) => c[0] === 'send')[3], /the endpoint is merged/);
});

test('Ignore drops the replies and keeps watching', async () => {
  const h = await harness({ brainScript: info, watchAgents: { ag1: {} } });
  const { ts, watch } = sessionPost(h);
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: ts, user: REQ, text: 'fyi I am out tomorrow' });
  const card = watchCards(h)[0];
  await h.chat.click(ACTIONS.WATCH_IGNORE, buttonValue(card, ACTIONS.WATCH_IGNORE), OWNER, card);
  assert.equal(h.watchExec.calls.length, 0);
  assert.equal(h.store.getWatch(watch.id).state, 'active');
  assert.match(text(lastUpdate(h, card)), /Ignored/);
});
