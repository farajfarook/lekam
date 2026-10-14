import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/sqlite.mjs';
import { IllegalTransition } from '../src/core/state.mjs';

const mk = () => new Store(':memory:', { redact: ['sk-verysecretkey'] });
const req = (s, o = {}) => s.createRequest({ kind: 'bot_mention', channel: 'C', thread_ts: '1', origin_ts: '1', requester: 'U', owner: 'O', request_text: 'x', ...o });

test('transitions enforced and audited', () => {
  const s = mk(); const r = req(s);
  s.transition(r.id, 'PENDING_APPROVAL');
  assert.throws(() => s.transition(r.id, 'DONE'), IllegalTransition);
  assert.ok(s.auditFor(r.id).some((a) => a.type === 'illegal_transition'));
});
test('findByThread prefers live request', () => {
  const s = mk(); const a = req(s); s.transition(a.id, 'PENDING_APPROVAL'); s.transition(a.id, 'DENIED');
  const b = req(s); s.transition(b.id, 'PENDING_APPROVAL');
  assert.equal(s.findByThread('C', '1').id, b.id);
  s.transition(b.id, 'EXPIRED');
  assert.ok(['DENIED', 'EXPIRED'].includes(s.findByThread('C', '1').state));
  assert.equal(s.findByThread('C', 'nope'), null);
});
test('dedupe, rate, outcomes, sessions, redaction, card lookup', () => {
  const s = mk();
  assert.equal(s.seen('e'), false); assert.equal(s.seen('e'), true); assert.equal(s.seen('e', { now: Date.now() + 25 * 36e5 }), false);
  assert.equal(s.rateHit('U'), 1); assert.equal(s.rateHit('U'), 2);
  const r = req(s); s.transition(r.id, 'PENDING_APPROVAL'); s.transition(r.id, 'APPROVED'); s.transition(r.id, 'RUNNING');
  s.setSession(r.id, 'agent9'); assert.equal(s.getSession(r.id).status, 'running');
  s.updateRequest(r.id, { outcome: { summary: 'ok' }, brief: { summary: 'do' }, card: { channel: 'D', ts: '9' } }); s.transition(r.id, 'DONE'); s.finishSession(r.id);
  assert.equal(s.recentOutcomes(5).length, 1); assert.ok(s.recentOutcomes(5)[0].includes('do -> ok'));
  assert.equal(s.findByCard('D', '9').id, r.id);
  s.audit('t', r.id, null, { k: 'sk-verysecretkey' }); assert.equal(s.auditTail(1)[0].data.k, '[redacted]');
  assert.equal(s.countPendingForOwner('O'), 0);
});
