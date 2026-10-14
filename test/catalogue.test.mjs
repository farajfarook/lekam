import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseFrontmatter, readSkills, renderCatalogue, buildCatalogue } from '../src/core/catalogue.mjs';
import { here, testConfig } from './helpers.mjs';

test('frontmatter parsing', () => {
  assert.deepEqual(parseFrontmatter('---\nname: a\ndescription: b\n---\nbody'), { name: 'a', description: 'b' });
  assert.deepEqual(parseFrontmatter('no frontmatter'), {});
  assert.deepEqual(parseFrontmatter('---\n: bad: [\n---\n'), {});
});
test('reads skills with outward actions, sorted', () => {
  const s = readSkills([path.join(here, 'fixtures/skills'), '/nonexistent']);
  assert.deepEqual(s.map((x) => x.name), ['noop', 'support-case']);
  assert.deepEqual(s[1].outward_actions, ['jira_comment', 'pr_create']);
  assert.ok(s[1].description.includes('Datadog'));
});
test('rendered catalogue and override', () => {
  const c = testConfig();
  const cat = buildCatalogue(c);
  assert.ok(cat.text.includes('- support-case:') && cat.text.includes('[outward: jira_comment, pr_create]'));
  assert.ok(cat.text.includes('- owner-portal (default branch test)'));
  assert.ok(cat.text.includes('- jira_comment: Comment on Jira'));
  const t = renderCatalogue({ skills: cat.skills, repos: [], outward_actions: {}, override: 'CUSTOM' });
  assert.ok(t.includes('CUSTOM') && !t.includes('support-case'));
  const warns = [];
  const small = renderCatalogue({ skills: cat.skills, repos: [], outward_actions: {}, maxChars: 50, log: (l, m) => warns.push(m) });
  assert.ok(small.endsWith('…(truncated)') && warns.length === 1);
});
