// People directory: who can be @-tagged in posts. Read from `people_file` (a team-pr-scan style roster:
// { members: [{ name, slackId, github }] }, or a plain list of { name, slack_id, github, aliases }) and/or `people:`.
import fs from 'node:fs';

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function normalise(p) {
  const slack_id = p.slack_id ?? p.slackId ?? null;
  if (!p?.name || !slack_id) return null;
  return { key: slug(p.name), name: String(p.name), slack_id, github: p.github ? String(p.github) : null, aliases: (p.aliases ?? []).map(String) };
}

/** Read the directory fresh each call (the file is small and edited by hand). Never throws. */
export function loadPeople(config, { log = () => {} } = {}) {
  const list = [];
  if (config.people_file) {
    try {
      const raw = JSON.parse(fs.readFileSync(config.people_file, 'utf8'));
      list.push(...(Array.isArray(raw) ? raw : raw.members ?? []));
    } catch (e) { log('warn', `people_file unreadable: ${e.message}`); }
  }
  list.push(...(config.people ?? []));
  const seen = new Set();
  return list.map(normalise).filter((p) => p && !seen.has(p.slack_id) && seen.add(p.slack_id));
}

/** One line per person for the owner-voice prompt. */
export function peopleForPrompt(people) {
  return people.map((p) => `- {{@${p.key}}} = ${p.name}${p.github ? ` (GitHub ${p.github})` : ''}${p.aliases.length ? ` (also ${p.aliases.join(', ')})` : ''}`).join('\n');
}

/**
 * Pure: turn people references into Slack mentions.
 * - {{@key}} placeholders (from the owner-voice rewrite); unknown keys become plain text
 * - exact full names, aliases and GitHub logins (also `backticked`), outside links and code spans
 * People in `plain` (e.g. the owner posting as themselves) get their name instead of a mention.
 */
export function tagPeople(text, people, { plain = new Set() } = {}) {
  if (!text || !people.length) return String(text ?? '').replace(/\{\{@([a-z0-9-]+)\}\}/g, (_, k) => k.replace(/-/g, ' '));
  const byKey = new Map(people.map((p) => [p.key, p]));
  const ref = (p) => (plain.has(p.slack_id) ? p.name : `<@${p.slack_id}>`);
  const byLogin = new Map(people.filter((p) => p.github).map((p) => [p.github.toLowerCase(), p]));
  const names = people.flatMap((p) => [p.name, ...p.aliases].map((n) => [n, p])).sort((a, b) => b[0].length - a[0].length);
  const nameRe = names.length ? new RegExp(`(?<![\\w@])(${names.map(([n]) => esc(n)).join('|')})(?![\\w])`, 'g') : null;
  const nameMap = new Map(names.map(([n, p]) => [n, p]));
  const loginRe = byLogin.size ? new RegExp(`(?<![\\w/.@-])(${[...byLogin.keys()].map(esc).join('|')})(?![\\w/-])`, 'gi') : null;

  const out = String(text).split(/(<[^>\n]+>|`[^`\n]+`)/).map((seg) => {
    if (seg.startsWith('<')) return seg; // links and existing mentions stay as they are
    if (seg.startsWith('`')) { const p = byLogin.get(seg.slice(1, -1).toLowerCase()); return p ? ref(p) : seg; }
    let s = seg.replace(/\{\{@([a-z0-9-]+)\}\}/g, (_, k) => (byKey.has(k) ? ref(byKey.get(k)) : k.replace(/-/g, ' ')));
    // Names and logins only in the parts that are not already mentions.
    s = s.split(/(<@[A-Z0-9]+>)/).map((t) => {
      if (t.startsWith('<@')) return t;
      if (nameRe) t = t.replace(nameRe, (m) => ref(nameMap.get(m)));
      if (loginRe) t = t.replace(loginRe, (m) => ref(byLogin.get(m.toLowerCase())));
      return t;
    }).join('');
    return s;
  }).join('');
  // "Adhy Karina (`rms-adhy-karina`)" -> one mention, not two.
  return out.replace(/(<@([A-Z0-9]+)>)\s*\(\s*<@\2>\s*\)/g, '$1').replace(/(<@([A-Z0-9]+)>)[ \t]+<@\2>/g, '$1');
}
