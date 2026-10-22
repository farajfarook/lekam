// Load and validate lekam.yml. Secrets are resolved from env vars named by *_env keys
// and are never logged. Durations like "4h", "45m", "30s" become milliseconds.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

export class ConfigError extends Error {}

export function parseDuration(v, name = 'duration') {
  if (typeof v === 'number') return v;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(String(v).trim());
  if (!m) throw new ConfigError(`${name}: invalid duration "${v}" (use e.g. 30s, 45m, 4h, 7d)`);
  const n = Number(m[1]);
  return { ms: n, s: n * 1e3, m: n * 6e4, h: n * 36e5, d: n * 864e5 }[m[2]];
}

export function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function env(name, { required = true } = {}) {
  const v = process.env[name];
  if ((v === undefined || v === '') && required) throw new ConfigError(`environment variable ${name} is not set`);
  return v;
}

const DEFAULTS = {
  chat: { platform: 'slack', thread_engagement: '24h', owner_post_footer: true, reactions: { pending: 'eyes', running: 'gear', done: 'white_check_mark', declined: 'no_entry_sign', failed: 'x', needs_info: 'question' } },
  brain: { threshold: 0.7, thread_context_messages: 20, recent_outcomes: 10, catalogue_max_chars: 16000, timeout_ms: 30000, max_tokens: 2500 },
  approvals: { ttl_bot_mention: '24h', ttl_owner_mention: '4h', outward_actions_mode: 'ask', force_card_patterns: ['\\bPR\\b', '\\bdeploy', '\\bmerge\\b', '\\bprod\\b', '\\bjira\\b', '\\bemail\\b', '\\bdelete\\b'] },
  limits: { per_user_per_hour: 10, pending_per_owner: 20 },
  store: { path: './lekam.db' },
  outward_actions: {},
  repos: [],
  skills_dirs: [],
  agent_tools: [],
};

const EXEC_DEFAULTS = { type: 'paseo', paseo_url: 'ws://127.0.0.1:6767/ws', provider: null, max_concurrent: 2, run_timeout: '45m', idle_archive_days: 7, workspace_label: 'Lekam', workspace_label_color: 'amber' };

function readText(file, baseDir, what) {
  if (!file) return '';
  const p = path.resolve(baseDir, expandHome(file));
  if (!fs.existsSync(p)) throw new ConfigError(`${what}: file not found: ${p}`);
  return fs.readFileSync(p, 'utf8');
}

/** Load config from a YAML file path. Returns a fully resolved, validated object. */
export function loadConfig(file, { envLookup = env } = {}) {
  const abs = path.resolve(expandHome(file));
  if (!fs.existsSync(abs)) throw new ConfigError(`config file not found: ${abs}`);
  const raw = YAML.parse(fs.readFileSync(abs, 'utf8')) ?? {};
  return resolveConfig(raw, { baseDir: path.dirname(abs), envLookup });
}

