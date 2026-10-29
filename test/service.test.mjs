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
  assert.ok(h.exec.calls.at(-1)[1].text.includes('also check the CSV one') && h.exec.calls.at(-1)[1].text.includes('<chat-followup from="name:UREQ">'), 'non-owner follow-ups are marked untrusted');
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
  assert.ok(h.chat.dms.length > dmsBefore);
  // the owner talking to people in the channel thread is not an instruction to the agent (they steer in the DM thread)
  const before = h.exec.calls.length;
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: m.thread_ts, user: OWNER, text: '@Preethi can you change the sub-tasks to stories' });
  await tick();
  assert.equal(h.exec.calls.length, before, 'untagged owner post in the channel is not forwarded');
  assert.ok(h.store.auditTail(5).some((r) => r.type === 'owner_untagged_ignored'));
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
  assert.ok(JSON.stringify(h.chat.dms[0].blocks).includes('May take *any* outward action: Comment on Jira, Raise a PR'), 'the blanket grant is visible on the card');
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
  assert.match(h.exec.calls.at(-1)[1].text, /^<owner-message token="[0-9a-f]{16}">\nalso do the CSV\n<\/owner-message>/);
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
  assert.ok(h.exec.calls.at(-1)[1].text.includes('and last week?'));
  assert.deepEqual([h.chat.lastDm().text, h.chat.lastDm().thread_ts], ['More.', m.ts]);
  assert.equal(h.store.listByState('PENDING_APPROVAL').length, 0, 'thread reply did not open a new request');
});

test('owners are never rate limited', async () => {
  const h = await harness({ brainScript: () => cls({ intent: 'chitchat', reply_to_user: 'Hi.', brief: null }) });
  for (let i = 0; i < 15; i++) await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: OWNER, text: `hello ${i}` });
  assert.ok(!h.chat.posts.some((p) => /a lot my way/.test(p.text)));
  assert.ok(!h.store.auditTail(50).some((r) => r.type === 'rate_limited'));
});

test('posting as the owner: report is rewritten in their voice, the card shows exactly that, and Post sends it', async () => {
  const h = await harness({ execScript: { start: 'There are 2 open PRs. I ran gh pr list. I took no outward actions.' } });
  h.chat.postAs = new Set([OWNER]);
  h.brain.rewriteAsOwner = async ({ report, ownerName }) => `Hey! 2 open PRs right now :+1: (${ownerName})`;
  const m = await h.chat.inject({ kind: 'owner_mention', owner: OWNER, channel: CHAN, user: REQ, text: 'any open PRs?' });
  const req = h.store.findByThread(CHAN, m.thread_ts);
  await h.chat.click(ACTIONS.DELEGATE, req.id, OWNER, h.chat.dms[0]); await tick();
  const card = JSON.stringify(h.chat.lastDm().blocks);
  assert.ok(card.includes('Hey! 2 open PRs right now :+1: (Faraj)') && card.includes('exactly as it will be posted'));
  assert.ok(!card.includes('I ran gh pr list'));
  await h.chat.click(ACTIONS.POST_RESULT, req.id, OWNER, h.chat.lastDm());
  assert.deepEqual([h.chat.posts.at(-1).text, h.chat.posts.at(-1).as], ['Hey! 2 open PRs right now :+1: (Faraj)', OWNER]);
});

test('owner-voice rewrite failure falls back to the raw report; Lekam posts are never rewritten', async () => {
  const h = await harness({ execScript: { start: 'Raw report.' } });
  h.chat.postAs = new Set([OWNER]);
  let calls = 0;
  h.brain.rewriteAsOwner = async () => { calls++; throw new Error('502'); };
  const m = await h.chat.inject({ kind: 'owner_mention', owner: OWNER, channel: CHAN, user: REQ, text: 'any open PRs?' });
  await h.chat.click(ACTIONS.DELEGATE, h.store.findByThread(CHAN, m.thread_ts).id, OWNER, h.chat.dms[0]); await tick();
  assert.ok(JSON.stringify(h.chat.lastDm().blocks).includes('Raw report.'));
  const b = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'fix the export' });
  await h.chat.click(ACTIONS.APPROVE_TASK, h.store.findByThread(CHAN, b.thread_ts).id, OWNER, h.chat.lastDm()); await tick();
  assert.equal(calls, 1, 'bot-mention results are not rewritten');
});

