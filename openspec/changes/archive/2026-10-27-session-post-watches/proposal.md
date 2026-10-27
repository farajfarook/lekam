# Proposal: Session-post watches – Lekam registers watches itself

## Why

Thread watches (archived change `2026-10-27-thread-watches`) need something to call `lekam watch` after a session posts in Slack. Today that is a pi extension installed on every host that runs sessions. For anyone installing Lekam that is one more moving part, it only covers pi (not Claude Code or Codex), it needs SSH from every session host back to Lekam, and it goes stale when a copy isn't updated. Lekam already hears the post and already reaches the Paseo daemons, so it can work out which session posted and register the watch itself.

## What Changes

- **Session-post detection.** Every message the owner's account posts in a conversation Lekam can hear is a candidate. Lekam asks each configured daemon for agents active in the last few minutes, reads their recent timelines, and looks for the tool call that produced that exact Slack message (its `message_ts` in the tool's output; a normalised-text fallback for tools that don't return it). A match registers (or renews) a watch for that agent, with the same rule as before: a post that tags someone or is a DM expects a reply and creates a watch; other posts only renew an existing one. Scheduled runs and Lekam's own sessions are skipped.
- **Owner posts reach the service.** The Slack adapter stops dropping the owner's own messages. It emits an `owner_post` kind for them (channels and captured DMs), carrying the hints Slack gives (`app_id`, missing `client_msg_id`, a "Sent using …" footer). Self-tags and Lekam mentions keep their current kinds.
- **Daemon connections replace the `paseo` CLI.** Lekam keeps one SDK connection per configured host: a WebSocket for the local daemon, an SSH tunnel (the SDK's own helper) for remote ones. Timeline reads, status checks, idle waits and forwards all use it. The `paseo` binary is no longer needed on the Lekam host. `watches.hosts` values become daemon targets (`ws://…` or `ssh://user@host`).
- **`lekam watch` stays** as the manual fallback (a session that posts through a Slack app Lekam can't see, a channel Lekam joined late) and for tests.
- **BREAKING for `watches.hosts`:** `local` is still accepted and means the local daemon URL, but other values must now be `ws://`/`wss://` URLs or `ssh://` targets, not arbitrary `paseo --host` strings. Only one config in the wild; it already uses `local` and `ssh://`.
- The pi extension is retired (it lives outside this repo).

## Out of scope

- Posts made with a Slack identity other than the owner's (a bot token): Lekam can't tell them apart from any other bot and the session might not be the owner's. Use `lekam watch`.
- Agents on daemons Lekam isn't configured for.
- Matching when the timeline is unavailable (daemon down, agent deleted): the post is audited as unmatched; nothing else.
- Any change to how replies are carded or forwarded once a watch exists.

## Capabilities

### New Capabilities

- `session-post-detection`: finding the agent session behind a Slack post by the owner, by matching the post to tool calls in Paseo agent timelines across configured daemons, and registering a watch for it.

### Modified Capabilities

- `thread-watches`: watch registration gains an automatic source (detection) alongside the CLI; forwarding and status use daemon connections instead of the `paseo` CLI; host configuration is a daemon target.

## Impact

- `src/chat/slack/adapter.mjs`, `src/chat/fake.mjs`: `owner_post` kind for owner-authored messages (channels + captured DMs) with app hints.
- `src/core/service.mjs`: route `owner_post`; detection scheduler (delay + retries); registration from a match.
- `src/executor/daemons.mjs` (new): per-host daemon connections (ws / ssh tunnel), agent list, timeline fetch, status, wait, send. Replaces `src/executor/paseo-cli.mjs` (deleted).
- `src/core/post-match.mjs` (new, pure): find the tool call behind a post in a timeline page.
- `src/core/config.mjs`: `watches.hosts` validation (ws/wss/ssh/local), `watches.detect` block (lookback, delays, skip labels, tool name pattern).
- `src/cli.mjs`: `check` reports each daemon; `watch` unchanged.
- `package.json`: `@getpaseo/client` ^0.13 (SSH tunnel helper lives in `@getpaseo/client/node`).
- Docs: README (watches section rewritten: no hook), `config/lekam.example.yml`.
