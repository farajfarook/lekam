// Manual smoke test against a live local Paseo daemon (not run by `npm test`):
//   LEKAM_TEST_KEY=x node --no-warnings test/smoke.paseo.mjs
import { testConfig, OWNER, REQ, CHAN, cls } from './helpers.mjs';
import { Store } from '../src/store/sqlite.mjs';
import { Service } from '../src/core/service.mjs';
import { FakeChat } from '../src/chat/fake.mjs';
import { FakeBrain } from '../src/brain/fake.mjs';
import { PaseoExecutor } from '../src/executor/paseo.mjs';
import { ACTIONS } from '../src/approvals/cards.mjs';

const config = testConfig({ owners: [{ slack_id: OWNER, name: 'Faraj', default_for_channels: [CHAN], executor: { type: 'paseo', paseo_url: 'ws://127.0.0.1:6767/ws', provider: 'pi/litellm/claude-haiku-5-5', cwd: '/root/work', max_concurrent: 1, run_timeout: '5m' } }] });
const log = (l, m) => console.log(l, m);
const exec = new PaseoExecutor({ ...config.owners[0].executor, config, log });
console.log('check:', await exec.check());
const store = new Store(':memory:');
const chat = new FakeChat({ ownerIds: config.ownerIds });
const brain = new FakeBrain(() => cls({ brief: { summary: 'Reply with exactly the text SMOKE-OK and the current working directory, then stop.', skill: null, repo: null, outward_actions: [], notes: 'smoke test' } }));
const svc = new Service({ config, store, chat, brain, executors: new Map([[OWNER, exec]]), log });
await svc.start();
const m = await chat.inject({ kind: 'bot_mention', channel: CHAN, user: REQ, text: 'smoke test please' });
const req = store.findByThread(CHAN, m.thread_ts);
console.log('state after mention:', req.state, 'reactions:', chat.reactionsOn(CHAN, m.ts));
const t0 = Date.now();
await chat.click(ACTIONS.APPROVE_TASK, req.id, OWNER, chat.dms[0]);
await new Promise((r) => setTimeout(r, 200));
let r; for (let i = 0; i < 600; i++) { r = store.getRequest(req.id); if (['DONE', 'FAILED'].includes(r.state)) break; await new Promise((x) => setTimeout(x, 500)); }
console.log('final state:', r.state, 'in', ((Date.now() - t0) / 1000).toFixed(1), 's; session', r.session_id);
console.log('outcome:', JSON.stringify(r.outcome?.text?.slice(0, 300)));
console.log('reactions:', chat.reactionsOn(CHAN, m.ts));
console.log('last DM has post button:', JSON.stringify(chat.lastDm().blocks ?? '').includes(ACTIONS.POST_RESULT));
console.log('found by labels:', await exec.find({ channel: CHAN, thread_ts: m.thread_ts }));
console.log('audit:', store.auditFor(req.id).map((a) => a.type).join(' > '));
await exec.archive(r); await svc.stop(); process.exit(0);