test('posted results @-tag people from the people file, on the card and in the thread', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lekam-')), 'roster.json');
  fs.writeFileSync(file, JSON.stringify({ members: [{ name: 'Adhy Karina', slackId: 'UADHY', github: 'rms-adhy-karina' }, { name: 'Faraj', slackId: OWNER, github: 'farajfarook' }] }));
  const config = testConfig({ people_file: file });
  const h = await harness({ config, execScript: { start: 'PR #196 by `rms-adhy-karina`, reviewed by farajfarook.' } });
  h.chat.postAs = new Set([OWNER]);
  let prompt;
  h.brain.rewriteAsOwner = async ({ people }) => { prompt = people; return 'Hey :+1: #196 is from {{@adhy-karina}}, I reviewed it.'; };
  const m = await h.chat.inject({ kind: 'owner_mention', owner: OWNER, channel: CHAN, user: REQ, text: 'any PRs?' });
  const req = h.store.findByThread(CHAN, m.thread_ts);
  await h.chat.click(ACTIONS.DELEGATE, req.id, OWNER, h.chat.dms[0]); await tick();
  assert.ok(prompt.includes('{{@adhy-karina}}') && !prompt.includes(OWNER), 'owner not offered as a placeholder');
  assert.ok(JSON.stringify(h.chat.lastDm().blocks).includes('#196 is from <@UADHY>'));
  await h.chat.click(ACTIONS.POST_RESULT, req.id, OWNER, h.chat.lastDm());
  assert.equal(h.chat.posts.at(-1).text, 'Hey :+1: #196 is from <@UADHY>, I reviewed it.');
  // Lekam posts (no rewrite) are tagged too; the owner is never tagged
  const b = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'fix the export' });
  await h.chat.click(ACTIONS.APPROVE_TASK, h.store.findByThread(CHAN, b.thread_ts).id, OWNER, h.chat.lastDm()); await tick();
  await h.chat.click(ACTIONS.POST_RESULT, h.store.findByThread(CHAN, b.thread_ts).id, OWNER, h.chat.lastDm());
  assert.equal(h.chat.posts.at(-1).text, 'PR #196 by <@UADHY>, reviewed by Faraj.');
});

test('owner steering a posting-as-owner session: agent answers the owner as-is, Draft reply rewrites, stale cards refuse', async () => {
  let turn = 0;
  const h = await harness({ execScript: { start: 'Verdict: APPROVE. Not posted yet.', send: () => ({ status: 'idle', text: ++turn === 1 ? 'Approved PR 156 on GitHub.' : 'Also left the nits.', error: null }) } });
  h.chat.postAs = new Set([OWNER]);
  h.brain.rewriteAsOwner = async ({ report }) => `Hey :+1: ${report}`;
  const m = await h.chat.inject({ kind: 'owner_mention', owner: OWNER, channel: CHAN, user: REQ, text: 'please re-review PR 156' });
  const req = h.store.findByThread(CHAN, m.thread_ts);
  const card = h.chat.dms[0];
  await h.chat.click(ACTIONS.DELEGATE, req.id, OWNER, card); await tick();
  const firstResult = h.chat.lastDm();
  const firstValue = firstResult.blocks.find((b) => b.type === 'actions').elements[0].value;
  // owner steers in the session thread
  await h.chat.inject({ kind: 'bot_mention', is_dm: true, channel: card.channel, thread_ts: card.ts, user: OWNER, text: 'just approve it' }); await tick();
  const sent = h.exec.calls.at(-1)[1].text;
  assert.ok(sent.includes('just approve it') && sent.includes('authoritative'), 'owner message is marked authoritative');
  const reply = h.chat.lastDm();
  assert.ok(JSON.stringify(reply.blocks).includes('Approved PR 156 on GitHub.'), 'agent reply shown as-is, not rewritten');
  assert.ok(!JSON.stringify(reply.blocks).includes('Hey :+1:'));
  const draftBtn = reply.blocks.find((b) => b.type === 'actions').elements[0];
  assert.equal(draftBtn.text.text, 'Draft reply as Faraj');
  // the older result card can no longer post (it would post stale text as Faraj)
  const posts = h.chat.posts.length;
  await h.chat.click(ACTIONS.POST_RESULT, firstValue, OWNER, firstResult);
  assert.equal(h.chat.posts.length, posts); assert.match(h.chat.ephemerals.at(-1).text, /out of date/);
  // draft, then post
  await h.chat.click(ACTIONS.DRAFT_REPLY, draftBtn.value, OWNER, reply);
  const draft = h.chat.lastDm();
  assert.ok(JSON.stringify(draft.blocks).includes('Hey :+1: Approved PR 156 on GitHub.'));
  await h.chat.click(ACTIONS.POST_RESULT, draft.blocks.find((b) => b.type === 'actions').elements[0].value, OWNER, draft);
  assert.deepEqual([h.chat.posts.at(-1).text, h.chat.posts.at(-1).as], ['Hey :+1: Approved PR 156 on GitHub.', OWNER]);
});

