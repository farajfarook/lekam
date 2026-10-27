import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { here } from './helpers.mjs';

const cli = path.join(here, '..', 'src', 'cli.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lekam-watch-cli-'));
const cfg = path.join(dir, 'lekam.yml');
fs.writeFileSync(cfg, `
persona_file: ${path.join(here, '..', 'config', 'persona.md')}
guardrails_file: ${path.join(here, '..', 'config', 'guardrails.md')}
chat: { platform: slack, bot_token_env: LEKAM_TEST_UNSET_BOT, app_token_env: LEKAM_TEST_UNSET_APP }
brain: { base_url_env: LEKAM_TEST_UNSET_URL, api_key_env: LEKAM_TEST_UNSET_KEY, classify_model: m }
store: { path: ./lekam.db }
watches: { ttl: 3d, hosts: { boxa: local, boxb: "ssh://root@boxb.internal" } }
owners:
  - slack_id: UOWNER
    name: Faraj
    executor: { type: fake, cwd: ${dir} }
`);
// No secrets in the environment: watch commands must not need them.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LEKAM_')));
const run = (...a) => {
  try { return { code: 0, out: JSON.parse(execFileSync(process.execPath, ['--no-warnings', cli, ...a, '--config', cfg], { env, encoding: 'utf8' })) }; }
  catch (e) { return { code: e.status, out: JSON.parse(e.stdout) }; }
};

test('watch / renew / list / unwatch without secrets, from the CLI', () => {
  const w = ['watch', '--channel', 'C0TEST00001', '--thread', '1712345678.000100', '--agent', 'agent-1234', '--host', 'boxb', '--title', 'PR-42 review session', '--message-ts', '1712345999.000200'];
  const a = run(...w);
  assert.equal(a.code, 0); assert.equal(a.out.ok, true); assert.equal(a.out.action, 'created');
  assert.equal(run(...w).out.action, 'renewed');
  assert.equal(run('watch', '--channel', 'C0TEST00001', '--thread', '1712345678.000100', '--agent', 'other', '--host', 'boxa', '--renew-only').out.action, 'noop');
  const list = run('watches').out.watches;
  assert.equal(list.length, 1);
  assert.equal(list[0].host, 'boxb');
  assert.equal(list[0].title, 'PR-42 review session');
  assert.equal(run('unwatch', '--channel', 'C0TEST00001', '--thread', '1712345678.000100').out.stopped, 1);
  assert.equal(run('watches').out.watches.length, 0);
});

test('bad input is rejected with a clear error and exit 1', () => {
  let r = run('watch', '--channel', 'C0TEST00001', '--thread', '1712345678.000100', '--agent', 'x', '--host', 'mango');
  assert.equal(r.code, 1); assert.match(r.out.error, /unknown host "mango".*boxa, boxb/);
  r = run('watch', '--channel', '#general', '--thread', '1.2', '--agent', 'x', '--host', 'boxa');
  assert.match(r.out.error, /--channel/);
  r = run('watch', '--channel', 'C0TEST00001', '--thread', 'yesterday', '--agent', 'x', '--host', 'boxa');
  assert.match(r.out.error, /--thread/);
});