/** Resolve a parsed config object (exported for tests). */
export function resolveConfig(raw, { baseDir = process.cwd(), envLookup = env } = {}) {
  const c = structuredClone(DEFAULTS);
  for (const k of ['chat', 'brain', 'approvals', 'limits', 'store']) Object.assign(c[k], raw[k] ?? {});
  c.chat.reactions = { ...DEFAULTS.chat.reactions, ...(raw.chat?.reactions ?? {}) };
  c.outward_actions = { ...(raw.outward_actions ?? {}) };
  c.repos = (raw.repos ?? []).map((r) => {
    if (!r?.name) throw new ConfigError('repos[]: each repo needs a name');
    return { name: r.name, url: r.url ?? null, default_branch: r.default_branch ?? 'main', notes: r.notes ?? '' };
  });
  c.agent_tools = (raw.agent_tools ?? []).map(String);
  c.people_file = raw.people_file ? path.resolve(baseDir, expandHome(raw.people_file)) : null;
  c.people = Array.isArray(raw.people) ? raw.people : [];
  c.skills_dirs = (raw.skills_dirs ?? []).map((d) => path.resolve(baseDir, expandHome(d)));

  c.chat.thread_engagement_ms = parseDuration(c.chat.thread_engagement, 'chat.thread_engagement');

  // Secrets
  if (c.chat.platform !== 'slack' && c.chat.platform !== 'fake') throw new ConfigError(`chat.platform: unsupported "${c.chat.platform}"`);
  if (c.chat.platform === 'slack') {
    c.chat.bot_token = envLookup(c.chat.bot_token_env ?? 'LEKAM_SLACK_BOT_TOKEN');
    c.chat.app_token = envLookup(c.chat.app_token_env ?? 'LEKAM_SLACK_APP_TOKEN');
  }
  c.brain.base_url = (c.brain.base_url ?? envLookup(c.brain.base_url_env ?? 'LEKAM_BRAIN_URL')).replace(/\/+$/, '');
  if (!/\/v1$/.test(c.brain.base_url)) c.brain.base_url += '/v1';
  c.brain.api_key = envLookup(c.brain.api_key_env ?? 'LEKAM_BRAIN_KEY');
  if (!c.brain.classify_model) throw new ConfigError('brain.classify_model is required');
  c.brain.brief_model ??= c.brain.classify_model;
  if (!(c.brain.threshold >= 0 && c.brain.threshold <= 1)) throw new ConfigError('brain.threshold must be between 0 and 1');

  // Durations
  c.approvals.ttl_bot_mention_ms = parseDuration(c.approvals.ttl_bot_mention, 'approvals.ttl_bot_mention');
  c.approvals.ttl_owner_mention_ms = parseDuration(c.approvals.ttl_owner_mention, 'approvals.ttl_owner_mention');
  if (!['ask', 'proposed', 'all'].includes(c.approvals.outward_actions_mode)) throw new ConfigError('approvals.outward_actions_mode must be ask, proposed or all');
  c.approvals.force_card_regexes = (c.approvals.force_card_patterns ?? []).map((p) => new RegExp(p, 'i'));

  // Files
  c.persona = readText(raw.persona_file ?? './persona.md', baseDir, 'persona_file');
  c.guardrails = readText(raw.guardrails_file ?? './guardrails.md', baseDir, 'guardrails_file');
  c.catalogue_override = raw.catalogue_file ? readText(raw.catalogue_file, baseDir, 'catalogue_file') : null;
  c.store.path = path.resolve(baseDir, expandHome(c.store.path));

  // Owners
  if (!Array.isArray(raw.owners) || raw.owners.length === 0) throw new ConfigError('owners: at least one owner is required');
  c.owners = raw.owners.map((o, i) => {
    if (!o?.slack_id) throw new ConfigError(`owners[${i}].slack_id is required`);
    const ex = { ...EXEC_DEFAULTS, ...(o.executor ?? {}) };
    if (!['paseo', 'fake'].includes(ex.type)) throw new ConfigError(`owners[${i}].executor.type: unsupported "${ex.type}"`);
    if (!ex.cwd) throw new ConfigError(`owners[${i}].executor.cwd is required`);
    if (ex.type === 'paseo' && !(typeof ex.provider === 'string' && ex.provider.includes('/'))) throw new ConfigError(`owners[${i}].executor.provider must be "provider/model" (e.g. pi/litellm/claude-haiku-5-5)`);
    ex.cwd = expandHome(ex.cwd);
    ex.run_timeout_ms = parseDuration(ex.run_timeout, `owners[${i}].executor.run_timeout`);
    // Optional Slack user token (xoxp, user scope chat:write): owner-approved replies to owner-tags post as the owner.
    const user_token = o.user_token_env ? envLookup(o.user_token_env, { required: false }) || null : null;
    const voice = o.voice_file ? readText(o.voice_file, baseDir, `owners[${i}].voice_file`) : (o.voice ?? null);
    return { slack_id: o.slack_id, name: o.name ?? o.slack_id, default_for_channels: o.default_for_channels ?? [], user_token_env: o.user_token_env ?? null, user_token, voice, executor: ex };
  });
  c.ownerIds = new Set(c.owners.map((o) => o.slack_id));
  c.secretValues = [c.chat.bot_token, c.chat.app_token, c.brain.api_key, ...c.owners.map((o) => o.user_token)].filter(Boolean);
  return c;
}

/** Pick the owner for a bot-mention in a channel: channel default, else first owner. */
export function ownerForChannel(config, channel) {
  return config.owners.find((o) => o.default_for_channels.includes(channel)) ?? config.owners[0];
}

export function ownerById(config, id) {
  return config.owners.find((o) => o.slack_id === id) ?? null;
}
