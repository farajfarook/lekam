import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PaseoCli } from '../src/executor/paseo-cli.mjs';

function stub(outputs = {}) {
  const calls = [];
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    if (args[0] === 'send') { const f = args[args.indexOf('--prompt-file') + 1]; calls.at(-1).prompt = fs.readFileSync(f, 'utf8'); calls.at(-1).file = f; }
    const o = outputs[args[0]];
    if (o instanceof Error) throw o;
    return o ?? '';
  };
  return { calls, run };
}

test('local host adds no --host; remote host adds its target', async () => {
  const s = stub({ inspect: JSON.stringify({ Id: 'a1', Name: 'PR session', Status: 'running', Archived: false }) });
  const p = new PaseoCli({ paseo_bin: '/usr/local/bin/paseo', hosts: { boxa: 'local', boxb: 'ssh://root@boxb.internal' }, run: s.run });
  assert.deepEqual(await p.status({ agent_id: 'a1', host: 'boxa' }), { status: 'running', archived: false, title: 'PR session' });
  assert.deepEqual(s.calls[0], ['/usr/local/bin/paseo', 'inspect', 'a1', '--json']);
  await p.status({ agent_id: 'a1', host: 'boxb' });
  assert.deepEqual(s.calls[1].slice(1), ['inspect', 'a1', '--json', '--host', 'ssh://root@boxb.internal']);
  await p.waitIdle({ agent_id: 'a1', host: 'boxb' }, 90_500);
  assert.deepEqual(s.calls[2].slice(1), ['wait', 'a1', '--timeout', '91', '--host', 'ssh://root@boxb.internal']);
  await assert.rejects(p.status({ agent_id: 'a1', host: 'mango' }), /unknown host "mango"/);
});

test('send passes the text through a temp file (removed after) and does not wait for the turn', async () => {
  const s = stub();
  const p = new PaseoCli({ hosts: { boxa: 'local' }, run: s.run });
  await p.send({ agent_id: 'a1', host: 'boxa' }, 'hello "there"\nline two');
  const c = s.calls[0];
  assert.deepEqual(c.slice(0, 3), ['paseo', 'send', 'a1']);
  assert.ok(c.includes('--no-wait'));
  assert.equal(c.prompt, 'hello "there"\nline two');
  assert.equal(fs.existsSync(c.file), false);
});

test('archived and unexpected output', async () => {
  const p = new PaseoCli({ hosts: { boxa: 'local' }, run: stub({ inspect: JSON.stringify({ Status: 'idle', Archived: true }) }).run });
  assert.equal((await p.status({ agent_id: 'a', host: 'boxa' })).archived, true);
  const q = new PaseoCli({ hosts: { boxa: 'local' }, run: stub({ inspect: 'Error: agent not found' }).run });
  await assert.rejects(q.status({ agent_id: 'a', host: 'boxa' }), /unexpected output/);
});
