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
  assert.equal(decideNew({ kind: 'bot_mention' }, null, c).type, 'reply');
});
test('decideNew owner_mention', () => {
  assert.equal(decideNew({ kind: 'owner_mention' }, cls(), c).type, 'card');
  assert.equal(decideNew({ kind: 'owner_mention' }, cls({ confidence: 0.69 }), c).reason, 'below_threshold');
  assert.equal(decideNew({ kind: 'owner_mention' }, cls({ intent: 'question' }), c).reason, 'intent_question');
  assert.equal(decideNew({ kind: 'owner_mention' }, cls({ actionable: false }), c).type, 'ignore');
});
test('decideFollowup', () => {
  const req = { owner: 'UO', scope: { outward_actions: [] }, approval_mode: 'task' };
  assert.equal(decideFollowup({ user: 'UO', text: 'deploy prod' }, req, null, c).type, 'forward');
  assert.equal(decideFollowup({ user: 'UR', text: 'hi' }, { ...req, scope: null }, cls(), c).reason, 'not_yet_approved');
  assert.equal(decideFollowup({ user: 'UR', text: 'raise the PR' }, req, cls({ followup: 'in_scope' }), c).reason, 'forced_pattern');
  assert.equal(decideFollowup({ user: 'UR', text: 'x' }, req, cls({ followup: 'in_scope' }), c).type, 'forward');
  assert.equal(decideFollowup({ user: 'UR', text: 'x' }, req, cls({ followup: 'scope_change' }), c).reason, 'scope_change');
  assert.equal(decideFollowup({ user: 'UR', text: 'x' }, { ...req, approval_mode: 'once' }, cls({ followup: 'in_scope' }), c).reason, 'approve_once');
  assert.equal(decideFollowup({ user: 'UR', text: 'thanks' }, req, cls({ followup: 'not_for_agent', reply_to_user: 'Any time.' }), c).text, 'Any time.');
  assert.equal(decideFollowup({ user: 'UR', text: 'x' }, req, null, c).reason, 'brain_error');
});
