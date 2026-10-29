import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEvent, stripMentions, renderMentions, normText, withFooter, SlackAdapter } from '../src/chat/slack/adapter.mjs';
const NAMES = { UOWN: 'Faraj Farook', UPREETHI: 'Preethi Prakash', UMARK: 'Markand Bhatt', UBOT: 'Lekam' };
const ctx = (engaged = false) => ({ botUserId: 'UBOT', ownerIds: new Set(['UOWN']), isEngaged: () => engaged, nameOf: async (id) => NAMES[id] ?? id, appId: 'ALEKAM' });

test('stripMentions', () => { assert.equal(stripMentions('<@UBOT> fix   it <@U1|bob>'), 'fix it'); });
test('mentions are rendered as names, not deleted; entities unescaped; only Lekam\'s own tag is dropped', async () => {
  const nameOf = async (id) => NAMES[id] ?? id;
  assert.equal(await renderMentions('<@UOWN> &amp; I tried, but looks like we dont have access', nameOf), '@Faraj Farook & I tried, but looks like we dont have access');
  assert.equal(await renderMentions('<@UPREETHI> need your help with OP-316', nameOf), '@Preethi Prakash need your help with OP-316');
  assert.equal(await renderMentions('<@UBOT> ask <@UOWN>  about <#C1|team-ai> &lt;soon&gt; <!here>', nameOf, { drop: ['UBOT'] }), 'ask @Faraj Farook about #team-ai <soon> @here');
  assert.equal(await renderMentions('hi <@UNKNOWN|someone>', async (id) => id), 'hi @someone', 'falls back to the label Slack sent');
  assert.equal(await renderMentions('line one\n  line two', nameOf), 'line one\nline two', 'line breaks kept');
});
test('a reply that mentions the owner keeps who it was addressed to', async () => {
  const m = await classifyEvent({ type: 'message', user: 'UMARK', channel: 'C', ts: '2', thread_ts: '1', text: '<@UOWN> &amp; I tried, but looks like we dont have access' }, ctx());
  assert.deepEqual([m.kind, m.owner, m.text], ['owner_mention', 'UOWN', '@Faraj Farook & I tried, but looks like we dont have access']);
});
test('posts made through an app with a user token: Lekam\'s own are dropped, others are marked via_app', async () => {
  assert.equal(await classifyEvent({ type: 'message', user: 'UOWN', app_id: 'ALEKAM', channel: 'C', ts: '3', thread_ts: '1', text: '<@UPREETHI> hi' }, ctx(true)), null);
  const other = await classifyEvent({ type: 'message', user: 'UOWN', app_id: 'AOTHER', channel: 'C', ts: '4', thread_ts: '1', text: '<@UPREETHI> could you do it?' }, ctx(true));
  assert.deepEqual([other.kind, other.via_app, other.text], ['owner_post', 'AOTHER', '@Preethi Prakash could you do it?']);
  const typed = await classifyEvent({ type: 'message', user: 'UOWN', client_msg_id: 'abc', channel: 'C', ts: '5', thread_ts: '1', text: 'typed by hand' }, ctx(true));
  assert.equal(typed.via_app, undefined);
});
test('bot mention and DM', async () => {
  assert.equal((await classifyEvent({ type: 'app_mention', user: 'U1', channel: 'C', ts: '1', text: '<@UBOT> fix' }, ctx())).kind, 'bot_mention');
  const dm = await classifyEvent({ type: 'message', channel_type: 'im', user: 'U1', channel: 'D', ts: '1', text: 'fix' }, ctx());
  assert.equal(dm.kind, 'bot_mention'); assert.ok(dm.is_dm);
  const inThread = await classifyEvent({ type: 'message', user: 'U1', channel: 'C', ts: '2', thread_ts: '1', text: '<@UBOT> again' }, ctx());
  assert.equal(inThread.thread_ts, '1');
});
test('owner mention, including the owner tagging themselves', async () => {
  const m = await classifyEvent({ type: 'message', user: 'U1', channel: 'C', ts: '1', text: '<@UOWN> look' }, ctx());
  assert.equal(m.kind, 'owner_mention'); assert.equal(m.owner, 'UOWN'); assert.equal(m.text, '@Faraj Farook look');
  const self = await classifyEvent({ type: 'message', user: 'UOWN', channel: 'C', ts: '1', text: '<@UOWN> what did your team do today' }, ctx());
  assert.equal(self.kind, 'owner_mention'); assert.equal(self.owner, 'UOWN'); assert.ok(self.self); assert.equal(self.text, '@Faraj Farook what did your team do today');
  const own = await classifyEvent({ type: 'message', user: 'UOWN', channel: 'C', ts: '1', text: 'no tag here', client_msg_id: 'x' }, ctx());
  assert.deepEqual([own.kind, own.owner, own.hints], ['owner_post', 'UOWN', { app_id: null, no_client_msg_id: false, footer: false }], 'the owner\'s own lines are owner posts (session-post detection)');
});
test('followups only in engaged threads', async () => {
  const ev = { type: 'message', user: 'U1', channel: 'C', ts: '2', thread_ts: '1', text: 'more' };
  assert.equal(await classifyEvent(ev, ctx(false)), null);
  assert.equal((await classifyEvent(ev, ctx(true))).kind, 'followup');
});
test('noise is ignored', async () => {
  for (const ev of [
    { type: 'message', subtype: 'message_changed', user: 'U1', channel: 'C', ts: '1', text: '<@UBOT> x' },
    { type: 'message', subtype: 'channel_join', user: 'U1', channel: 'C', ts: '1', text: 'joined' },
    { type: 'message', bot_id: 'B1', channel: 'C', ts: '1', text: '<@UBOT> x' },
    { type: 'message', user: 'UBOT', channel: 'C', ts: '1', text: 'me' },
    { type: 'message', user: 'U1', channel: 'C', ts: '1', text: '<@UBOT>' },
    { type: 'message', user: 'U1', channel: 'C', ts: '1', text: 'plain message nobody tagged' },
  ]) assert.equal(await classifyEvent(ev, ctx()), null, JSON.stringify(ev));
});
test('messages posted as the owner are not read back as the owner talking', () => {
  assert.equal(normText('Fixed &amp; shipped <https://x|PR>'), normText('Fixed & shipped <https://x|PR>'));
  const a = new SlackAdapter({ ownerIds: new Set(['UOWN']) });
  a.echoes.push({ channel: 'C', user: 'UOWN', norm: normText('Report done.'), ts: null, until: Date.now() + 1000 });
  assert.equal(a.isEcho({ channel: 'C', user: 'U1', ts: '5', text: 'Report done.' }), false);
  assert.equal(a.isEcho({ channel: 'C', user: 'UOWN', ts: '5', text: 'Report done.' }), true);
  assert.equal(a.isEcho({ channel: 'C', user: 'UOWN', ts: '6', text: 'Report done.' }), false, 'each echo is consumed once');
});
test('owner posts get a small "Sent using Lekam" footer without tagging Lekam; long text is split under the 3000-char cap', () => {
  const m = withFooter({ text: 'Hi there' }, 'Lekam');
  assert.equal(m.text, 'Hi there', 'notification text has no footer');
  assert.deepEqual(m.blocks.at(-1), { type: 'context', elements: [{ type: 'mrkdwn', text: '*Sent using* Lekam' }] });
  assert.ok(!JSON.stringify(m.blocks).includes('<@') && !JSON.stringify(m.blocks).includes('http'));
  const long = withFooter({ text: ('para '.repeat(300) + '\n\n').repeat(6) });
  assert.ok(long.blocks.filter((b) => b.type === 'section').every((b) => b.text.text.length <= 3000));
  assert.ok(long.blocks.filter((b) => b.type === 'section').length >= 3);
});
test('DMs: Lekam\'s own DMs are bot mentions; DMs people send a capturing owner are owner tags; the owner\'s own lines are ignored', async () => {
  const c = { ...ctx(), dmOwner: async (ch) => (ch === 'DOWNER_TING' ? 'UOWN' : null) };
  const toLekam = await classifyEvent({ type: 'message', channel_type: 'im', user: 'U1', channel: 'DLEKAM', ts: '1', text: 'hi lekam' }, c);
  assert.equal(toLekam.kind, 'bot_mention'); assert.ok(toLekam.is_dm);
  const toOwner = await classifyEvent({ type: 'message', channel_type: 'im', user: 'UTING', channel: 'DOWNER_TING', ts: '2', text: 'can you check the build?' }, c);
  assert.deepEqual([toOwner.kind, toOwner.owner, toOwner.dm, toOwner.is_dm], ['owner_mention', 'UOWN', true, false]);
  const mine = await classifyEvent({ type: 'message', channel_type: 'im', user: 'UOWN', channel: 'DOWNER_TING', ts: '3', text: 'sure' }, c);
  assert.deepEqual([mine.kind, mine.owner, mine.dm, mine.is_dm], ['owner_post', 'UOWN', true, false]);
});
test('no loops: Lekam\'s own DMs to the owner, other bots, and posts made as the owner are never picked up', async () => {
  const c = { ...ctx(), dmOwner: async () => 'UOWN' }; // even if a DM looked like the owner's personal DM
  for (const ev of [
    { type: 'message', channel_type: 'im', bot_id: 'BLEKAM', user: 'UBOT', channel: 'DLEKAM', ts: '1', text: 'Result for ... Post to thread' }, // Lekam's card/result
    { type: 'message', channel_type: 'im', subtype: 'bot_message', bot_id: 'BJIRA', channel: 'DJIRA', ts: '2', text: 'Jira: you were assigned OP-1' }, // another app
    { type: 'message', channel_type: 'im', user: 'UBOT', channel: 'DLEKAM', ts: '3', text: 'hello' }, // Lekam's user id
    { type: 'message', channel_type: 'im', user: 'UOWN', app_id: 'ALEKAM', channel: 'DTING', ts: '4', text: 'Looking into this :eyes:' }, // Lekam posting as the owner
  ]) assert.equal(await classifyEvent(ev, c), null, JSON.stringify(ev));
});

