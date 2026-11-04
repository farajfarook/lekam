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
  const handle = (id) => ({ id, waitForFinish: async () => ({ status: 'idle', lastMessage: '**Done**: see <x>' }), run: async (text, o) => { calls.push(['run', id, text, o?.activeTurnBehavior]); return { status: 'idle', lastMessage: `reply to ${text}` }; } });
  const slack = { react: async (c, ts, n) => reacts.push(['+', ts, n]), unreact: async (c, ts, n) => reacts.push(['-', ts, n]), reply: async (c, t, text) => posts.push({ c, t, text }) };
  const sessions = {
    find: async (thread) => { calls.push(['find', thread]); return found; },
    chooseHost: async (note) => { calls.push(['choose', note]); return 'orange'; },
    start: async (thread, o) => { calls.push(['start', thread, o]); return { handle: handle('A1'), host: o.host }; },
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
  assert.equal(start[2].host, 'orange', 'host from chooseHost');
  assert.match(f.posts[0].text, /^\*Done\*: see <x>\n\n_<paseo:\/\/agent\/A1\|open in Paseo> · on orange_$/);
  assert.deepEqual(f.reacts, [['+', '200.1', 'gear'], ['-', '200.1', 'gear']]);
  await lekam.onDm({ ...FWD, ts: '200.2', thread_ts: '200.1', text: 'go ahead', attachments: [] });
  assert.deepEqual(f.calls.at(-1), ['run', 'A1', 'go ahead', 'steer'], 'never interrupts a turn still running in Paseo');
  assert.equal(f.posts[1].text, 'reply to go ahead');
  assert.equal(f.posts[1].t, '200.1');
});

test('after a restart the thread finds its session again by label', async () => {
  const f = fakes({ found: { host: 'banana', handle: { id: 'OLD', run: async (t) => ({ status: 'idle', lastMessage: `old: ${t}` }) } } });
  await new Lekam(f).onDm({ ...FWD, ts: '300.2', thread_ts: '300.1', text: 'and now?', attachments: [] });
  assert.ok(!f.calls.some((c) => c[0] === 'start'));
  assert.equal(f.posts[0].text, 'old: and now?');
});

const tick = () => new Promise((r) => setTimeout(r, 5));
/** A session whose first turn runs until `finish(result)`; `running` is what refresh() reports after it. */
function gatedSession(f) {
  const s = { sends: [], waits: 0, running: false };
  let finish; let next = null;
  s.finish = (r) => finish(r);
  s.nextTurn = (r) => { next = r; };
  s.handle = {
    id: 'A2',
    waitForFinish: async () => { s.waits++; if (s.waits === 1) return new Promise((r) => { finish = r; }); return next; },
    send: async (text, o) => { s.sends.push([text, o?.activeTurnBehavior]); if (s.failSend) throw new Error('socket closed'); },
    refresh: async () => ({ agent: { status: s.running ? 'running' : 'idle' } }),
    run: async (text, o) => { f.calls.push(['run', 'A2', text, o?.activeTurnBehavior]); return { status: 'idle', lastMessage: `own turn: ${text}` }; },
  };
  f.sessions.start = async () => ({ host: 'banana', handle: s.handle });
  return s;
}
const REPLY = (ts, text) => ({ ...FWD, ts, thread_ts: '200.1', text, attachments: [] });

test('a reply while a turn runs steers it: sent straight in, no new turn, one answer for both', async () => {
  const f = fakes(); const s = gatedSession(f);
  const lekam = new Lekam(f);
  const a = lekam.onDm(FWD); await tick();
  await lekam.onDm(REPLY('200.3', 'use the test branch'));
  assert.deepEqual(s.sends, [['use the test branch', 'steer']]);
  assert.ok(f.reacts.some((r) => r[0] === '+' && r[1] === '200.3'), '⚙️ right away on the steer');
  assert.equal(f.posts.length, 0);
  s.finish({ status: 'idle', lastMessage: 'done, on the test branch' }); await a;
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0].text, /^done, on the test branch/);
  assert.ok(!f.calls.some((c) => c[0] === 'run'), 'no separate turn');
  assert.deepEqual(f.reacts.filter((r) => r[0] === '-').map((r) => r[1]).sort(), ['200.1', '200.3']);
});

test('a steer that lands just after the turn ended: its own turn is waited for, so the answer isn\'t lost', async () => {
  const f = fakes(); const s = gatedSession(f);
  const lekam = new Lekam(f);
  const a = lekam.onDm(FWD); await tick();
  const steer = lekam.onDm(REPLY('200.3', 'and the CSV one'));
  s.running = true; s.nextTurn({ status: 'idle', lastMessage: 'CSV done too' });
  s.finish({ status: 'idle', lastMessage: 'first answer' });
  await steer; await a;
  assert.equal(s.waits, 2, 'waited for the turn the late steer started');
  assert.match(f.posts[0].text, /^CSV done too/);
});

test('after the turn, replies start their own turn (steer option, so a turn still running in Paseo is joined, not interrupted)', async () => {
  const f = fakes(); const s = gatedSession(f);
  const lekam = new Lekam(f);
  const a = lekam.onDm(FWD); await tick();
  s.finish({ status: 'idle', lastMessage: 'one' }); await a;
  await lekam.onDm(REPLY('200.4', 'next'));
  assert.deepEqual(f.calls.at(-1), ['run', 'A2', 'next', 'steer']);
  assert.equal(f.posts[1].text, 'own turn: next');
  assert.equal(s.sends.length, 0);
});

