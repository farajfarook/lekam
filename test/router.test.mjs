import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideNew, decideFollowup, forcesCard } from '../src/core/router.mjs';
import { testConfig, cls } from './helpers.mjs';
const c = testConfig();

test('forcesCard: patterns and repo names', () => {
  for (const t of ['raise a PR', 'deploy it', 'merge now', 'touch prod', 'update jira', 'send an email', 'delete the branch', 'also in owner-portal']) assert.ok(forcesCard(t, c), t);
  for (const t of ['also check the csv', 'thanks', 'production-ready? no, just prototype']) assert.ok(!forcesCard(t, c), t);
});
test('decideNew bot_mention', () => {
  assert.equal(decideNew({ kind: 'bot_mention' }, cls(), c).type, 'card');
  assert.deepEqual(decideNew({ kind: 'bot_mention' }, cls({ confidence: 0.2 }), c), { type: 'card', kind: 'bot_mention', lowConfidence: true });
  assert.equal(decideNew({ kind: 'bot_mention' }, cls({ intent: 'needs_clarification', clarifying_question: 'Which repo?' }), c).question, 'Which repo?');
  assert.equal(decideNew({ kind: 'bot_mention' }, cls({ intent: 'chitchat', reply_to_user: 'Hi.' }), c).text, 'Hi.');
  assert.equal(decideNew({ kind: 'bot_mention' }, cls({ intent: 'fyi', reply_to_user: null }), c).type, 'ignore');
  assert.deepEqual(decideNew({ kind: 'bot_mention' }, null, c), { type: 'card', kind: 'bot_mention', lowConfidence: true, brainDown: true });
  assert.equal(decideNew({ kind: 'bot_mention' }, cls({ intent: 'question', actionable: true }), c).type, 'card');
  assert.equal(decideNew({ kind: 'bot_mention' }, cls({ intent: 'question', actionable: false, reply_to_user: 'Ask me anything.' }), c).type, 'reply');
});
test('decideNew owner_mention', () => {
  assert.equal(decideNew({ kind: 'owner_mention' }, cls(), c).type, 'card');
  assert.equal(decideNew({ kind: 'owner_mention' }, cls({ confidence: 0.69 }), c).reason, 'below_threshold');
  assert.equal(decideNew({ kind: 'owner_mention' }, cls({ intent: 'question', actionable: false }), c).reason, 'intent_question');
  assert.equal(decideNew({ kind: 'owner_mention' }, cls({ intent: 'question', actionable: true }), c).type, 'card', 'tool question to the owner is work');
  assert.equal(decideNew({ kind: 'owner_mention' }, cls({ intent: 'question', actionable: true, confidence: 0.5 }), c).type, 'ignore');
  assert.equal(decideNew({ kind: 'owner_mention' }, cls({ actionable: false }), c).type, 'ignore');
  assert.deepEqual(decideNew({ kind: 'owner_mention', self: true }, cls({ intent: 'question', actionable: true, confidence: 0.4 }), c), { type: 'card', kind: 'owner_mention', lowConfidence: true }, 'self-tag never dropped for confidence');
  assert.equal(decideNew({ kind: 'owner_mention', self: true }, cls({ intent: 'chitchat', reply_to_user: 'Hi.' }), c).type, 'ignore', 'self-tag chit-chat stays quiet');
});
test('decideNew owner_mention: a tag is not an ask', () => {
  // "@Faraj & I tried" in a thread asking Preethi: the brain may still call it a task, the addressee decides.
  assert.deepEqual(decideNew({ kind: 'owner_mention' }, cls({ addressed_to_owner: false }), c), { type: 'ignore', reason: 'not_addressed_to_owner' });
  assert.equal(decideNew({ kind: 'owner_mention', dm: true }, cls({ addressed_to_owner: false }), c).type, 'card', 'a DM to the owner is addressed to them');
  assert.equal(decideNew({ kind: 'owner_mention', self: true }, cls({ addressed_to_owner: false }), c).type, 'card', 'self-tag is always an ask');
  assert.equal(decideNew({ kind: 'bot_mention' }, cls({ addressed_to_owner: false }), c).type, 'card', 'bot mentions are addressed to Lekam');
});
test('decideFollowup', () => {
  const req = { owner: 'UO', scope: { outward_actions: [] }, approval_mode: 'task' };
  assert.equal(decideFollowup({ user: 'UO', kind: 'bot_mention', text: 'deploy prod' }, req, null, c).type, 'forward', 'owner tagging Lekam in the thread');
  assert.equal(decideFollowup({ user: 'UO', kind: 'owner_mention', self: true, text: 'deploy prod' }, req, null, c).type, 'forward', 'owner self-tag asks Lekam');
  assert.deepEqual(decideFollowup({ user: 'UO', kind: 'followup', text: '@Preethi can you change the sub-tasks to stories' }, req, null, c), { type: 'ignore', reason: 'owner_untagged' }, 'owner talking to people in the channel is not an instruction to the agent');
  assert.equal(decideFollowup({ user: 'UR', text: 'hi' }, { ...req, scope: null }, cls(), c).reason, 'not_yet_approved');
  assert.equal(decideFollowup({ user: 'UR', text: 'raise the PR' }, req, cls({ followup: 'in_scope' }), c).reason, 'forced_pattern');
  assert.equal(decideFollowup({ user: 'UR', text: 'x' }, req, cls({ followup: 'in_scope' }), c).type, 'forward');
  assert.equal(decideFollowup({ user: 'UR', text: 'x' }, req, cls({ followup: 'scope_change' }), c).reason, 'scope_change');
  assert.equal(decideFollowup({ user: 'UR', text: 'x' }, { ...req, approval_mode: 'once' }, cls({ followup: 'in_scope' }), c).reason, 'approve_once');
  assert.equal(decideFollowup({ user: 'UR', text: 'thanks' }, req, cls({ followup: 'not_for_agent', reply_to_user: 'Any time.' }), c).text, 'Any time.');
  assert.deepEqual(decideFollowup({ user: 'UR', text: 'x' }, req, null, c), { type: 'forward_or_card', text: 'x', reason: 'brain_error' });
  assert.deepEqual(decideFollowup({ user: 'UR', text: 'Right, I see this option' }, { ...req, kind: 'owner_mention' }, cls({ followup: 'not_for_agent', reply_to_user: 'Thanks, Markand.' }), c), { type: 'ignore', reason: 'owner_thread_not_for_agent' }, 'Lekam never chimes in as itself where the owner was asked');
});
