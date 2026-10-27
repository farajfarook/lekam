import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, cls, OWNER, REQ, CHAN } from './helpers.mjs';
import { ACTIONS } from '../src/approvals/cards.mjs';

const info = () => cls({ intent: 'fyi', actionable: true, brief: null, reply_to_user: null });
const settle = (h) => Promise.all([...h.svc.detections]);
const FOOTER = { app_id: null, no_client_msg_id: false, footer: true };
const TYPED = { app_id: null, no_client_msg_id: false, footer: false };

/** A live timeline: a script tool call plus the nested Slack send whose output names the message. */
const sent = (channel, ts, message) => [
  { provider: 'pi', item: { type: 'tool_call', callId: 's1', name: 'codemode', detail: { input: { code: '…' }, output: { content: [{ type: 'text', text: 'Script completed' }] } } }, timestamp: new Date(Number(ts) * 1000).toISOString() },
  { provider: 'pi', item: { type: 'tool_call', callId: 's1/1', name: 'mcp__litellm__slack_slack_send_message', detail: { input: { channel_id: channel, message }, output: { content: [{ type: 'text', text: JSON.stringify({ message_link: `https://x.slack.com/archives/${channel}/p${ts.replace('.', '')}`, message_context: { message_ts: ts, channel_id: channel } }) }] } } }, timestamp: new Date(Number(ts) * 1000).toISOString() },
];

async function ownerPost(h, { text, channel = CHAN, thread_ts, hints = FOOTER, dm = false, ts }) {
  const m = await h.chat.inject({ kind: 'owner_post', owner: OWNER, channel, user: OWNER, text, raw_text: text, hints, ...(ts ? { ts } : {}), ...(thread_ts ? { thread_ts } : {}), ...(dm ? { dm: true } : {}) });
  await settle(h);
  return m;
}

test('a session post that tags someone registers a watch for the agent that sent it', async () => {
  const ts = `${Math.floor(Date.now() / 1000)}.000100`;
  const h = await harness({ brainScript: info, watchAgents: { ag1: { title: 'PR-42 review', status: 'idle' }, other: { title: 'Something else' } }, timelines: { ag1: sent(CHAN, ts, '<@UPRIYA> ready for review'), other: [] } });
  await ownerPost(h, { text: '<@UPRIYA> ready for review', ts });
  const [w] = h.store.listWatches();
  assert.ok(w, 'watch registered');
  assert.deepEqual([w.agent_id, w.host, w.title, w.source, w.channel, w.thread_ts, w.last_seen_ts], ['ag1', 'local', 'PR-42 review', 'detected', CHAN, ts, ts]);
  assert.ok(h.store.auditTail(10).some((r) => r.type === 'session_post_matched' && r.data.how === 'ts' && r.data.action === 'created'));

  // End to end: a reply cards, Forward reaches the detected session.
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: ts, user: REQ, text: 'approved' });
  const card = h.chat.dms.find((d) => JSON.stringify(d.blocks ?? []).includes(ACTIONS.WATCH_FORWARD));
  assert.ok(card);
  const value = card.blocks.flatMap((b) => b.elements ?? []).find((e) => e.action_id === ACTIONS.WATCH_FORWARD).value;
  await h.chat.click(ACTIONS.WATCH_FORWARD, value, OWNER, card);
  assert.ok(h.daemons.calls.some((c) => c[0] === 'send' && c[1] === 'ag1' && /approved/.test(c[3])));
});

test('sessions on another host are found and forwarded to there', async () => {
  const ts = `${Math.floor(Date.now() / 1000)}.000200`;
  const h = await harness({ watchAgents: { far: { host: 'boxb', title: 'On the other box' } }, timelines: { far: sent(CHAN, ts, '<@UPRIYA> please check') } });
  await ownerPost(h, { text: '<@UPRIYA> please check', ts });
  assert.equal(h.store.listWatches()[0].host, 'boxb');
});

test('a plain post renews the session\'s watch in its thread and creates nothing elsewhere', async () => {
  const now = Math.floor(Date.now() / 1000);
  const thread = `${now - 60}.000100`, again = `${now}.000300`, elsewhere = `${now}.000400`;
  const timelines = { ag1: [] };
  const h = await harness({ watchAgents: { ag1: { title: 'S' } }, timelines });
  const { watch } = h.store.registerWatch({ channel: CHAN, thread_ts: thread, agent_id: 'ag1', host: 'local', owner: OWNER, ttlMs: 1000, source: 'detected' });
  timelines.ag1 = sent(CHAN, again, 'pushed the fix');
  await ownerPost(h, { text: 'pushed the fix', thread_ts: thread, ts: again });
  assert.ok(h.store.getWatch(watch.id).expires_at > Date.now() + 2 * 864e5, 'renewed with the full TTL');
  timelines.ag1 = sent('COTHER', elsewhere, 'fyi, deployed');
  await ownerPost(h, { text: 'fyi, deployed', channel: 'COTHER', ts: elsewhere });
  assert.equal(h.store.listWatches().length, 1);
  assert.ok(h.store.auditTail(5).some((r) => r.type === 'session_post_matched' && r.data.action === 'noop'));
});

