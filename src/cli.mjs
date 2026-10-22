#!/usr/bin/env node
// lekam run | check | catalogue | audit  [--config lekam.yml]
import process from 'node:process';
import { loadConfig, ConfigError } from './core/config.mjs';
import { buildCatalogue } from './core/catalogue.mjs';
import { Store } from './store/sqlite.mjs';
import { Service } from './core/service.mjs';
import { OpenAICompatibleBrain } from './brain/openai-compatible.mjs';
import { PaseoExecutor } from './executor/paseo.mjs';

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('-')) ?? 'run';
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const configPath = opt('config', process.env.LEKAM_CONFIG ?? './lekam.yml');

const log = (level, msg) => { const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`; (level === 'error' ? console.error : console.log)(line); };

function mask(v) { return v ? `set (${v.length} chars)` : 'MISSING'; }

async function buildExecutors(config) {
  const m = new Map();
  for (const o of config.owners) {
    if (o.executor.type === 'paseo') m.set(o.slack_id, new PaseoExecutor({ ...o.executor, config, log }));
    else { const { FakeExecutor } = await import('./executor/fake.mjs'); m.set(o.slack_id, new FakeExecutor()); }
  }
  return m;
}

async function buildChat(config) {
  if (config.chat.platform === 'slack') { const { SlackAdapter } = await import('./chat/slack/adapter.mjs'); return new SlackAdapter({ bot_token: config.chat.bot_token, app_token: config.chat.app_token, ownerIds: config.ownerIds, userTokens: new Map(config.owners.filter((o) => o.user_token).map((o) => [o.slack_id, o.user_token])), log }); }
  const { FakeChat } = await import('./chat/fake.mjs'); return new FakeChat({ ownerIds: config.ownerIds, log });
}

async function main() {
  if (cmd === 'help' || args.includes('--help')) {
    console.log(`lekam <run|check|catalogue|audit> [--config lekam.yml] [--tail N]`); return;
  }
  const config = loadConfig(configPath);
  const store = new Store(config.store.path, { redact: config.secretValues });

  if (cmd === 'catalogue') { console.log(buildCatalogue(config, { log }).text); return; }
  if (cmd === 'audit') { for (const r of store.auditTail(Number(opt('tail', 50)))) console.log(new Date(r.ts).toISOString(), r.type, r.request_id ?? '-', r.actor ?? '-', JSON.stringify(r.data)); return; }

  if (cmd === 'check') {
    let ok = true;
    const row = (k, v, good = true) => { console.log(`${good ? 'ok  ' : 'FAIL'} ${k.padEnd(28)} ${v}`); if (!good) ok = false; };
    row('config', configPath);
    if (config.chat.platform === 'slack') { row('slack bot token', mask(config.chat.bot_token), !!config.chat.bot_token); row('slack app token', mask(config.chat.app_token), !!config.chat.app_token); }
    row('brain endpoint', config.brain.base_url); row('brain key', mask(config.brain.api_key), !!config.brain.api_key);
    const cat = buildCatalogue(config, { log }); row('catalogue', `${cat.skills.length} skills, ${config.repos.length} repos, ${Object.keys(config.outward_actions).length} actions, ${cat.text.length} chars`);
    try {
      const brain = new OpenAICompatibleBrain({ ...config.brain, log });
      const r = await brain.classify({ kind: 'bot_mention', requester: 'U1', channel: 'C1', text: 'ping', thread: [] }, { persona: config.persona, catalogue: cat.text, outcomes: [], ownerName: config.owners[0].name });
      row(`brain ${config.brain.classify_model}`, `intent=${r.intent} confidence=${r.confidence}`);
    } catch (e) { row(`brain ${config.brain.classify_model}`, e.message, false); }
    for (const o of config.owners) {
      if (o.executor.type !== 'paseo') { row(`executor ${o.name}`, o.executor.type); continue; }
      const ex = new PaseoExecutor({ ...o.executor, config, log });
      try { const r = await ex.check(); row(`paseo ${o.name}`, `${r.url} provider=${r.provider} cwd=${o.executor.cwd}`); } catch (e) { row(`paseo ${o.name}`, e.message, false); } finally { await ex.close(); }
    }
    if (config.chat.platform === 'slack') {
      const { WebClient } = await import('@slack/web-api');
      try { const a = await new WebClient(config.chat.bot_token).auth.test(); row('slack auth', `${a.user} in ${a.team}`); } catch (e) { row('slack auth', e.message, false); }
      for (const o of config.owners) {
        if (!o.user_token_env) continue;
        if (!o.user_token) { row(`slack user token ${o.name}`, `${o.user_token_env} not set: replies post as Lekam`); continue; }
        try { const a = await new WebClient(o.user_token).auth.test(); row(`slack user token ${o.name}`, `posts as ${a.user}`, a.user_id === o.slack_id); } catch (e) { row(`slack user token ${o.name}`, e.message, false); }
      }
    }
    process.exit(ok ? 0 : 1);
  }

  if (cmd === 'run') {
    const chat = await buildChat(config);
    const brain = new OpenAICompatibleBrain({ ...config.brain, audit: (t, id, actor, d) => store.audit(t, id, actor, d), log });
    const executors = await buildExecutors(config);
    const svc = new Service({ config, store, chat, brain, executors, log });
    await svc.start();
    const stop = async () => { log('info', 'stopping'); await svc.stop(); store.close(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return;
  }
  console.error(`unknown command ${cmd}`); process.exit(2);
}

main().catch((e) => { if (e instanceof ConfigError) { console.error(`config: ${e.message}`); process.exit(2); } console.error(e.stack ?? e); process.exit(1); });
