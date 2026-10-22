import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEvent, stripMentions, normText, SlackAdapter } from '../src/chat/slack/adapter.mjs';
const ctx = (engaged = false) => ({ botUserId: 'UBOT', ownerIds: new Set(['UOWN']), isEngaged: () => engaged });

test('stripMentions', () => { assert.equal(stripMentions('<@UBOT> fix   it <@U1|bob>'), 'fix it'); });
test('bot mention and DM', async () => {
  assert.equal((await classifyEvent({ type: 'app_mention', user: 'U1', channel: 'C', ts: '1', text: '<@UBOT> fix' }, ctx())).kind, 'bot_mention');
  const dm = await classifyEvent({ type: 'message', channel_type: 'im', user: 'U1', channel: 'D', ts: '1', text: 'fix' }, ctx());
  assert.equal(dm.kind, 'bot_mention'); assert.ok(dm.is_dm);
  const inThread = await classifyEvent({ type: 'message', user: 'U1', channel: 'C', ts: '2', thread_ts: '1', text: '<@UBOT> again' }, ctx());
  assert.equal(inThread.thread_ts, '1');
});
test('owner mention, including the owner tagging themselves', async () => {
  const m = await classifyEvent({ type: 'message', user: 'U1', channel: 'C', ts: '1', text: '<@UOWN> look' }, ctx());
  assert.equal(m.kind, 'owner_mention'); assert.equal(m.owner, 'UOWN'); assert.equal(m.text, 'look');
  const self = await classifyEvent({ type: 'message', user: 'UOWN', channel: 'C', ts: '1', text: '<@UOWN> what did your team do today' }, ctx());
  assert.equal(self.kind, 'owner_mention'); assert.equal(self.owner, 'UOWN'); assert.ok(self.self); assert.equal(self.text, 'what did your team do today');
  assert.equal(await classifyEvent({ type: 'message', user: 'UOWN', channel: 'C', ts: '1', text: 'no tag here' }, ctx()), null);
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