test('a DM sent by a session (captured with the owner\'s token) is watched', async () => {
  const ts = `${Math.floor(Date.now() / 1000)}.000500`;
  const h = await harness({ watchAgents: { ag1: { title: 'Asks Ting' } }, timelines: { ag1: sent('UTING', ts, 'is the endpoint merged?').map((e) => e) } });
  // The tool was given a user id; Slack reports the DM channel. Make the output name the D channel as Slack does.
  h.daemons.timelines.ag1[1].item.detail.output.content[0].text = JSON.stringify({ message_link: `https://x/archives/DTING/p${ts.replace('.', '')}`, message_context: { message_ts: ts, channel_id: 'DTING' } });
  await ownerPost(h, { text: 'is the endpoint merged?', channel: 'DTING', dm: true, ts });
  const [w] = h.store.listWatches();
  assert.deepEqual([w?.channel, w?.is_dm], ['DTING', true]);
});

test('scheduled runs and Lekam\'s own sessions are skipped', async () => {
  const ts = `${Math.floor(Date.now() / 1000)}.000600`;
  const h = await harness({ watchAgents: { sched: { labels: { 'paseo.schedule-id': 'a543d205' } } }, timelines: { sched: sent(CHAN, ts, '<@UPRIYA> standup summary') } });
  await ownerPost(h, { text: '<@UPRIYA> standup summary', ts });
  assert.equal(h.store.listWatches().length, 0);
  assert.ok(h.store.auditTail(5).some((r) => r.type === 'session_post_skipped' && r.data.reason === 'label:paseo.schedule-id'));

  const ts2 = `${Math.floor(Date.now() / 1000)}.000700`;
  const h2 = await harness({ watchAgents: { mine: {} }, timelines: { mine: sent(CHAN, ts2, '<@UPRIYA> done') } });
  const r = h2.store.createRequest({ kind: 'bot_mention', channel: 'C9', thread_ts: '1.1', origin_ts: '1.1', requester: REQ, owner: OWNER, request_text: 'x' });
  h2.store.setSession(r.id, 'mine');
  await ownerPost(h2, { text: '<@UPRIYA> done', ts: ts2 });
  assert.equal(h2.store.listWatches().length, 0);
  assert.ok(h2.store.auditTail(5).some((x) => x.type === 'session_post_skipped' && x.data.reason === 'lekam_session'));
});

test('retries until the tool output reaches the timeline; typed messages get one quiet attempt', async () => {
  const ts = `${Math.floor(Date.now() / 1000)}.000800`;
  let reads = 0;
  const h = await harness({ watchAgents: { ag1: {} }, timelines: { ag1: () => (++reads < 2 ? [] : sent(CHAN, ts, '<@UPRIYA> ping')) } });
  await ownerPost(h, { text: '<@UPRIYA> ping', ts });
  assert.equal(reads, 2);
  assert.equal(h.store.listWatches().length, 1);

  const h2 = await harness({ watchAgents: { ag1: {} }, timelines: { ag1: [] } });
  await ownerPost(h2, { text: '<@UPRIYA> typed by hand', hints: TYPED });
  assert.equal(h2.daemons.calls.filter((c) => c[0] === 'list').length, 2, 'one attempt (one list per host)');
  assert.ok(!h2.store.auditTail(5).some((r) => r.type === 'session_post_unmatched'), 'typed messages are not audited');
  await ownerPost(h2, { text: '<@UPRIYA> posted by some app', hints: FOOTER });
  assert.equal(h2.daemons.calls.filter((c) => c[0] === 'list').length, 8, 'three more attempts for an app-looking post');
  assert.ok(h2.store.auditTail(5).some((r) => r.type === 'session_post_unmatched'));
});

test('an unreachable host is audited once and the others are still searched; stale agents are not read', async () => {
  const ts = `${Math.floor(Date.now() / 1000)}.000900`;
  const h = await harness({ down: ['boxb'], watchAgents: { ag1: {}, old: { updatedAt: Date.now() - 3600e3 } }, timelines: { ag1: sent(CHAN, ts, '<@UPRIYA> hi'), old: sent(CHAN, ts, '<@UPRIYA> hi') } });
  await ownerPost(h, { text: '<@UPRIYA> hi', ts });
  assert.equal(h.store.listWatches()[0]?.agent_id, 'ag1');
  assert.ok(!h.daemons.calls.some((c) => c[0] === 'timeline' && c[2] === 'old'), 'agents idle longer than the lookback are skipped');
  await ownerPost(h, { text: 'another', hints: TYPED });
  assert.equal(h.store.auditTail(30).filter((r) => r.type === 'daemon_unreachable').length, 1);
});

test('owner posts never become requests, and detection can be switched off', async () => {
  const h = await harness({ watchAgents: {}, timelines: {} });
  await ownerPost(h, { text: 'can someone look at this?', hints: TYPED });
  assert.equal(h.chat.dms.length, 0);
  assert.equal(h.chat.posts.length, 0);
  h.config.watches.detect.enabled = false;
  const before = h.daemons.calls.length;
  await ownerPost(h, { text: '<@UPRIYA> hi' });
  assert.equal(h.daemons.calls.length, before);
});
