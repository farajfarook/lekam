import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPeople, tagPeople, peopleForPrompt } from '../src/core/people.mjs';

const roster = { members: [
  { name: 'Faraj Farook', slackId: 'UFARAJ', github: 'farajfarook' },
  { name: 'Adhy Karina', slackId: 'UADHY', github: 'rms-adhy-karina' },
  { name: 'Giorgios Tsamoudakis', slackId: 'UGIORG', github: 'rms-giorg-tsamoudakis' },
  { name: 'Aditya Srivastava', slackId: 'UADI', github: null },
] };
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lekam-')), 'roster.json');
fs.writeFileSync(file, JSON.stringify(roster));
const people = loadPeople({ people_file: file, people: [{ name: 'Jane Doe', slack_id: 'UJANE', aliases: ['Janey'] }] });

test('loads a team-pr-scan roster plus inline people', () => {
  assert.deepEqual(people.map((p) => [p.key, p.slack_id]), [['faraj-farook', 'UFARAJ'], ['adhy-karina', 'UADHY'], ['giorgios-tsamoudakis', 'UGIORG'], ['aditya-srivastava', 'UADI'], ['jane-doe', 'UJANE']]);
  assert.ok(peopleForPrompt(people).includes('{{@adhy-karina}} = Adhy Karina (GitHub rms-adhy-karina)'));
  assert.deepEqual(loadPeople({ people_file: '/nope.json' }), []);
});

test('placeholders, full names, aliases and GitHub logins become mentions; links and code are left alone', () => {
  const t = tagPeople('Owner: {{@adhy-karina}} (`rms-adhy-karina`). Giorgios Tsamoudakis opened it; rms-giorg-tsamoudakis pushed. Janey agreed. See <https://github.com/rms-adhy-karina/x|repo> and `npm test`. {{@nobody-here}} too.', people);
  assert.equal(t, 'Owner: <@UADHY>. <@UGIORG> opened it; <@UGIORG> pushed. <@UJANE> agreed. See <https://github.com/rms-adhy-karina/x|repo> and `npm test`. nobody here too.');
});

test('the owner is named, not tagged; existing mentions are untouched', () => {
  assert.equal(tagPeople('Faraj Farook and <@UADHY> and {{@faraj-farook}}', people, { plain: new Set(['UFARAJ']) }), 'Faraj Farook and <@UADHY> and Faraj Farook');
});
