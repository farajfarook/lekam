# Tasks: Phase 1 – the front door

## 1. Scaffold
- [x] 1.1 `package.json` (ESM, `bin: lekam`, Node >=22.13, deps `@slack/bolt`, `@getpaseo/client`, `yaml`), `README.md`, `.editorconfig`. Test: `npm test` runs node:test with zero tests.
- [x] 1.2 `config/lekam.example.yml`, `config/persona.md`, `config/guardrails.md`, `config/slack-manifest.yml`, `config/lekam.service`.

## 2. Core
- [x] 2.1 `src/core/config.mjs`: load YAML, apply defaults, resolve `*_env` to values, validate owners/brain/executor, never log secrets. Test: `test/config.test.mjs` (missing env → error naming the var, not the value).
- [x] 2.2 `src/core/state.mjs`: transition table, `transition(from, to)`. Test: `test/state.test.mjs` covers every allowed edge and a sample of illegal ones.
- [x] 2.3 `src/core/catalogue.mjs`: parse SKILL.md frontmatter (name, description, `lekam_outward_actions`), repo table, action list, optional `catalogue.md` override, truncation. Test: `test/catalogue.test.mjs` with fixture skills dir.
- [x] 2.4 `src/core/router.mjs`: pure decision function `(message, request|null, classification, config) -> Decision`. Test: `test/router.test.mjs` for bot/owner mention, threshold, force-card patterns, owner follow-up bypass, approve-once.
- [x] 2.5 `src/core/service.mjs`: wires chat/brain/executor/store, handles decisions, expiry timer, concurrency queue, idle sweep. Test: `test/service.test.mjs` end-to-end with fakes (mention → card → approve → run → result DM → post).

## 3. Store
- [x] 3.1 `src/store/sqlite.mjs`: migrations, requests/sessions/events/audit, `findByThread`, `seen`, `recentOutcomes`, `transition` enforcing state table. Test: `test/store.test.mjs` on a temp file.
- [x] 3.2 `src/store/audit.mjs`: typed audit helper; redaction of known secret env names.

## 4. Brain
- [x] 4.1 `src/brain/schema.mjs`: Classification JSON schema + local validator (no deps).
- [x] 4.2 `src/brain/prompt.mjs`: system prompt assembly (persona + catalogue + outcomes + rules), user-turn JSON. Test: snapshot size under budget, no tool fields.
- [x] 4.3 `src/brain/openai-compatible.mjs`: fetch with timeout, `response_format` json_schema, one retry on invalid JSON, usage→audit. Test: `test/brain.test.mjs` with a stub HTTP server.

## 5. Slack adapter
- [x] 5.1 `src/chat/slack/adapter.mjs`: Bolt Socket Mode app, filters per spec, mention stripping, owner-mention detection, engaged-thread follow-ups, `react/unreact/post/dm/update/fetchThread`, action and view routing. Test: `test/slack-filters.test.mjs` on the pure filter functions.
- [x] 5.2 `src/chat/slack/blocks.mjs` + `src/approvals/cards.mjs`: card builders for both kinds, actioned-card rendering, edit-brief modal, result-release DM. Test: `test/cards.test.mjs` asserts action ids and that request text is quoted verbatim.
- [x] 5.3 `src/approvals/policy.mjs`: ttl per kind, force-card regex compile, rate limits.

## 6. Executor
- [x] 6.1 `src/executor/briefs.mjs`: worker prompt, investigate brief, go brief, handoff brief. Test: delimiters present, outward actions listed exactly.
- [x] 6.2 `src/executor/paseo.mjs`: client connect, `start/startInvestigation/proceed/send/waitForFinish/archive/find`, labels, semaphore, timeouts. Test: `test/executor.test.mjs` with a fake client; one manual smoke test against the local daemon (`lekam check`).

## 7. CLI and ops
- [x] 7.1 `src/cli.mjs`: `lekam run|check|catalogue --config`. `check` verifies env presence, daemon reachability, provider availability, brain endpoint (1-token call), Slack auth test.
- [x] 7.2 systemd unit documented in README; `lekam.example.yml` fully commented.
- [x] 7.3 Smoke test: run with a fake chat adapter (`--chat fake`) that feeds a scripted mention, approve via CLI, confirm a Pi agent starts on the local daemon and the outcome lands in the store.

## 8. Hand-off to owner
- [ ] 8.1 Owner creates the Slack app from the manifest and sets `LEKAM_SLACK_BOT_TOKEN`, `LEKAM_SLACK_APP_TOKEN`.
- [ ] 8.2 Owner approves creating a budget-capped LiteLLM key; set `LEKAM_BRAIN_KEY`.
- [ ] 8.3 First real mention in a test channel; review audit log; tune `brain.threshold`.
