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
test('request body has no tools; usage audited; retry on bad json; endpoint errors not retried', async () => {
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
  b = new OpenAICompatibleBrain({ base_url: 'http://x/v1', api_key: 'k', classify_model: 'm', fetch: mk([{ status: 500, body: 'down' }, good]) });
  await assert.rejects(() => b.classify({ kind: 'bot_mention', requester: 'U', channel: 'C', text: 'hi' }, { persona: 'p', catalogue: 'c' }), BrainError);
  assert.equal(bodies.length, 1, 'no retry on endpoint failure');
});
