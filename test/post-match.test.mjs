import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { here } from './helpers.mjs';
import { matchPost, expectsReply, normText } from '../src/core/post-match.mjs';

// Captured from a Paseo 0.13 daemon (sanitised): a pi session that sent a Slack DM from inside a codemode script,
// as the timeline looks after the session was reloaded (only the script call; nested calls listed in its details).
const reloaded = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'timelines', 'codemode-slack-dm.json'), 'utf8'));
const POST = { channel: 'DOWNERSELF', ts: '1793088470.490099', raw_text: 'Smoke test, please ignore', dm: true };

// The same send as a live timeline shows it: the script call plus the nested Slack call as its own entry.
const slackOut = (channel, ts, thread = null) => ({ content: [{ type: 'text', text: JSON.stringify({ message_link: `https:\/\/example.slack.com\/archives\/${channel}\/p${ts.replace('.', '')}${thread ? `?thread_ts=${thread}&cid=${channel}` : ''}`, message_context: { message_ts: ts, channel_id: channel } }) }] });
const call = (name, input, output, timestamp = new Date(1793088470490).toISOString(), callId = 'c1') => ({ provider: 'pi', item: { type: 'tool_call', callId, name, status: 'completed', detail: { type: 'unknown', input, output } }, timestamp });

test('real fixture: a script tool that made the Slack call matches on the timestamp in its output', () => {
  assert.deepEqual(matchPost(reloaded, POST), { callId: 'toolu_01V4aphXVQx1k6vYxrXzpNPS', how: 'ts' });
  assert.equal(matchPost(reloaded, { ...POST, ts: '1793088470.490100' }), null, 'another message is not this call');
});

test('live shape: the nested Slack call entry matches; so does a direct MCP call from any provider', () => {
  const live = [call('codemode', { code: '…' }, { content: [{ type: 'text', text: 'Script completed' }] }, undefined, 'p1'), call('mcp__litellm__slack_slack_send_message', { channel_id: 'C1', message: 'hi <@U2>' }, slackOut('C1', '1793088470.490099'), undefined, 'p1/1')];
  assert.deepEqual(matchPost(live, { channel: 'C1', ts: '1793088470.490099', raw_text: 'hi <@U2>' }), { callId: 'p1/1', how: 'ts' });
  const claude = [call('mcp__slack__slack_send_message', { channel_id: 'C1', text: 'x' }, slackOut('C1', '1793088470.490099'))];
  assert.equal(matchPost(claude, { channel: 'C1', ts: '1793088470.490099' }).how, 'ts');
});

test('a reply carries its parent\'s thread_ts: that is not a match for the parent; reads never match', () => {
  const reply = [call('mcp__litellm__slack_slack_send_message', { channel_id: 'C1', thread_ts: '1793000000.000100', message: 'reply' }, slackOut('C1', '1793088470.490099', '1793000000.000100'))];
  assert.equal(matchPost(reply, { channel: 'C1', ts: '1793000000.000100', raw_text: 'the parent' }), null);
  const read = [call('mcp__litellm__slack_slack_read_thread', { channel_id: 'C1' }, { content: [{ type: 'text', text: '{"message_ts":"1793088470.490099","link":"/archives/C1/p1793088470490099"}' }] })];
  assert.equal(matchPost(read, { channel: 'C1', ts: '1793088470.490099', raw_text: 'x' }), null);
});

test('fallback: same text to the same conversation (or a user id for a DM) within the window', () => {
  const noTs = (input, timestamp) => [call('mcp__x__slack_send_message', input, { content: [{ type: 'text', text: 'ok' }] }, timestamp)];
  const post = { channel: 'C1', ts: '1793088470.490099', raw_text: '<@U2> ready for review &amp; merge' };
  assert.deepEqual(matchPost(noTs({ channel_id: 'C1', message: '<@U2|Priya> ready for review & merge' }), post), { callId: 'c1', how: 'text' });
  assert.equal(matchPost(noTs({ channel_id: 'C9', message: '<@U2> ready for review & merge' }), post), null, 'other channel');
  assert.equal(matchPost(noTs({ channel_id: 'C1', message: '<@U2> ready for review & merge' }, new Date(1793088470490 + 10 * 60e3).toISOString()), post), null, 'outside the window');
  assert.equal(matchPost(noTs({ channel_id: 'U2', message: 'hey' }), { channel: 'D1', ts: '1793088470.490099', raw_text: 'hey', dm: true }).how, 'text');
  // A script tool's nested call args are used too.
  const script = [call('codemode', { code: '…' }, { content: [], details: { calls: [{ name: 'mcp__litellm__slack_slack_send_message', args: JSON.stringify({ channel_id: 'C1', message: 'done, see PR' }) }] } })];
  assert.equal(matchPost(script, { channel: 'C1', ts: '1793088470.490099', raw_text: 'done, see PR' }).how, 'text');
});

test('an exact match anywhere beats an earlier text match', () => {
  const t = [
    call('mcp__x__slack_send_message', { channel_id: 'C1', message: 'same' }, { content: [] }, undefined, 'text-one'),
    call('mcp__x__slack_send_message', { channel_id: 'C1', message: 'same' }, slackOut('C1', '1793088470.490099'), undefined, 'exact-one'),
  ];
  assert.equal(matchPost(t, { channel: 'C1', ts: '1793088470.490099', raw_text: 'same' }).callId, 'exact-one');
});

test('expectsReply: DMs and tags of anyone but an owner', () => {
  const ownerIds = new Set(['UOWN']);
  assert.equal(expectsReply('plain update', { ownerIds }), false);
  assert.equal(expectsReply('<@UOWN> note to self', { ownerIds }), false);
  assert.equal(expectsReply('<@U2|Priya> ready', { ownerIds }), true);
  assert.equal(expectsReply('<!subteam^S1|devs> look', { ownerIds }), true);
  assert.equal(expectsReply('<!here> heads up', { ownerIds }), true);
  assert.equal(expectsReply('anything', { ownerIds, dm: true }), true);
  assert.equal(normText('<@U2|Priya> A &amp; B'), normText('<@U2> a & b'));
});
