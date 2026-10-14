import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, cls, OWNER, REQ, CHAN } from './helpers.mjs';
import { ACTIONS } from '../src/approvals/cards.mjs';

const tick = () => new Promise((r) => setTimeout(r, 5));

test('bot mention -> card -> approve task -> run -> result DM -> post', async () => {
  const h = await harness({ execScript: { start: 'Fixed in PR #419.\nDetails...' } });
  const m = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'fix the export' });
  const req = h.store.findByThread(CHAN, m.thread_ts);
  assert.equal(req.state, 'PENDING_APPROVAL');
  assert.deepEqual(h.chat.reactionsOn(CHAN, m.ts), ['eyes']);
  assert.equal(h.chat.dms.length, 1);
  const card = h.chat.dms[0];
  assert.equal(card.user, OWNER);
  assert.ok(JSON.stringify(card.blocks).includes('> fix the export'), 'verbatim quote');
  assert.ok(JSON.stringify(card.blocks).includes(ACTIONS.APPROVE_TASK));
  // a reply in persona was posted
  assert.equal(h.chat.posts[0].text, 'On it once Faraj says yes.');

  await h.chat.click(ACTIONS.APPROVE_TASK, req.id, OWNER, card);
  await tick();
  const done = h.store.getRequest(req.id);
  assert.equal(done.state, 'DONE');
  assert.equal(done.approval_mode, 'task');
  assert.deepEqual(done.scope.outward_actions, ['jira_comment', 'pr_create']);
  assert.equal(h.exec.calls[0][0], 'start');
  assert.deepEqual(h.exec.calls[0][1].allowed, ['jira_comment', 'pr_create']);
  // result went to owner, not thread
  const result = h.chat.lastDm();
  assert.ok(JSON.stringify(result.blocks).includes(ACTIONS.POST_RESULT));
  assert.equal(h.chat.posts.length, 1);
  await h.chat.click(ACTIONS.POST_RESULT, req.id, OWNER, result);
  assert.equal(h.store.getRequest(req.id).state, 'RELEASED');
  assert.equal(h.chat.posts[1].text, 'Fixed in PR #419.\nDetails...');
  assert.deepEqual(h.chat.reactionsOn(CHAN, m.ts), ['white_check_mark']);
});

test('owner mention is silent in channel until delegated', async () => {
  const h = await harness();
  const m = await h.chat.inject({ kind: 'owner_mention', owner: OWNER, channel: CHAN, user: REQ, text: 'the export is blank again' });
  assert.equal(h.chat.posts.length, 0);
  assert.deepEqual(h.chat.reactionsOn(CHAN, m.ts), []);
  const card = h.chat.dms[0];
  assert.ok(JSON.stringify(card.blocks).includes(ACTIONS.DELEGATE));
  const req = h.store.findByThread(CHAN, m.thread_ts);
  await h.chat.click(ACTIONS.DELEGATE_NO_OUTWARD, req.id, OWNER, card);
  await tick();
  assert.match(h.chat.posts[0].text, /Faraj asked me to pick this up/);
  assert.deepEqual(h.store.getRequest(req.id).scope.outward_actions, []);
});

test('owner mention below threshold or non-task is ignored silently', async () => {
  const h = await harness({ brainScript: () => cls({ confidence: 0.5 }) });
  await h.chat.inject({ kind: 'owner_mention', owner: OWNER, channel: CHAN, user: REQ, text: 'fyi moved the items' });
  assert.equal(h.chat.dms.length, 0);
  assert.equal(h.chat.posts.length, 0);
  assert.ok(h.store.auditTail(5).some((r) => r.type === 'decision' && r.data.reason === 'below_threshold'));
});

