import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDm, isEmpty } from '../src/forward.mjs';
import { firstPrompt, followupPrompt, title } from '../src/prompt.mjs';
import { isOwnerDm, chunks } from '../src/slack.mjs';
import { Lekam } from '../src/lekam.mjs';

const OWNER = 'UOWN';
const FWD = {
  type: 'message', channel_type: 'im', channel: 'D1', user: OWNER, ts: '200.1', text: 'fix the failing test',
  attachments: [{ is_share: true, is_msg_unfurl: true, from_url: 'https://rms.slack.com/archives/C9/p1793239822283509', author_name: 'health-check-webhooks', text: ':x: My Stay full suite failed &amp; more' }],
};

test('a forward: note, permalink and preview; pasted links and files too', () => {
  const p = parseDm(FWD);
  assert.equal(p.note, 'fix the failing test');
  assert.deepEqual(p.forwards, [{ url: 'https://rms.slack.com/archives/C9/p1793239822283509', author: 'health-check-webhooks', text: ':x: My Stay full suite failed & more' }]);
  const pasted = parseDm({ text: 'look <https://rms.slack.com/archives/C1/p123456?thread_ts=1.2&amp;cid=C1|this>', files: [{ name: 'shot.png', permalink: 'https://rms.slack.com/files/U/F1/shot.png' }] });
  assert.equal(pasted.note, 'look https://rms.slack.com/archives/C1/p123456?thread_ts=1.2&cid=C1');
  assert.deepEqual(pasted.forwards.map((f) => f.url), ['https://rms.slack.com/archives/C1/p123456?thread_ts=1.2&cid=C1']);
  assert.deepEqual(pasted.files, [{ name: 'shot.png', url: 'https://rms.slack.com/files/U/F1/shot.png' }]);
  assert.ok(isEmpty(parseDm({ text: '  ' })));
});