test('captured DM to the owner: silent card that says "messaged you", reply goes out as the owner, never rate limited', async () => {
  const h = await harness({ execScript: { start: 'Build is green.' } });
  h.chat.postAs = new Set([OWNER]);
  h.chat.channelName = async () => null; // Lekam can't name a DM it isn't in
  for (let i = 0; i < 12; i++) await h.chat.inject({ kind: 'owner_mention', owner: OWNER, dm: true, channel: 'DTING', user: 'UTING', text: `msg ${i}` });
  assert.ok(!h.store.auditTail(80).some((r) => r.type === 'rate_limited'));
  const m = await h.chat.inject({ kind: 'owner_mention', owner: OWNER, dm: true, channel: 'DTING', user: 'UTING', text: 'is the build green?' });
  assert.match(h.brain.calls.at(-1).input.channel, /a direct message to Faraj/);
  const req = h.store.findByThread('DTING', m.thread_ts);
  const card = h.chat.dms.at(-1);
  assert.ok(JSON.stringify(card.blocks).includes('messaged you'));
  assert.equal(h.chat.posts.length, 0);
  await h.chat.click(ACTIONS.DELEGATE, req.id, OWNER, card); await tick();
  await h.chat.click(ACTIONS.POST_RESULT, req.id, OWNER, h.chat.lastDm());
  assert.deepEqual([h.chat.posts.at(-1).channel, h.chat.posts.at(-1).as, h.chat.posts.at(-1).text], ['DTING', OWNER, 'Build is green.']);
});

test('replay OP-316: "@Faraj & I tried" in a thread asking Preethi is not a request to the owner', async () => {
  const h = await harness({ brainScript: (input) => (input.text.startsWith('@name:UOWNER &') ? cls({ intent: 'fyi', addressed_to_owner: false, actionable: false, brief: null, reply_to_user: null }) : cls()) });
  const parent = await h.chat.inject({ kind: 'followup', channel: CHAN, user: 'UMARK', text: '@Preethi Prakash need your help to convert sub tasks OP-316,OP-317 and OP-318 to user stories' });
  await h.chat.inject({ kind: 'owner_mention', owner: OWNER, channel: CHAN, thread_ts: parent.ts, user: 'UMARK', text: '@name:UOWNER & I tried, but looks like we dont have access' });
  assert.equal(h.chat.dms.length, 0, 'no card');
  assert.equal(h.chat.posts.length, 0);
  assert.ok(h.store.auditTail(5).some((r) => r.type === 'decision' && r.data.reason === 'not_addressed_to_owner'));
  assert.ok(h.brain.calls.at(-1).input.thread.some((m) => m.text.includes('@Preethi Prakash need your help')), 'the brain sees who the thread is addressed to');
});

test('the agent gets the thread, and an owner-thread follow-up never makes Lekam chime in as itself', async () => {
  const h = await harness({ brainScript: (input) => (input.kind === 'followup' ? cls({ followup: 'not_for_agent', reply_to_user: 'Thanks, Markand.' }) : cls()), execScript: { start: 'Report.' } });
  h.chat.postAs = new Set([OWNER]);
  const parent = await h.chat.inject({ kind: 'followup', channel: CHAN, user: 'UMARK', text: 'earlier context line' });
  await h.chat.inject({ kind: 'owner_mention', owner: OWNER, channel: CHAN, thread_ts: parent.ts, user: REQ, text: '@name:UOWNER can your team check the build?' });
  const req = h.store.findByThread(CHAN, parent.ts);
  await h.chat.click(ACTIONS.DELEGATE, req.id, OWNER, h.chat.dms[0]); await tick();
  const start = h.exec.calls.find((c) => c[0] === 'start')[1];
  assert.deepEqual(start.thread, [{ name: 'name:UMARK', text: 'earlier context line' }]);
  assert.equal(start.channelName, 'chan-' + CHAN);
  const posts = h.chat.posts.length;
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: parent.ts, user: 'UMARK', text: 'Right, I see this option' }); await tick();
  assert.equal(h.chat.posts.length, posts, 'no persona reply in a thread where the owner was asked');
});

