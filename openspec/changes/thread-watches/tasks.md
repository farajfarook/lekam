# Tasks

## 1. Store and config

- [x] 1.1 Migration 3: `watches` and `watch_replies` tables, `busy_timeout`; watch CRUD (register/renew/supersede/renew-only, unwatch, list, active lookup by thread or DM, expire, seen bookkeeping) and reply CRUD (insert-or-ignore, batches) in `src/store/sqlite.mjs` — proven by `test/watches-store.test.mjs`
- [x] 1.2 `watches:` config block (ttl, hosts, paseo_bin, wait_timeout, catch_up_interval) with defaults in `src/core/config.mjs` — proven by `test/config.test.mjs`

## 2. CLI

- [x] 2.1 `lekam watch | unwatch | watches` with lenient config loading (no secrets) and JSON output in `src/cli.mjs` — proven by `test/watch-cli.test.mjs` (spawns the CLI against a temp config and database)

## 3. Routing, brain and cards

- [x] 3.1 `decideWatchReply` in `src/core/router.mjs` — proven by `test/router.test.mjs`
- [x] 3.2 `watch_reply` kind and `watched_session` in `src/brain/prompt.mjs` — proven by `test/brain.test.mjs`
- [x] 3.3 Watch card and action ids in `src/approvals/cards.mjs`; forwarded text in `src/executor/briefs.mjs` — proven by `test/briefs.test.mjs` and `test/watches-service.test.mjs`
- [x] 3.4 Service: watched threads count as engaged; routing precedence; `onWatchReply` (classify, drop acks, card, batch); watch actions (identity, forward, ignore, stop); forward via the watch executor (status, wait, send, renew); expiry and catch-up ticks; no-access DM — in `src/core/service.mjs`, proven by `test/watches-service.test.mjs`

## 4. Executor and adapter

- [x] 4.1 `PaseoCli` (inspect / wait / send, `--host` per configured host) in `src/executor/paseo-cli.mjs` and a fake in `src/executor/fake.mjs` — proven by `test/paseo-cli.test.mjs` (stubbed exec)
- [x] 4.2 `readSince` in `src/chat/slack/adapter.mjs` and `src/chat/fake.mjs` (errors surfaced, owner token fallback) — proven by `test/watches-service.test.mjs` via the fake

## 5. Docs and verification

- [x] 5.1 README section and `config/lekam.example.yml` `watches:` block — reviewed in the diff
- [ ] 5.2 `npm test` green; live smoke test: register a watch for a throwaway session, reply in a test thread, Forward, see the turn in Paseo (local and remote host)
