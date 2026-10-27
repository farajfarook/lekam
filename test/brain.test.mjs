import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, SchemaError, CLASSIFICATION_SCHEMA } from '../src/brain/schema.mjs';
import { systemPrompt, userTurn } from '../src/brain/prompt.mjs';
import { OpenAICompatibleBrain, BrainError } from '../src/brain/openai-compatible.mjs';
import { cls } from './helpers.mjs';

test('schema validates good and rejects bad', () => {
  validate(cls());
  assert.throws(() => validate({ ...cls(), confidence: undefined }), SchemaError);
  assert.throws(() => validate({ ...cls(), intent: 'party' }), SchemaError);
  assert.throws(() => validate({ ...cls(), extra: 1 }), SchemaError);
  assert.throws(() => validate({ ...cls(), confidence: 1.5 }), SchemaError);
  validate({ ...cls(), brief: null, followup: null });
});
test('prompt contains persona first, catalogue, outcomes, and no tool words', () => {
  const s = systemPrompt({ persona: 'PERSONA', catalogue: 'CAT', outcomes: ['o1'], ownerName: 'Faraj' });
  assert.ok(s.startsWith('PERSONA')); assert.ok(s.includes('CAT') && s.includes('- o1') && s.includes('Faraj'));
  const u = JSON.parse(userTurn({ kind: 'bot_mention', requester: 'U', channel: 'C', text: 'hi', thread: [{ user: 'U', text: 'a', ts: '1' }], ownerName: 'F' }));
  assert.deepEqual(u.thread_excerpt, [{ user: 'U', text: 'a' }]);
});
test('request body has no tools; usage audited; retry on bad json; 5xx retried with backoff; 4xx not', async () => {
  const bodies = []; const audits = []; let n = 0;
  const mk = (responses) => async (url, init) => { bodies.push(JSON.parse(init.body)); const r = responses[n++]; return { ok: r.status === 200, status: r.status, headers: { get: () => null }, text: async () => JSON.stringify(r.body) }; };
  const good = { status: 200, body: { choices: [{ message: { content: '```json\n' + JSON.stringify(cls()) + '\n```' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } };
  const bad = { status: 200, body: { choices: [{ message: { content: 'not json' } }] } };
  let b = new OpenAICompatibleBrain({ base_url: 'http://x/v1', api_key: 'k', classify_model: 'm', fetch: mk([bad, good]), audit: (...a) => audits.push(a) });
  const r = await b.classify({ kind: 'bot_mention', requester: 'U', channel: 'C', text: 'hi' }, { persona: 'p', catalogue: 'c' });
  assert.equal(r.intent, 'task_request'); assert.equal(bodies.length, 2);
  for (const body of bodies) { assert.ok(!('tools' in body) && !('functions' in body) && !('tool_choice' in body)); assert.deepEqual(body.response_format.json_schema, CLASSIFICATION_SCHEMA); }
  assert.equal(audits.at(-1)[3].prompt_tokens, 10);
  n = 0; bodies.length = 0;
  b = new OpenAICompatibleBrain({ base_url: 'http://x/v1', api_key: 'k', classify_model: 'm', retry_delays_ms: [0, 0], fetch: mk([{ status: 502, body: '<html>bad gateway</html>' }, good]) });
  assert.equal((await b.classify({ kind: 'bot_mention', requester: 'U', channel: 'C', text: 'hi' }, { persona: 'p', catalogue: 'c' })).intent, 'task_request');
  assert.equal(bodies.length, 2, '502 retried');
  n = 0; bodies.length = 0;
  b = new OpenAICompatibleBrain({ base_url: 'http://x/v1', api_key: 'k', classify_model: 'm', retry_delays_ms: [0, 0], fetch: mk([{ status: 503, body: 'x' }, { status: 503, body: 'x' }, { status: 503, body: '<p>still down</p>' }, good]) });
  await assert.rejects(() => b.classify({ kind: 'bot_mention', requester: 'U', channel: 'C', text: 'hi' }, { persona: 'p', catalogue: 'c' }), /brain endpoint 503: "still down"|503/);
  assert.equal(bodies.length, 3, 'gives up after the backoff schedule');
  n = 0; bodies.length = 0;
  b = new OpenAICompatibleBrain({ base_url: 'http://x/v1', api_key: 'k', classify_model: 'm', retry_delays_ms: [0, 0], fetch: mk([{ status: 401, body: 'nope' }, good]) });
  await assert.rejects(() => b.classify({ kind: 'bot_mention', requester: 'U', channel: 'C', text: 'hi' }, { persona: 'p', catalogue: 'c' }), BrainError);
  assert.equal(bodies.length, 1, 'no retry on 401');
});

test('owner-voice prompt keeps facts and links, drops narration, caps emoji', async () => {
  const { ownerVoicePrompt } = await import('../src/brain/prompt.mjs');
  const p = ownerVoicePrompt({ ownerName: 'Faraj' });
  for (const k of ['Keep every fact exactly', '<https://x|label>', 'process narration', 'Never more than two', 'never mention Lekam']) assert.ok(p.includes(k), k);
  const bodies = [];
  const b = new OpenAICompatibleBrain({ base_url: 'http://x/v1', api_key: 'k', classify_model: 'm', fetch: async (u, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'Hey Ting, all good :+1:' } }] }) }; } });
  assert.equal(await b.rewriteAsOwner({ report: 'r', request_text: 'q', requesterName: 'Ting', ownerName: 'Faraj' }), 'Hey Ting, all good :+1:');
  assert.ok(!('response_format' in bodies[0]) && !('tools' in bodies[0]));
});
test('watch_reply: user turn carries the waiting session; the prompt explains the kind', () => {
  const u = JSON.parse(userTurn({ kind: 'watch_reply', requester: 'Priya', channel: '#x', text: 'approved', watchedSession: 'PR-42 review', ownerName: 'F' }));
  assert.equal(u.watched_session, 'PR-42 review');
  assert.ok(!('watched_session' in JSON.parse(userTurn({ kind: 'bot_mention', requester: 'U', channel: 'C', text: 'hi', ownerName: 'F' }))));
  assert.ok(systemPrompt({ persona: 'P', catalogue: 'C', ownerName: 'F' }).includes('kind=watch_reply'));
});
