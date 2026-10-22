import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, cls, testConfig, OWNER, REQ, CHAN } from './helpers.mjs';
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
  assert.ok(JSON.stringify(card.blocks).includes(`<https://slack.example/${CHAN}/${m.ts}|thread>`), 'thread link Slack unfurls into the original');
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
  assert.ok(JSON.stringify(h.chat.lastDm().blocks).includes('*Follow-up* from'));
  assert.equal(h.chat.lastDm().thread_ts, h.chat.dms[0].ts, 'follow-up card sits in the card thread');
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
  assert.equal(plan.text, '<@UOWNER> Plan: fix renderer');
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

test('results always wait for the owner; the card has no auto-post option', async () => {
  const h = await harness({ execScript: { start: 'All sorted.' } });
  const m = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'fix the export' });
  const req = h.store.findByThread(CHAN, m.thread_ts);
  assert.ok(!JSON.stringify(h.chat.dms[0].blocks).includes('without asking me'));
  await h.chat.click(ACTIONS.APPROVE_TASK, req.id, OWNER, h.chat.dms[0]);
  await tick();
  assert.equal(h.store.getRequest(req.id).state, 'DONE');
  assert.ok(!h.chat.posts.some((p) => p.text === 'All sorted.'), 'not posted before the owner says so');
  assert.ok(JSON.stringify(h.chat.lastDm().blocks).includes(ACTIONS.POST_RESULT));
});

test('owner tagging themselves: low confidence still cards, nothing in the thread until Post, result posts as the owner', async () => {
  const h = await harness({ brainScript: () => cls({ intent: 'question', actionable: true, confidence: 0.4, reply_to_user: null, brief: { summary: 'Check leave plans for the next 4 months and report back', skill: null, repo: null, outward_actions: [], notes: '' } }), execScript: { start: 'Nobody on leave.' } });
  h.chat.postAs = new Set([OWNER]);
  const m = await h.chat.inject({ kind: 'owner_mention', owner: OWNER, self: true, channel: CHAN, user: OWNER, text: 'any leave plans for next 4 months?' });
  const req = h.store.findByThread(CHAN, m.thread_ts);
  assert.equal(req.state, 'PENDING_APPROVAL');
  assert.ok(JSON.stringify(h.chat.dms[0].blocks).includes('unsure this is a request'));
  await h.chat.click(ACTIONS.DELEGATE, req.id, OWNER, h.chat.dms[0]); await tick();
  assert.equal(h.chat.posts.length, 0, 'no pickup line when the owner asked');
  assert.ok(JSON.stringify(h.chat.lastDm().blocks).includes('Post to thread as Faraj'));
  await h.chat.click(ACTIONS.POST_RESULT, req.id, OWNER, h.chat.lastDm());
  assert.deepEqual([h.chat.posts.at(-1).text, h.chat.posts.at(-1).as], ['Nobody on leave.', OWNER]);
});

test('owner-tag replies post as the owner when a user token is set; Lekam-tag replies post as Lekam', async () => {
  const h = await harness({ execScript: { start: 'Report.' } });
  h.chat.postAs = new Set([OWNER]);
  const m = await h.chat.inject({ kind: 'owner_mention', owner: OWNER, channel: CHAN, user: REQ, text: 'the export is blank again' });
  const req = h.store.findByThread(CHAN, m.thread_ts);
  await h.chat.click(ACTIONS.DELEGATE, req.id, OWNER, h.chat.dms[0]); await tick();
  assert.equal(h.chat.posts[0].as, OWNER); assert.match(h.chat.posts[0].text, /Looking into this/);
  const result = h.chat.lastDm();
  assert.ok(JSON.stringify(result.blocks).includes('Post to thread as Faraj'));
  await h.chat.click(ACTIONS.POST_RESULT, req.id, OWNER, result);
  assert.deepEqual([h.chat.posts.at(-1).text, h.chat.posts.at(-1).as], ['Report.', OWNER]);

  const b = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'fix the export' });
  const breq = h.store.findByThread(CHAN, b.thread_ts);
  await h.chat.click(ACTIONS.APPROVE_TASK, breq.id, OWNER, h.chat.lastDm()); await tick();
  await h.chat.click(ACTIONS.POST_RESULT, breq.id, OWNER, h.chat.lastDm());
  assert.equal(h.chat.posts.at(-1).as, null);
});

