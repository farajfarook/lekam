// Build the brain's catalogue: skills (from SKILL.md frontmatter), repos, outward actions.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/** Parse YAML frontmatter from a markdown string. Returns {} when absent or invalid. */
export function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  try { return YAML.parse(m[1]) ?? {}; } catch { return {}; }
}

export function readSkills(dirs, { log = () => {} } = {}) {
  const skills = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) { log('warn', `skills dir not found: ${dir}`); continue; }
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const file = path.join(dir, ent.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      if (!fm.name || !fm.description) continue;
      skills.push({
        name: String(fm.name),
        description: String(fm.description).replace(/\s+/g, ' ').trim(),
        outward_actions: Array.isArray(fm.lekam_outward_actions) ? fm.lekam_outward_actions.map(String) : [],
        hidden: fm.lekam_hidden === true,
      });
    }
  }
  return skills.filter((s) => !s.hidden).sort((a, b) => a.name.localeCompare(b.name));
}

export function renderCatalogue({ skills, repos, outward_actions, override = null, maxChars = 16000, log = () => {} }) {
  const parts = [];
  parts.push('## Outward actions (ids the owner approves per request)');
  const ids = Object.keys(outward_actions);
  parts.push(ids.length ? ids.map((k) => `- ${k}: ${outward_actions[k]}`).join('\n') : '- (none configured)');
  parts.push('\n## Repositories');
  parts.push(repos.length ? repos.map((r) => `- ${r.name} (default branch ${r.default_branch})${r.notes ? ': ' + r.notes : ''}`).join('\n') : '- (none configured)');
  parts.push('\n## Skills (what agents can do; name them in briefs)');
  if (override) parts.push(override.trim());
  else parts.push(skills.length ? skills.map((s) => `- ${s.name}: ${s.description}${s.outward_actions.length ? ` [outward: ${s.outward_actions.join(', ')}]` : ''}`).join('\n') : '- (none found)');
  let text = parts.join('\n');
  if (text.length > maxChars) { log('warn', `catalogue truncated from ${text.length} to ${maxChars} chars`); text = text.slice(0, maxChars) + '\n…(truncated)'; }
  return text;
}

export function buildCatalogue(config, { log } = {}) {
  const skills = readSkills(config.skills_dirs, { log });
  const text = renderCatalogue({ skills, repos: config.repos, outward_actions: config.outward_actions, override: config.catalogue_override, maxChars: config.brain.catalogue_max_chars, log });
  return { skills, text, skillByName: new Map(skills.map((s) => [s.name, s])) };
}