test('prompts: do what he asked, or suggest the next step when he asked nothing', () => {
  const asked = firstPrompt(parseDm(FWD), { ownerName: 'Faraj' });
  assert.match(asked, /Slack DM, through Lekam/);
  assert.match(asked, /https:\/\/rms\.slack\.com\/archives\/C9\/p1793239822283509/);
  assert.match(asked, /slack_read_thread/);
  assert.match(asked, /Faraj's message:\nfix the failing test/);
  const bare = firstPrompt(parseDm({ ...FWD, text: '' }), { ownerName: 'Faraj' });
  assert.match(bare, /didn't say what he wants.*suggest the next step/s);
  assert.equal(followupPrompt(parseDm({ text: 'go ahead' })), 'go ahead');
  assert.equal(title(parseDm(FWD)), 'Fix the failing test – My Stay full suite failed…');
});

test('only the owner\'s own DM messages count', () => {
  assert.ok(isOwnerDm(FWD, OWNER));
  assert.ok(!isOwnerDm({ ...FWD, user: 'USOMEONE' }, OWNER));
  assert.ok(!isOwnerDm({ ...FWD, channel_type: 'channel' }, OWNER));
  assert.ok(!isOwnerDm({ ...FWD, subtype: 'message_changed' }, OWNER));
  assert.ok(!isOwnerDm({ ...FWD, bot_id: 'B1' }, OWNER));
  assert.ok(isOwnerDm({ ...FWD, subtype: 'file_share' }, OWNER));
});

test('long replies are split on line breaks', () => {
  const parts = chunks(`${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`);
  assert.deepEqual(parts.map((p) => p.length), [3000, 3000]);
  assert.deepEqual(chunks('short'), ['short']);
});

function fakes({ found = null } = {}) {
  const posts = []; const reacts = []; const calls = [];
  const handle = (id) => ({ id, waitForFinish: async () => ({ status: 'idle', lastMessage: '**Done**: see <x>' }), run: async (text) => { calls.push(['run', id, text]); return { status: 'idle', lastMessage: `reply to ${text}` }; } });
  const slack = { react: async (c, ts, n) => reacts.push(['+', ts, n]), unreact: async (c, ts, n) => reacts.push(['-', ts, n]), reply: async (c, t, text) => posts.push({ c, t, text }) };
  const sessions = {
    find: async (thread) => { calls.push(['find', thread]); return found; },
    start: async (thread, o) => { calls.push(['start', thread, o]); return handle('A1'); },
    link: (id) => `paseo://agent/${id}`,
  };
  return { posts, reacts, calls, slack, sessions };
}

test('a forward starts a session; replies in the DM thread continue it; answers come back in that thread', async () => {
  const f = fakes();
  const lekam = new Lekam({ ...f, ownerName: 'Faraj' });
  await lekam.onDm(FWD);
  const start = f.calls.find((c) => c[0] === 'start');
  assert.equal(start[1], '200.1', 'session keyed on the DM thread');
  assert.match(start[2].prompt, /fix the failing test/);
  assert.equal(f.posts[0].t, '200.1');
  assert.match(f.posts[0].text, /^\*Done\*: see <x>\n\n_<paseo:\/\/agent\/A1\|open in Paseo>_$/);
  assert.deepEqual(f.reacts, [['+', '200.1', 'gear'], ['-', '200.1', 'gear']]);
  await lekam.onDm({ ...FWD, ts: '200.2', thread_ts: '200.1', text: 'go ahead', attachments: [] });
  assert.deepEqual(f.calls.at(-1), ['run', 'A1', 'go ahead']);
  assert.equal(f.posts[1].text, 'reply to go ahead');
  assert.equal(f.posts[1].t, '200.1');
});

test('after a restart the thread finds its session again by label', async () => {
  const f = fakes({ found: { id: 'OLD', run: async (t) => ({ status: 'idle', lastMessage: `old: ${t}` }) } });
  await new Lekam(f).onDm({ ...FWD, ts: '300.2', thread_ts: '300.1', text: 'and now?', attachments: [] });
  assert.ok(!f.calls.some((c) => c[0] === 'start'));
  assert.equal(f.posts[0].text, 'old: and now?');
});

test('turns in one thread run one at a time; failures are reported in the thread', async () => {
  const f = fakes();
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  f.sessions.start = async () => ({ id: 'A2', waitForFinish: async () => { order.push('first'); await gate; return { status: 'idle', lastMessage: 'one' }; }, run: async () => { order.push('second'); return { status: 'idle', lastMessage: 'two' }; } });
  const lekam = new Lekam(f);
  const a = lekam.onDm(FWD);
  const b = lekam.onDm({ ...FWD, ts: '200.3', thread_ts: '200.1', text: 'also this', attachments: [] });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ['first']);
  release(); await a; await b;
  assert.deepEqual(order, ['first', 'second']);
  const g = fakes();
  g.sessions.find = async () => { throw new Error('daemon unreachable'); };
  await new Lekam(g).onDm(FWD);
  assert.equal(g.posts[0].text, ':warning: daemon unreachable');
  assert.deepEqual(g.reacts.at(-1), ['-', '200.1', 'gear']);
});

test('non-idle results point to Paseo', () => {
  const l = new Lekam({ slack: {}, sessions: { link: (id) => `paseo://agent/${id}` }, timeoutMs: 60 * 60e3 });
  assert.match(l.render({ status: 'permission' }, 'A'), /waiting for a permission decision: <paseo:\/\/agent\/A\|open in Paseo>/);
  assert.match(l.render({ status: 'timeout' }, 'A'), /Still working after 60 min/);
  assert.match(l.render({ status: 'error', error: 'boom' }, 'A'), /error: boom/);
});

test('titles are short and readable', () => {
  assert.equal(title(parseDm({ ...FWD, text: '' })), 'My Stay full suite failed & more');
  assert.equal(title(parseDm({ text: 'can you create a jira in AI space to setup veracode for mcp server external look at the example of corepms' })), 'Can you create a jira in AI space to setup…');
  assert.equal(title(parseDm({ text: 'see <https://rms.slack.com/archives/C1/p123456|this>' })), 'See');
  assert.equal(title(parseDm({ text: '<https://rms.slack.com/archives/C1/p123456>' })), 'Slack message');
  assert.ok(title(parseDm({ text: 'x'.repeat(200) })).length <= 50);
});

test('a new session gets its own titled workspace with the Lekam label (created if missing)', async () => {
  const { Sessions } = await import('../src/paseo.mjs');
  const calls = [];
  const labels = [{ name: 'Other', color: 'red' }];
  const client = {
    connect: async () => {},
    workspaces: { create: async (o) => { calls.push(['ws', o]); return { id: 'wks_1', agents: { create: async (a) => { calls.push(['agent', a]); return { id: 'A1' }; } } }; } },
  };
  const labelClient = { connect: async () => {}, listWorkspaceLabels: async () => ({ labels }), setWorkspaceLabel: async (o) => { calls.push(['label', o]); } };
  const s = new Sessions({ url: 'ws://x', provider: 'pi/m', cwd: '/tmp/lekam-test-cwd', createClient: async () => client, createLabelClient: async () => labelClient });
  const h = await s.start('200.1', { title: 'Fix the failing test', prompt: 'p' });
  assert.equal(h.id, 'A1');
  assert.deepEqual(calls[0], ['ws', { source: { kind: 'directory', path: '/tmp/lekam-test-cwd' }, title: 'Fix the failing test' }]);
  assert.deepEqual(calls[1][1].labels, { lekam: 'dm', lekam_thread: '200.1' });
  assert.deepEqual(calls[2], ['label', { workspaceId: 'wks_1', label: { name: 'Lekam', color: 'amber' }, assigned: true }]);
  labels.push({ name: 'lekam', color: 'teal' });
  await s.start('200.2', { title: 't', prompt: 'p' });
  assert.deepEqual(calls.at(-1)[1].label, { name: 'lekam', color: 'teal' }, 'an existing label keeps its name and colour');
});