test('untagged reply in a thread where Lekam spoke is treated as a mention', async () => {
  let n = 0;
  const h = await harness({ brainScript: () => (n++ === 0 ? cls({ intent: 'chitchat', reply_to_user: 'Hello.' , brief: null }) : cls()) });
  const m = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'hello' });
  assert.equal(h.chat.posts[0].text, 'Hello.');
  assert.equal(h.store.findByThread(CHAN, m.thread_ts), null);
  assert.ok(await h.svc.chat.isEngaged(CHAN, m.thread_ts), 'thread engaged after bot reply');
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: m.thread_ts, user: REQ, text: 'check open issues in owner portal' });
  assert.equal(h.store.findByThread(CHAN, m.thread_ts)?.state, 'PENDING_APPROVAL');
  assert.equal(h.chat.dms.length, 1);
});

test('a thread Lekam posted in before a restart is recognised from the thread itself', async () => {
  const h = await harness();
  h.chat.botUserId = 'UBOT';
  const ts = `${(Date.now() - 60000) / 1000}`;
  h.chat.thread(CHAN, ts).push({ user: REQ, text: 'hello', ts }, { user: 'UBOT', text: 'Hello.', ts: `${(Date.now() - 30000) / 1000}` });
  assert.ok(await h.svc.isEngagedThread(CHAN, ts));
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: ts, user: REQ, text: 'check open issues' });
  assert.equal(h.store.findByThread(CHAN, ts)?.state, 'PENDING_APPROVAL');
});

test('card shows thread context when the trigger refers back', async () => {
  let n = 0;
  const h = await harness({ brainScript: () => (n++ === 0 ? cls({ intent: 'chitchat', reply_to_user: 'Hello.', brief: null }) : cls()) });
  h.chat.botUserId = 'UBOT';
  const first = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'hello' });
  h.chat.thread(CHAN, first.thread_ts).push({ user: REQ, text: 'check open issues in owner portal', ts: '9' });
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: first.thread_ts, user: REQ, text: 'check again please' });
  const s = JSON.stringify(h.chat.lastDm().blocks);
  assert.ok(s.includes('Earlier in the thread') && s.includes('check open issues in owner portal') && s.includes('|thread>'));
});

test('brain receives display names, not ids', async () => {
  const h = await harness();
  await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'fix the export' });
  const input = h.brain.calls[0].input;
  assert.equal(input.requester, 'name:' + REQ);
  assert.equal(input.channel, '#chan-' + CHAN);
  assert.ok(input.thread.every((m) => m.user.startsWith('name:') || m.user === 'Lekam'));
});

test('outward_actions_mode: all grants everything and skips keyword cards; proposed grants the brief', async () => {
  const all = testConfig({ approvals: { outward_actions_mode: 'all' } });
  let h = await harness({ config: all, execScript: { start: 'ok', send: 'ok' } });
  let m = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'look at this' });
  let req = h.store.findByThread(CHAN, m.thread_ts);
  assert.ok(!JSON.stringify(h.chat.dms[0].blocks).includes('lekam_outward_select'));
  await h.chat.click(ACTIONS.APPROVE_TASK, req.id, OWNER, h.chat.dms[0]); await tick();
  assert.deepEqual(h.store.getRequest(req.id).scope.outward_actions, ['jira_comment', 'pr_create']);
  const sends = h.exec.calls.length;
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: m.thread_ts, user: REQ, text: 'now raise the PR' }); await tick();
  assert.equal(h.exec.calls.length, sends + 1, 'keyword did not force a card in all mode');
  const prop = testConfig({ approvals: { outward_actions_mode: 'proposed' } });
  h = await harness({ config: prop });
  m = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'look at this' });
  assert.ok(JSON.stringify(h.chat.dms[0].blocks).includes('May: Comment on Jira, Raise a PR'));
  req = h.store.findByThread(CHAN, m.thread_ts);
  await h.chat.click(ACTIONS.APPROVE_TASK, req.id, OWNER, h.chat.dms[0]); await tick();
  assert.deepEqual(h.store.getRequest(req.id).scope.outward_actions, ['jira_comment', 'pr_create']);
});

