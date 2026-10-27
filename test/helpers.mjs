import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../src/core/config.mjs';
import { Store } from '../src/store/sqlite.mjs';
import { Service } from '../src/core/service.mjs';
import { FakeChat } from '../src/chat/fake.mjs';
import { FakeBrain } from '../src/brain/fake.mjs';
import { FakeExecutor, FakeWatchExec } from '../src/executor/fake.mjs';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const OWNER = 'UOWNER', REQ = 'UREQ', CHAN = 'CTEAM';

export function testConfig(over = {}) {
  const raw = {
    chat: { platform: 'fake' },
    brain: { base_url: 'http://brain.test', classify_model: 'm', api_key_env: 'LEKAM_TEST_KEY' },
    persona_file: '../config/persona.md', guardrails_file: '../config/guardrails.md',
    outward_actions: { jira_comment: 'Comment on Jira', pr_create: 'Raise a PR' },
    repos: [{ name: 'owner-portal', default_branch: 'test' }],
    skills_dirs: ['./fixtures/skills'],
    owners: [{ slack_id: OWNER, name: 'Faraj', default_for_channels: [CHAN], executor: { type: 'fake', cwd: '/tmp/work' } }],
    ...over,
  };
  return resolveConfig(raw, { baseDir: here, envLookup: (n) => `${n}-value-xxxxxxxx` });
}

export const cls = (o = {}) => ({ intent: 'task_request', addressed_to_owner: true, actionable: true, confidence: 0.9, urgent: false, reply_to_user: 'On it once Faraj says yes.', brief: { summary: 'Fix the blank PDF export', skill: 'support-case', repo: 'owner-portal', outward_actions: ['jira_comment', 'pr_create'], notes: '' }, followup: null, clarifying_question: null, ...o });

export async function harness({ brainScript = () => cls(), execScript = {}, config = testConfig(), watchAgents = {} } = {}) {
  const store = new Store(':memory:', { redact: config.secretValues });
  const chat = new FakeChat({ ownerIds: config.ownerIds });
  const brain = new FakeBrain(brainScript);
  const exec = new FakeExecutor({ script: execScript });
  const watchExec = new FakeWatchExec({ agents: watchAgents, hosts: { local: 'local', boxb: 'ssh://root@boxb.internal' } });
  const svc = new Service({ config, store, chat, brain, executors: new Map([[OWNER, exec]]), watchExec, log: () => {} });
  await svc.start();
  return { store, chat, brain, exec, watchExec, svc, config };
}
