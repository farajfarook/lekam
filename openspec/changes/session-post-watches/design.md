# Design

## Context

Thread watches work, but registration depends on a pi extension on every session host (`lekam watch` over SSH). Facts established on 27 Oct 2026 against Paseo 0.13 daemons:

- Paseo records every tool call in the agent timeline with `input` and `output`, including calls made from inside the pi `codemode` tool (they appear as their own entries, `callId` `<parent>/<n>`, name `mcp__…slack_send_message`). The Slack tool's output text contains `{"message_link": …, "message_context": {"message_ts", "channel_id"}}`. This holds for any provider Paseo runs.
- The SDK (`@getpaseo/client` 0.13) exposes `fetchAgents` (sort keys `status_priority|created_at|updated_at|title`, entries `{ agent, project }` with `updatedAt`, `archivedAt`, `labels`, `title`, `status`), `fetchAgentTimeline(agentId, { limit })` (entries `{ provider, item }`), `sendAgentMessage`, and in `@getpaseo/client/node` an SSH tunnel helper: `createSshTunnel(parseSshTransportUri('ssh://root@box'))` returned a local endpoint in ~230 ms. Lekam currently depends on 0.11.2, which lacks `/node`.
- Slack's own markers for "posted through an app with the user token" are inconsistent for the same app: one post had `client_msg_id` and no `app_id`, the next had `app_id` and no `client_msg_id`. Both carried a `context` block "*Sent using* AI Bot". So markers are hints, not a test.
- The adapter drops the owner's own messages unless they tag Lekam, self-tag, or land in an engaged thread; owner messages in captured DMs are always dropped. `onPostedAsOwner` therefore sees almost nothing today (zero audits since 16 Oct).

## Goals / Non-Goals

**Goals:**
- No agent-side hook; works for every provider Paseo runs.
- Lekam needs only: Slack, the brain, and a way to reach each daemon (local socket or SSH). No `paseo` CLI on the Lekam host.
- Cheap: no daemon traffic unless an owner message arrives while some agent was recently active.

**Non-Goals:**
- Perfect attribution when the Slack tool returns no timestamp (fallback by text is best-effort).
- Watching posts made with a bot identity.

## Decisions

1. **Every owner message is a candidate; the timeline decides.** The adapter emits `kind: 'owner_post'` for owner-authored messages that are not Lekam echoes, Lekam mentions or self-tags, in channels and in captured DMs, with `hints: { app_id, client_msg_id_missing, footer }`. The service routes it: bookkeeping for a watched thread (as `onPostedAsOwner` does now), then detection. Hints go to the audit only.
   *Alternative:* trigger only on marker-bearing posts – rejected, markers proved unreliable.

2. **Cheap pre-check before any timeline read.** Detection first lists agents per host (one call) and keeps those with `updatedAt >= post − lookback` (10 min), not archived, no skip label. If none, stop. Only then fetch timelines (`limit` 80, newest first if the API supports a direction; else the page's tail) for those few agents. Typical cost: one list call per host and 0–3 timeline reads.

3. **Match order: exact ts, then text.** Pure function `matchPost(timeline, post)` in `src/core/post-match.mjs`: walks `tool_call` items whose `name` matches `watches.detect.send_tools` (default `/slack.*send_message|post_message/i`), stringifies `detail.output`/`structuredContent`, and looks for `post.ts` or its permalink form `p<digits>`. Fallback: `normText(detail.input.message) === normText(post.text)` (the same normaliser the adapter uses for echoes) with a conversation check (`input.channel_id` equals the Slack channel, or is a user id and the post is a DM) and the entry's completion within ±2 min. Returns `{ callId, how: 'ts' | 'text' }`.

4. **Delay and retries.** The Slack event can beat the timeline write. Schedule detection at +3 s, retry at +15 s and +60 s while unmatched. Per-post state lives in memory (a map keyed by `channel:ts`); a restart drops pending detections, which catch-up at start replays from the audit? No: keep it simple – posts during a restart window are lost to detection and `lekam watch` remains the fallback.

5. **One connection per host, SDK for everything.** `src/executor/daemons.mjs` holds `{ name → DaemonClient }`: `local` → the owner executor's `paseo_url` (`ws://127.0.0.1:6767/ws` by default), `ws(s)://` as given, `ssh://` → `createSshTunnel` then `ws://<endpoint>/ws`. Lazy connect, reconnect on error, tunnel closed on stop. It offers `listRecentAgents(since)`, `timeline(agentId)`, `status(agentId)`, `waitIdle(agentId, timeoutMs)` (poll `fetchAgent` or subscribe), `send(agentId, text)` (`sendAgentMessage`, no wait). `PaseoCli` is deleted; `FakeWatchExec` becomes `FakeDaemons` with the same methods plus `agents`/`timelines` fixtures.
   *Alternative:* keep the CLI for forward and use the SDK only for detection – two code paths for one host, rejected.

6. **Registration reuses the store.** A match calls `store.registerWatch` with `host` = the configured host name, `title` = agent title, `message_ts` = post ts, `renewOnly` = !expectsReply where `expectsReply` = DM or the raw text tags a user other than an owner / a subteam / here/channel/everyone. Agents with label `lekam` are skipped (Lekam's own, already a request); `paseo.schedule-id` skipped (configurable `watches.detect.skip_labels`).

7. **Config.** `watches.hosts` values validated: `local` | `ws://`/`wss://` | `ssh://`. New `watches.detect: { enabled: true, lookback: '10m', delays: ['3s','15s','60s'], send_tools: '<regex>', skip_labels: ['lekam','paseo.schedule-id'] }`.

## Risks / Trade-offs

- [Timeline item shape changes with Paseo versions] → matching reads only `item.type/name/detail.input/detail.output` defensively and stringifies; a shape change degrades to "unmatched" (audited), never a crash. Smoke test in `test/smoke.paseo.mjs` against a live daemon.
- [Owner types a message while an agent is active → wasted scan] → bounded by the pre-check (one list call); unmatched posts without hints are not audited to keep the log quiet; unmatched posts *with* hints are.
- [Two agents post identical text within 2 minutes (fallback)] → exact ts wins whenever the tool returns it; the fallback picks the most recently updated agent and audits `how: 'text'`.
- [SSH tunnel dies mid-session] → reconnect on next use; forward failures already surface on the card with retry.
- [`@getpaseo/client` major bump] → the executor's existing facade calls (`createPaseoClient`, `agents.create/ref`, `waitForFinish`, label client) are covered by `test/paseo-labels.test.mjs` and the smoke test; verify them on the bump.
- [DM posts need `capture_dms`] → without it Lekam never hears the owner's DMs; README says so (already true for replies).

## Migration Plan

1. Bump `@getpaseo/client`, run tests + smoke against the local daemon.
2. Deploy; `watches.hosts` on the owner's config already fits (`local`, `ssh://root@orange.internal`).
3. Remove the pi extension and its links (done outside this repo on 27 Oct 2026).
4. Rollback: revert; the store schema is unchanged.

## Open Questions

- Does `fetchAgentTimeline` accept a direction/cursor to read newest-first? If not, `limit` 80 from the tail of a long session may miss the call; then use `searchAgentTimeline` (exists on the client) with the timestamp as the query. Either works without changing the spec.