test('posts as the owner keep Lekam out of the thread; posts by another app as the owner are flagged, never acted on', async () => {
  const h = await harness({ execScript: { start: 'Report.', send: 'sent' } });
  h.chat.postAs = new Set([OWNER]);
  const m = await h.chat.inject({ kind: 'owner_mention', owner: OWNER, channel: CHAN, user: REQ, text: '@name:UOWNER any open PRs?' });
  const req = h.store.findByThread(CHAN, m.thread_ts);
  await h.chat.click(ACTIONS.DELEGATE, req.id, OWNER, h.chat.dms[0]); await tick();
  assert.equal(h.chat.posts.at(-1).as, OWNER, 'pickup ack went out as the owner');
  assert.equal(h.store.botSpokeRecently(CHAN, m.thread_ts, { withinMs: 60e3 }), false, 'a post as the owner does not engage Lekam in the thread');
  const sends = h.exec.calls.length; const dms = h.chat.dms.length;
  h.config.watches.detect.enabled = false; // no session detection: a live request with an agent is flagged
  await h.chat.inject({ kind: 'followup', channel: CHAN, thread_ts: m.thread_ts, user: OWNER, via_app: 'AOTHER', text: '@Preethi Markand and Faraj cannot convert them' }); await tick();
  assert.equal(h.exec.calls.length, sends, 'not forwarded to the agent');
  assert.equal(h.chat.dms.length, dms + 1);
  assert.match(h.chat.lastDm().text, /posted as you .* by another app/);
  assert.equal(h.chat.lastDm().thread_ts, h.chat.dms[0].ts, 'flag sits in the session thread');
});

test('agent turns are serialised per request: overlapping owner messages get one answer each', async () => {
  let n = 0;
  const h = await harness({ execScript: { start: 'first', send: () => ({ status: 'idle', text: `answer ${++n}`, error: null }) } });
  h.exec.delayMs = 0;
  const m = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'fix the export' });
  const req = h.store.findByThread(CHAN, m.thread_ts);
  const card = h.chat.dms[0];
  await h.chat.click(ACTIONS.APPROVE_TASK, req.id, OWNER, card); await tick();
  h.exec.delayMs = 20;
  let inFlight = 0, maxInFlight = 0;
  const send = h.exec.send.bind(h.exec);
  h.exec.send = async (args) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); try { return await send(args); } finally { inFlight--; } };
  await Promise.all([
    h.chat.inject({ kind: 'bot_mention', is_dm: true, channel: card.channel, thread_ts: card.ts, user: OWNER, text: 'one' }),
    h.chat.inject({ kind: 'bot_mention', is_dm: true, channel: card.channel, thread_ts: card.ts, user: OWNER, text: 'two' }),
  ]);
  assert.equal(maxInFlight, 1);
  const replies = h.chat.dms.slice(-2).map((d) => d.text);
  assert.deepEqual(replies, ['answer 1', 'answer 2']);
});