test('a steer that fails to send runs as its own turn after the current one; failures are reported in the thread', async () => {
  const f = fakes(); const s = gatedSession(f);
  const lekam = new Lekam(f);
  const a = lekam.onDm(FWD); await tick();
  s.failSend = true;
  const b = lekam.onDm(REPLY('200.3', 'also this'));
  await tick();
  s.finish({ status: 'idle', lastMessage: 'one' });
  await a; await b;
  assert.deepEqual(f.posts.map((p) => p.text), ['one\n\n_<paseo://agent/A2|open in Paseo> · on banana_', 'own turn: also this']);
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

test('a new session gets its own titled workspace on the chosen host, with the Lekam label (created if missing)', async () => {
  const { Sessions } = await import('../src/paseo.mjs');
  const calls = [];
  const labels = [{ name: 'Other', color: 'red' }];
  const connect = async ({ name }) => ({
    api: { workspaces: { create: async (o) => { calls.push(['ws', name, o]); return { id: `wks_${name}`, agents: { create: async (a) => { calls.push(['agent', name, a]); return { id: 'A1' }; } } }; } } },
    daemon: { listWorkspaceLabels: async () => ({ labels }), setWorkspaceLabel: async (o) => { calls.push(['label', name, o]); } },
  });
  const s = new Sessions({ hosts: [{ name: 'banana', target: 'ws://x' }, { name: 'orange', target: 'ssh://root@orange' }], provider: 'pi/m', thinking: 'xhigh', cwd: '/w', connect, mkdir: async (h) => calls.push(['mkdir', h.name]) });
  const r = await s.start('200.1', { title: 'Fix the failing test', prompt: 'p', host: 'orange' });
  assert.deepEqual([r.handle.id, r.host], ['A1', 'orange']);
  assert.deepEqual(calls[0], ['mkdir', 'orange']);
  assert.deepEqual(calls[1], ['ws', 'orange', { source: { kind: 'directory', path: '/w' }, title: 'Fix the failing test' }]);
  assert.deepEqual(calls[2][2].labels, { lekam: 'dm', lekam_thread: '200.1' });
  assert.deepEqual(calls[2][2].config, { provider: 'pi/m', thinkingOptionId: 'xhigh' });
  assert.deepEqual(calls[3], ['label', 'orange', { workspaceId: 'wks_orange', label: { name: 'Lekam', color: 'amber' }, assigned: true }]);
  labels.push({ name: 'lekam', color: 'teal' });
  await s.start('200.2', { title: 't', prompt: 'p', host: 'banana' });
  assert.deepEqual(calls.at(-1)[2].label, { name: 'lekam', color: 'teal' }, 'an existing label keeps its name and colour');
});

test('host choice: named in the note wins, else free capacity, else the first host', async () => {
  const { Sessions, hostInNote, parseHosts } = await import('../src/paseo.mjs');
  const { bestHost } = await import('../src/capacity.mjs');
  const hosts = parseHosts('banana=ws://127.0.0.1:6767/ws, orange=ssh://root@orange.internal');
  assert.deepEqual(hosts.map((h) => h.name), ['banana', 'orange']);
  assert.equal(hostInNote('fix it on banana please', ['banana', 'orange']), 'banana');
  assert.equal(hostInNote('the orange build failed', ['banana', 'orange']), null, 'a bare mention is not a choice');
  let best = 'orange';
  const s = new Sessions({ hosts, provider: 'p', cwd: '/w', pickHost: async () => best, connect: async () => ({}) });
  assert.equal(await s.chooseHost('Run this ON BANANA'), 'banana');
  assert.equal(await s.chooseHost('fix it'), 'orange');
  best = null; assert.equal(await s.chooseHost('fix it'), 'banana');
  best = 'mars'; assert.equal(await s.chooseHost('fix it'), 'banana');
  assert.equal(bestHost({ best: 'orange', hosts: [] }, ['banana', 'orange']), 'orange');
  assert.equal(bestHost({ best: null, hosts: [{ name: 'banana', ok: true, slots: 1 }, { name: 'orange', ok: true, slots: 0 }] }, ['banana', 'orange']), 'banana');
  assert.equal(bestHost({ best: null, hosts: [{ name: 'banana', ok: true, slots: 0 }] }, ['banana']), null);
});

test('find looks on every host and skips one that is down', async () => {
  const { Sessions } = await import('../src/paseo.mjs');
  const connect = async ({ name }) => {
    if (name === 'banana') throw new Error('down');
    return { api: { agents: {
      list: async () => ({ entries: [{ agent: { id: 'A9' } }] }),
      ref: (id) => ({ id, refresh: async () => ({ agent: { id, status: 'idle' } }) }),
    } } };
  };
  const s = new Sessions({ hosts: [{ name: 'banana', target: 'ws://x' }, { name: 'orange', target: 'ssh://root@o' }], provider: 'p', cwd: '/w', connect });
  const r = await s.find('200.1');
  assert.deepEqual([r.host, r.handle.id], ['orange', 'A9']);
});
