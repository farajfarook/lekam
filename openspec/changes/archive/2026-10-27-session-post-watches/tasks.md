# Tasks

## 1. Dependencies and daemon connections

- [x] 1.1 Bump `@getpaseo/client` to ^0.13 in `package.json`; run `npm test` and `node test/smoke.paseo.mjs` against the local daemon to confirm the executor's facade calls still work — proven by the existing suite plus `test/paseo-labels.test.mjs`
- [x] 1.2 `src/executor/daemons.mjs`: per-host connections (`local`, `ws(s)://`, `ssh://` via `createSshTunnel` + `parseSshTransportUri`), lazy connect/reconnect, `listRecentAgents`, `timeline`, `status`, `waitIdle`, `send`, `close` — proven by `test/daemons.test.mjs` with an injected client factory (no network)
- [x] 1.3 Delete `src/executor/paseo-cli.mjs` and `test/paseo-cli.test.mjs`; replace `FakeWatchExec` with `FakeDaemons` (agents + timelines fixtures) in `src/executor/fake.mjs`; service forward/status/wait use `daemons` — proven by `test/watches-service.test.mjs` still green
- [x] 1.4 `src/core/config.mjs`: validate `watches.hosts` values (`local`/`ws`/`wss`/`ssh`), add `watches.detect` with defaults and duration parsing — proven by `test/config.test.mjs`

## 2. Hearing owner posts

- [x] 2.1 `src/chat/slack/adapter.mjs` `classifyEvent`: emit `kind: 'owner_post'` with `hints` for owner-authored messages in channels and captured DMs (after bot-mention and self-tag checks; echoes still dropped); `src/chat/fake.mjs` passes them through — proven by `test/slack-filters.test.mjs`
- [x] 2.2 `src/core/service.mjs` `onMessage`: route `owner_post` → watch bookkeeping (replaces the `via_app` branch) → detection; keep `owner_untagged_ignored` behaviour for request threads — proven by `test/watches-service.test.mjs`

## 3. Matching and registration

- [x] 3.1 `src/core/post-match.mjs`: pure `matchPost(entries, post, { sendTools })` (exact ts in output incl. nested calls; text fallback with conversation and time checks) and `expectsReply(rawText, ownerIds)` — proven by `test/post-match.test.mjs` using real timeline fixtures captured from a daemon (direct call and codemode-nested call)
- [x] 3.2 Service detection: schedule at `detect.delays`, pre-check recent agents per host, fetch timelines, match, skip labels, register/renew via `store.registerWatch`, audits (`session_post_matched`, `session_post_unmatched` only with hints, `daemon_unreachable`) — proven by `test/session-post.test.mjs` (fake daemons with fixtures; fake timers for delays)
- [x] 3.3 `lekam check`: one row per configured host (reachable, agent count); `lekam watches` shows `source` (`detected`/`cli`) — proven by `test/watch-cli.test.mjs` and a manual `lekam check`

## 4. Docs and verification

- [x] 4.1 README watches section rewritten (no hook; what Lekam needs: channel membership, `capture_dms` for DMs, daemon targets); `config/lekam.example.yml` `watches.detect` and host targets — reviewed in the diff
- [x] 4.2 Live smoke: a throwaway session on each host posts a tagged message in a test thread; `lekam watches` shows a detected watch within ~20 s; a reply cards; Forward lands in the session (local and SSH) — recorded in this change's tasks notes

## Workflow follow-up

- Archive this change after 4.2; `openspec/specs/thread-watches` and `session-post-detection` become the main specs.