test('the thread root (a CI post) reaches the brain and the brief, and the owner\'s untagged answer to a clarifying question is taken up', async () => {
  let n = 0;
  const h = await harness({ brainScript: () => (++n === 1
    ? cls({ intent: 'needs_clarification', actionable: false, confidence: 0.5, brief: null, reply_to_user: null, clarifying_question: 'What should be checked and fixed?' })
    : cls({ reply_to_user: null })) });
  const root = { user: 'BCI', name: 'Azure Pipelines', ts: '100.000001', text: 'My Stay full suite failed\n*Commit* `a7338`' };
  h.chat.thread(CHAN, root.ts).push(root);
  const ask = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, thread_ts: root.ts, user: OWNER, text: 'can u check and fix it' });
  assert.deepEqual(h.brain.calls[0].input.thread[0], { user: 'Azure Pipelines', text: root.text, ts: root.ts }, 'bot post named and kept');
  assert.equal(h.chat.posts.at(-1).text, 'What should be checked and fixed?');
  assert.deepEqual(h.chat.reactionsOn(CHAN, ask.ts), ['question']);
  // Untagged reply from the owner: normally an owner post Lekam stays out of; here it answers Lekam's question.
  await h.chat.inject({ kind: 'owner_post', owner: OWNER, channel: CHAN, thread_ts: root.ts, user: OWNER, text: 'Look at the thread fix the failing test', hints: {} });
  assert.equal(h.brain.calls.length, 2, 'answer classified');
  const req = h.store.findByThread(CHAN, root.ts);
  assert.ok(req && req.state !== 'PENDING_APPROVAL', 'the owner asked: job started, no approval card');
  assert.equal(req.classification.thread_excerpt[0].ts, root.ts, 'CI post is in the brief excerpt');
  // Only once: the next untagged owner line in the thread is the owner talking again.
  const calls = h.brain.calls.length;
  await h.chat.inject({ kind: 'owner_post', owner: OWNER, channel: CHAN, thread_ts: root.ts, user: OWNER, text: 'thanks', hints: {} });
  assert.equal(h.brain.calls.length, calls);
});

test('excerptOf keeps the thread root when the thread is long', async () => {
  const { excerptOf } = await import('../src/core/service.mjs');
  const thread = Array.from({ length: 15 }, (_, i) => ({ user: i % 4 === 3 ? 'UBOT' : 'U' + i, ts: String(i), text: 't' + i }));
  const ex = excerptOf(thread, { skipTs: '14', botUserId: 'UBOT' });
  assert.equal(ex.length, 8); assert.equal(ex[0].ts, '0'); assert.equal(ex.at(-1).ts, '13');
  assert.ok(!ex.some((m) => m.user === 'UBOT'));
});

test('the owner tagging Lekam starts the job with no approval card; the reply still waits for Post; Slack/email withheld', async () => {
  const h = await harness({ execScript: { start: 'Created AI-123.' }, config: testConfig({ outward_actions: { jira_create: 'Create a Jira ticket', jira_comment: 'Comment on Jira', slack_post: 'Post to Slack', email_send: 'Send email' } }) });
  const m = await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: OWNER, text: 'create a jira to set up veracode for mcp server external' });
  await tick();
  const req = h.store.findByThread(CHAN, m.thread_ts);
  assert.equal(h.exec.calls[0]?.[0], 'start', 'started without a click');
  assert.deepEqual(h.exec.calls[0][1].allowed, ['jira_create', 'jira_comment']);
  assert.ok(!JSON.stringify(h.chat.dms[0].blocks).includes(ACTIONS.APPROVE_TASK), 'status card, not an approval card');
  assert.match(h.chat.dms[0].text, /Starting \(you asked\)/);
  assert.equal(h.store.getRequest(req.id).state, 'DONE');
  assert.equal(h.chat.posts.filter((p) => p.channel === CHAN).length, 0, 'nothing posted in the thread yet');
  const result = h.chat.lastDm();
  assert.ok(JSON.stringify(result.blocks).includes(ACTIONS.POST_RESULT), 'result waits for Post');
  await h.chat.click(ACTIONS.POST_RESULT, req.id, OWNER, result); await tick();
  assert.equal(h.chat.posts.at(-1).text.includes('Created AI-123.'), true);
});

test('owner_auto_start off, or someone else tagging Lekam: approval card as before', async () => {
  const h = await harness({ config: testConfig({ approvals: { owner_auto_start: false } }) });
  await h.chat.inject({ kind: 'bot_mention', channel: CHAN, user: OWNER, text: 'fix the export' });
  assert.ok(JSON.stringify(h.chat.dms[0].blocks).includes(ACTIONS.APPROVE_TASK));
  assert.equal(h.exec.calls.length, 0);
  const h2 = await harness();
  await h2.chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'fix the export' });
  assert.ok(JSON.stringify(h2.chat.dms[0].blocks).includes(ACTIONS.APPROVE_TASK));
  assert.equal(h2.exec.calls.length, 0);
});