test('owner posts carry the app hints Slack gives (as hints: they are inconsistent for the same app)', async () => {
  const footer = [{ type: 'rich_text', elements: [] }, { type: 'context', elements: [{ type: 'mrkdwn', text: '*Sent using* AI Bot' }] }];
  const a = await classifyEvent({ type: 'message', user: 'UOWN', channel: 'C', ts: '5', thread_ts: '1', client_msg_id: 'm1', blocks: footer, text: '<@UPREETHI> ready for review' }, ctx());
  assert.deepEqual([a.kind, a.thread_ts, a.raw_text, a.hints], ['owner_post', '1', '<@UPREETHI> ready for review', { app_id: null, no_client_msg_id: false, footer: true }]);
  const b = await classifyEvent({ type: 'message', user: 'UOWN', channel: 'C', ts: '6', app_id: 'AMCP', text: 'pushed the fix' }, ctx());
  assert.deepEqual(b.hints, { app_id: 'AMCP', no_client_msg_id: true, footer: false });
  assert.equal(b.via_app, 'AMCP');
  assert.equal((await classifyEvent({ type: 'message', user: 'UOWN', channel: 'C', ts: '7', text: '<@UBOT> do it' }, ctx())).kind, 'bot_mention');
});

// A CI post under which people ask Lekam to fix things (a webhook post: subtype bot_message, detail only in blocks).
const CI_POST = { subtype: 'bot_message', bot_id: 'BCI', ts: '100.1', text: ':x: My Stay full suite failed: No scenario counts (the run did not reach the reporter).', blocks: [
  { type: 'header', text: { type: 'plain_text', text: ':x: My Stay full suite failed' } },
  { type: 'section', fields: [{ type: 'mrkdwn', text: '*Branch*\n`merge`' }, { type: 'mrkdwn', text: '*Commit*\n`a73382115021`' }] },
  { type: 'section', text: { type: 'mrkdwn', text: ':bar_chart: <https://dev.azure.com/b?buildId=152770&amp;view=allure|Allure report> · <https://dev.azure.com/b?buildId=152770|Open the build>' } },
  { type: 'context', elements: [{ type: 'mrkdwn', text: 'my-stay-test-gate · MyStay.Playwright.Full.20261029.2' }] },
] };