test('brain down: the message still reaches the owner as a card with the raw text, and the asker gets an honest ack', async () => {
  const h = await harness({ brainScript: () => { throw new Error('brain endpoint 502'); } });
  await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'who did what last week' });
  const m = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'ai and portal team for last 1 month' });
  const req = h.store.findByThread(CHAN, m.thread_ts);
  assert.equal(req.state, 'PENDING_APPROVAL');
  const s = JSON.stringify(h.chat.lastDm().blocks);
  assert.ok(s.includes('not pre-read') && s.includes('ai and portal team for last 1 month'));
  assert.match(h.chat.posts.at(-1).text, /passed this to Faraj/);
  assert.ok(!h.chat.posts.some((p) => /make sense/.test(p.text)));
});

test('session thread: result card, failures and owner replies all live under the approval card', async () => {
  const h = await harness({ execScript: { start: 'First report.', send: 'Second report.' } });
  const m = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'fix the export' });
  const req = h.store.findByThread(CHAN, m.thread_ts);
  const card = h.chat.dms[0];
  assert.equal(card.thread_ts, null, 'card is the top-level message');
  await h.chat.click(ACTIONS.APPROVE_TASK, req.id, OWNER, card); await tick();
  const result = h.chat.lastDm();
  assert.equal(result.thread_ts, card.ts);
  assert.ok(JSON.stringify(result.blocks).includes('<@UOWNER> Result for'), 'owner is nudged in a bot-started thread');
  await h.chat.click(ACTIONS.POST_RESULT, req.id, OWNER, result);
  assert.equal(h.store.getRequest(req.id).state, 'RELEASED');
  // owner keeps talking to the agent in the card thread after posting
  await h.chat.inject({ kind: 'bot_mention', is_dm: true, channel: card.channel, thread_ts: card.ts, user: OWNER, text: 'also do the CSV' }); await tick();
  assert.equal(h.exec.calls.at(-1)[1].text, 'also do the CSV');
  assert.equal(h.chat.lastDm().thread_ts, card.ts);
  assert.ok(JSON.stringify(h.chat.lastDm().blocks).includes('Second report.'));
  await h.chat.click(ACTIONS.POST_RESULT, req.id, OWNER, h.chat.lastDm());
  assert.equal(h.chat.posts.at(-1).text, 'Second report.');
  assert.equal(h.chat.dms.filter((d) => !d.thread_ts).length, 1, 'only the card is top-level');
});

test('owner DMs Lekam: card, result and replies thread under the owner\'s own message; no Post step', async () => {
  const h = await harness({ execScript: { start: 'Here you go.', send: 'More.' } });
  const DM = `DM_${OWNER}`;
  const m = await h.chat.inject({ kind: 'bot_mention', is_dm: true, channel: DM, user: OWNER, text: 'what did the team ship' });
  const req = h.store.findByThread(DM, m.ts);
  const card = h.chat.dms[0];
  assert.equal(card.thread_ts, m.ts, 'card replies under the owner message');
  assert.equal(h.chat.posts.length, 0, 'no "I\'ve asked Faraj" to Faraj');
  await h.chat.click(ACTIONS.APPROVE_TASK, req.id, OWNER, card); await tick();
  assert.deepEqual([h.chat.lastDm().text, h.chat.lastDm().thread_ts], ['Here you go.', m.ts]);
  assert.equal(h.store.getRequest(req.id).state, 'RELEASED');
  await h.chat.inject({ kind: 'bot_mention', is_dm: true, channel: DM, thread_ts: m.ts, user: OWNER, text: 'and last week?' }); await tick();
  assert.equal(h.exec.calls.at(-1)[1].text, 'and last week?');
  assert.deepEqual([h.chat.lastDm().text, h.chat.lastDm().thread_ts], ['More.', m.ts]);
  assert.equal(h.store.listByState('PENDING_APPROVAL').length, 0, 'thread reply did not open a new request');
});

test('owners are never rate limited', async () => {
  const h = await harness({ brainScript: () => cls({ intent: 'chitchat', reply_to_user: 'Hi.', brief: null }) });
  for (let i = 0; i < 15; i++) await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: OWNER, text: `hello ${i}` });
  assert.ok(!h.chat.posts.some((p) => /a lot my way/.test(p.text)));
  assert.ok(!h.store.auditTail(50).some((r) => r.type === 'rate_limited'));
});
