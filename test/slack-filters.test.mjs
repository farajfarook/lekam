import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEvent, stripMentions } from '../src/chat/slack/adapter.mjs';
const ctx = (engaged = false) => ({ botUserId: 'UBOT', ownerIds: new Set(['UOWN']), isEngaged: () => engaged });

test('stripMentions', () => { assert.equal(stripMentions('<@UBOT> fix   it <@U1|bob>'), 'fix it'); });
test('bot mention and DM', () => {
  assert.equal(classifyEvent({ type: 'app_mention', user: 'U1', channel: 'C', ts: '1', text: '<@UBOT> fix' }, ctx()).kind, 'bot_mention');
  const dm = classifyEvent({ type: 'message', channel_type: 'im', user: 'U1', channel: 'D', ts: '1', text: 'fix' }, ctx());
  assert.equal(dm.kind, 'bot_mention'); assert.ok(dm.is_dm);
  const inThread = classifyEvent({ type: 'message', user: 'U1', channel: 'C', ts: '2', thread_ts: '1', text: '<@UBOT> again' }, ctx());
  assert.equal(inThread.thread_ts, '1');
});
test('owner mention by non-owner only', () => {
  const m = classifyEvent({ type: 'message', user: 'U1', channel: 'C', ts: '1', text: '<@UOWN> look' }, ctx());
  assert.equal(m.kind, 'owner_mention'); assert.equal(m.owner, 'UOWN'); assert.equal(m.text, 'look');
  assert.equal(classifyEvent({ type: 'message', user: 'UOWN', channel: 'C', ts: '1', text: '<@UOWN> me' }, ctx()), null);
});
test('followups only in engaged threads', () => {
  const ev = { type: 'message', user: 'U1', channel: 'C', ts: '2', thread_ts: '1', text: 'more' };
  assert.equal(classifyEvent(ev, ctx(false)), null);
  assert.equal(classifyEvent(ev, ctx(true)).kind, 'followup');
});
test('noise is ignored', () => {
  for (const ev of [
    { type: 'message', subtype: 'message_changed', user: 'U1', channel: 'C', ts: '1', text: '<@UBOT> x' },
    { type: 'message', subtype: 'channel_join', user: 'U1', channel: 'C', ts: '1', text: 'joined' },
    { type: 'message', bot_id: 'B1', channel: 'C', ts: '1', text: '<@UBOT> x' },
    { type: 'message', user: 'UBOT', channel: 'C', ts: '1', text: 'me' },
    { type: 'message', user: 'U1', channel: 'C', ts: '1', text: '<@UBOT>' },
    { type: 'message', user: 'U1', channel: 'C', ts: '1', text: 'plain message nobody tagged' },
  ]) assert.equal(classifyEvent(ev, ctx()), null, JSON.stringify(ev));
});