test('messageText reads app blocks and attachments, not rich_text echoes', async () => {
  const { messageText } = await import('../src/chat/slack/adapter.mjs');
  const t = messageText(CI_POST);
  for (const s of ['suite failed: No scenario counts', '`merge`', 'a73382115021', 'buildId=152770', 'MyStay.Playwright.Full.20261029.2']) assert.ok(t.includes(s), s);
  assert.equal(t.split('\n').filter((l) => l === ':x: My Stay full suite failed').length, 0, 'header already in text is not repeated');
  assert.equal(messageText({ text: 'hi there', blocks: [{ type: 'rich_text', elements: [] }] }), 'hi there');
  assert.equal(messageText({ text: '', attachments: [{ title: 'Build 12', title_link: 'https://x/12', text: 'failed', fields: [{ title: 'Stage', value: 'e2e' }] }] }), '<https://x/12|Build 12>\nfailed\n*Stage*\ne2e');
});

test('fetchThread keeps bot posts (CI alerts) with their bot name and block detail', async () => {
  const a = new SlackAdapter({ ownerIds: new Set(['UOWN']) });
  a.botUserId = 'UBOT';
  a.client = {
    conversations: { replies: async () => ({ messages: [CI_POST,
      { user: 'UOWN', ts: '100.2', text: '<@UBOT> can u check and fix it' },
      { subtype: 'channel_join', user: 'UX', ts: '100.3', text: '<@UX> has joined' }] }) },
    bots: { info: async ({ bot }) => ({ bot: { name: bot === 'BCI' ? 'Azure Pipelines' : '?' } }) },
    users: { info: async ({ user }) => ({ user: { profile: { display_name: NAMES[user] ?? user } } }) },
  };
  const t = await a.fetchThread('C', '100.1');
  assert.equal(t.length, 2, 'join notice dropped, bot post kept');
  assert.equal(t[0].name, 'Azure Pipelines');
  assert.ok(t[0].text.includes('a73382115021') && t[0].text.includes('buildId=152770&view=allure'));
  assert.equal(t[1].name, undefined);
});
