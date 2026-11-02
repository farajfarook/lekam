#!/usr/bin/env node
// Entry point. Configuration is environment only (see README).
import os from 'node:os';
import path from 'node:path';
import { Slack } from './slack.mjs';
import { Sessions, parseHosts } from './paseo.mjs';
import { capacityPicker } from './capacity.mjs';
import { Lekam } from './lekam.mjs';

const log = (level, msg) => console.log(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`);
const env = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') { log('error', `${name} is not set`); process.exit(1); }
  return v;
};

const slack = new Slack({ botToken: env('LEKAM_SLACK_BOT_TOKEN'), appToken: env('LEKAM_SLACK_APP_TOKEN'), owner: env('LEKAM_OWNER'), log });
const hosts = parseHosts(env('LEKAM_HOSTS', `${os.hostname()}=ws://127.0.0.1:6767/ws`));
const sessions = new Sessions({
  hosts,
  provider: env('LEKAM_PROVIDER', 'pi/litellm/claude-sonnet-5-5'),
  cwd: env('LEKAM_CWD', path.join(os.homedir(), 'work')),
  pickHost: capacityPicker(process.env.LEKAM_CAPACITY_SCRIPT ?? path.join(os.homedir(), '.agents/skills/host-dispatch/scripts/capacity.mjs'), hosts.map((h) => h.name)),
  log,
});
const lekam = new Lekam({ slack, sessions, timeoutMs: Number(env('LEKAM_TURN_TIMEOUT_MIN', '120')) * 60e3, log });

for (const h of hosts) await sessions.conn(h.name).then(() => log('info', `paseo ${h.name}: connected (${h.target})`), (e) => log('warn', `paseo ${h.name}: ${e.message} (retried on use)`));
await slack.start((m) => lekam.onDm(m));
lekam.ownerName = await slack.ownerName();
log('info', `lekam ready: DMs from ${lekam.ownerName} go to ${sessions.provider} sessions on ${hosts.map((h) => h.name).join(', ')}`);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await slack.stop().catch(() => {}); await sessions.close(); process.exit(0); });