test('only the owner can act on a card; text and reactions never approve', async () => {
  const h = await harness();
  const m = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'do the thing' });
  const req = h.store.findByThread(CHAN, m.thread_ts);
  await h.chat.click(ACTIONS.APPROVE_TASK, req.id, REQ, h.chat.dms[0]);
  assert.equal(h.store.getRequest(req.id).state, 'PENDING_APPROVAL');
  assert.equal(h.chat.ephemerals[0].text, 'Not yours to approve.');
  assert.ok(h.store.auditFor(req.id).some((r) => r.type === 'approval_rejected_identity'));
  // requester says "approved" in thread: still pending
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: m.thread_ts, user: REQ, text: 'approved go ahead' });
  assert.equal(h.store.getRequest(req.id).state, 'PENDING_APPROVAL');
  assert.equal(h.exec.calls.length, 0);
});

test('decline posts one line and sets the declined reaction', async () => {
  const h = await harness();
  const m = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'deploy prod now' });
  const req = h.store.findByThread(CHAN, m.thread_ts);
  await h.chat.click(ACTIONS.DECLINE, req.id, OWNER, h.chat.dms[0]);
  assert.equal(h.store.getRequest(req.id).state, 'DENIED');
  assert.match(h.chat.posts.at(-1).text, /passed on this one/);
  assert.deepEqual(h.chat.reactionsOn(CHAN, m.ts), ['no_entry_sign']);
});

test('expiry denies without posting', async () => {
  const h = await harness();
  const m = await h.chat.inject({ kind: 'owner_mention', owner: OWNER, channel: CHAN, user: REQ, text: 'please look at the export' });
  const req = h.store.findByThread(CHAN, m.thread_ts);
  h.store.updateRequest(req.id, { expires_at: Date.now() - 1 });
  await h.svc.expireCards();
  assert.equal(h.store.getRequest(req.id).state, 'EXPIRED');
  assert.equal(h.chat.posts.length, 0);
  assert.match(h.chat.updates.at(-1).text, /Expired/);
});

test('follow-ups: in-scope forwards, scope change cards, owner bypasses, approve-once re-asks', async () => {
  let fu = 'in_scope';
  const h = await harness({ brainScript: (input) => input.kind === 'followup' ? cls({ followup: fu, reply_to_user: null }) : cls(), execScript: { start: 'done', send: 'sent' } });
  const m = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'fix the export' });
  const req = h.store.findByThread(CHAN, m.thread_ts);
  await h.chat.click(ACTIONS.APPROVE_TASK, req.id, OWNER, h.chat.dms[0]);
  await tick();
  assert.equal(h.store.getRequest(req.id).state, 'DONE');
  const dmsBefore = h.chat.dms.length;
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: m.thread_ts, user: REQ, text: 'also check the CSV one' });
  await tick();
  assert.equal(h.exec.calls.at(-1)[0], 'send');
  assert.equal(h.exec.calls.at(-1)[1].text, 'also check the CSV one');
  // scope change -> card, no send
  fu = 'scope_change';
  const sends = h.exec.calls.length;
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: m.thread_ts, user: REQ, text: 'and do it in core-pms too' });
  assert.equal(h.exec.calls.length, sends);
  assert.ok(JSON.stringify(h.chat.lastDm().blocks).includes('Follow-up on req'));
  // forced pattern -> card even when brain says in_scope
  fu = 'in_scope';
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: m.thread_ts, user: REQ, text: 'now raise the PR' });
  assert.equal(h.exec.calls.length, sends);
  // owner follow-up bypasses everything
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: m.thread_ts, user: OWNER, text: 'use the test branch' });
  await tick();
  assert.equal(h.exec.calls.at(-1)[1].text, 'use the test branch');
  assert.ok(h.chat.dms.length > dmsBefore);
});

