import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig, parseDuration, ConfigError, ownerForChannel } from '../src/core/config.mjs';
import { here, testConfig } from './helpers.mjs';

test('durations', () => {
  assert.equal(parseDuration('30s'), 30000); assert.equal(parseDuration('45m'), 2700000); assert.equal(parseDuration('4h'), 14400000); assert.equal(parseDuration('7d'), 604800000); assert.equal(parseDuration(5), 5);
  assert.throws(() => parseDuration('soon'), ConfigError);
});
test('defaults and derived fields', () => {
  const c = testConfig();
  assert.equal(c.brain.threshold, 0.7); assert.equal(c.brain.brief_model, 'm'); assert.equal(c.approvals.ttl_owner_mention_ms, 4 * 36e5);
  assert.ok(c.approvals.force_card_regexes.some((r) => r.test('raise the PR')));
  assert.equal(c.owners[0].executor.run_timeout_ms, 45 * 60e3);
  assert.ok(c.persona.includes('Lead with the answer')); assert.ok(c.guardrails.includes('outward'));
  assert.equal(c.brain.base_url, 'http://brain.test/v1');
  assert.ok(c.secretValues.every((s) => s.includes('-value-')));
});
test('missing env var names the variable, never a value', () => {
  assert.throws(() => resolveConfig({ chat: { platform: 'fake' }, brain: { base_url: 'x', classify_model: 'm' }, persona_file: '../config/persona.md', guardrails_file: '../config/guardrails.md', owners: [{ slack_id: 'U', executor: { type: 'fake', cwd: '/x' } }] }, { baseDir: here, envLookup: (n) => { throw new ConfigError(`environment variable ${n} is not set`); } }), /LEKAM_BRAIN_KEY is not set/);
});
test('validation errors', () => {
  assert.throws(() => testConfig({ owners: [] }), /at least one owner/);
  assert.throws(() => testConfig({ owners: [{ slack_id: 'U', executor: { type: 'fake' } }] }), /cwd is required/);
  assert.throws(() => testConfig({ brain: { base_url: 'x', classify_model: 'm', threshold: 2 } }), /threshold/);
});
test('owner routing by channel', () => {
  const c = testConfig({ owners: [{ slack_id: 'U1', executor: { type: 'fake', cwd: '/a' } }, { slack_id: 'U2', default_for_channels: ['C9'], executor: { type: 'fake', cwd: '/b' } }] });
  assert.equal(ownerForChannel(c, 'C9').slack_id, 'U2'); assert.equal(ownerForChannel(c, 'C1').slack_id, 'U1');
});