test('discuss first: investigate, pipe owner DM, proceed on same session', async () => {
  const h = await harness({ execScript: { investigate: 'Plan: fix renderer', send: 'sure', proceed: 'Done it' } });
  const m = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'fix the export' });
  const req = h.store.findByThread(CHAN, m.thread_ts);
  const card = h.chat.dms[0];
  await h.chat.click(ACTIONS.DISCUSS, req.id, OWNER, card);
  await tick();
  assert.equal(h.store.getRequest(req.id).state, 'INVESTIGATING');
  assert.equal(h.exec.calls[0][0], 'investigate');
  assert.deepEqual(h.exec.calls[0][1].brief.summary, 'Fix the blank PDF export');
  const plan = h.chat.dms.find((d) => d.thread_ts === card.ts);
  assert.equal(plan.text, 'Plan: fix renderer');
  // owner talks in the card thread
  await h.chat.inject({ kind: 'bot_mention', is_dm: true, channel: card.channel, thread_ts: card.ts, user: OWNER, text: 'what about the CSV path?' });
  assert.equal(h.exec.calls.at(-1)[0], 'send');
  assert.equal(h.chat.lastDm().text, 'sure');
  await h.chat.click(ACTIONS.PROCEED, req.id, OWNER, card);
  await tick();
  assert.equal(h.exec.calls.at(-1)[0], 'proceed');
  assert.equal(h.store.getRequest(req.id).state, 'DONE');
  assert.equal(h.exec.sessions.get(req.id).id, 'agent1');
});

test('edit brief updates the stored brief and the card', async () => {
  const h = await harness();
  const m = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'fix the export' });
  const req = h.store.findByThread(CHAN, m.thread_ts);
  await h.chat.click(ACTIONS.EDIT, req.id, OWNER, h.chat.dms[0]);
  assert.equal(h.chat.modals.length, 1);
  await h.svc.onView({ request_id: req.id, user: OWNER, view: { state: { values: { summary: { v: { value: 'New summary' } }, skill: { v: { value: '' } }, repo: { v: { value: 'owner-portal' } }, notes: { v: { value: 'n' } }, outward: { v: { selected_options: [{ value: 'jira_comment' }] } } } } } });
  const r = h.store.getRequest(req.id);
  assert.equal(r.brief.summary, 'New summary');
  assert.deepEqual(r.brief.outward_actions, ['jira_comment']);
  assert.ok(JSON.stringify(h.chat.updates.at(-1).blocks).includes('New summary'));
});

test('failed run sets failed reaction and tells the requester briefly', async () => {
  const h = await harness({ execScript: { start: () => ({ status: 'error', text: '', error: 'boom' }) } });
  const m = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'fix the export' });
  const req = h.store.findByThread(CHAN, m.thread_ts);
  await h.chat.click(ACTIONS.APPROVE_TASK, req.id, OWNER, h.chat.dms[0]);
  await tick();
  assert.equal(h.store.getRequest(req.id).state, 'FAILED');
  assert.deepEqual(h.chat.reactionsOn(CHAN, m.ts), ['x']);
  assert.match(h.chat.posts.at(-1).text, /didn't go through/);
});

test('duplicate events are dropped; rate limit replies once', async () => {
  const h = await harness();
  const m = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'fix the export' });
  await h.chat.inject({ ...m, kind: 'bot_mention' });
  assert.equal(h.chat.dms.length, 1);
  for (let i = 0; i < 12; i++) await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: 'USPAM', text: `req ${i}` });
  assert.ok(h.chat.posts.some((p) => /a lot my way/.test(p.text)));
  assert.ok(h.store.auditTail(50).some((r) => r.type === 'rate_limited'));
});

test('auto-post ticked posts result straight to the thread', async () => {
  const h = await harness({ execScript: { start: 'All sorted.' } });
  const m = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'fix the export' });
  const req = h.store.findByThread(CHAN, m.thread_ts);
  await h.chat.select(ACTIONS.AUTO_POST, req.id, OWNER, ['auto_post']);
  await h.chat.click(ACTIONS.APPROVE_TASK, req.id, OWNER, h.chat.dms[0]);
  await tick();
  assert.equal(h.store.getRequest(req.id).state, 'RELEASED');
  assert.equal(h.chat.posts.at(-1).text, 'All sorted.');
});
