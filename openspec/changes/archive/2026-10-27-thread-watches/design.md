# Design

## Context

Lekam already hears every message in channels it is in (Socket Mode, `message.channels`), and the owner's DMs when `capture_dms` is on. The adapter only passes on mentions and messages in "engaged" threads; the service turns engaged-thread messages into follow-ups for a Lekam request. Agents Lekam did not start are invisible to it: it has no record of which session is waiting on which thread, and its executor only talks to the local Paseo daemon over the SDK. The owner runs Paseo daemons on more than one host; host-to-host control goes over SSH (daemons listen on 127.0.0.1 only).

## Goals / Non-Goals

**Goals:**
- A watch can be registered from any host with one command, without secrets or an open port.
- Watched replies reuse Lekam's existing hearing, brain and DM-card machinery; the owner's tap stays the only way text reaches a session.
- No reply is lost to a disconnect or a race with registration, and none is handled twice.

**Non-Goals:**
- A network API for registration.
- Using the Paseo SDK for remote daemons (the CLI's `--host ssh://` already works).
- Reporting the session's answer back to the owner in Slack: the owner follows the session in Paseo.

## Decisions

1. **Registration is a CLI command writing to the SQLite store.** `lekam watch` loads `lekam.yml` leniently (missing secret env vars are fine), opens the same database and upserts the watch. The running service reads watches from the store on every lookup (no cache), so a new watch is live immediately. Remote hosts run it over SSH. The store sets `busy_timeout` so the CLI and service can write at the same time.
   *Alternatives:* an HTTP endpoint (needs a port, auth and a token on every host); a Slack-side marker in the posted message (the Slack tools agents use can't attach metadata, and text markers are visible to people).

2. **One active watch per conversation.** Channel threads are keyed by (channel, thread_ts); DMs by channel, because DM replies are rarely threaded. A new registration for the same agent renews; for another agent it supersedes the old watch. Renewal keeps `last_seen_ts`, so catch-up never skips a reply that was missed live.

3. **Routing precedence.** In `onMessage`, after the existing owner checks: bot mentions keep the normal flow; a live Lekam request in the thread (pending/approved/investigating/running) keeps the follow-up flow; otherwise an active watch takes the message. `isEngagedThread` returns true for watched threads so the adapter passes untagged replies through.

4. **Classification with a slim prompt.** Watch replies use the existing brain contract with a new kind `watch_reply` and the session title. The catalogue is replaced by a one-line placeholder (skills and repos don't matter here), keeping the call cheap. A pure `decideWatchReply` drops only `chitchat` that is not actionable; the brain being down means card.

5. **One pending card per watch, batched.** Replies get a batch id. While a watch has a pending card, new replies join its batch and the card is re-rendered. Buttons carry `watchId|batch`. Per-watch serialisation of reply handling and card actions prevents a reply racing a click. The first card is top-level in the owner's DM; later ones go in its thread with an @-mention (bot-started threads aren't followed otherwise).

6. **Delivery through the `paseo` CLI.** A small `PaseoCli` wrapper runs `paseo inspect --json`, `paseo wait --timeout`, `paseo send --prompt-file … --no-wait`, adding `--host <target>` from `watches.hosts[<host>]` (`local` = no flag). Forward checks status, waits for an idle session (never steers), then sends without waiting for the turn. Forwards are serialised per watch, separately from reply handling so a long wait doesn't block new cards.

7. **Untrusted framing.** The forwarded text wraps each reply in `<chat-followup from="…">` (owner-message tags stripped), adds the thread link and says the replies grant nothing new. The agent's authority still comes only from the owner in the session.

8. **Catch-up by re-reading.** A one-minute tick expires watches and catches up watches not yet checked (new registrations); every 15 minutes, and at start, all active watches are caught up. Catch-up reads `conversations.replies` (threads) or `conversations.history` (DMs) since `last_seen_ts`, through the bot token or the owner's user token. Replies are stored with UNIQUE(watch_id, ts): the live path and catch-up both insert-or-ignore, so whoever comes second does nothing. A read failing with not-in-channel / channel-not-found marks the watch `no_access` and DMs the owner once.

## Risks / Trade-offs

- [The `paseo` CLI output format changes] → parse `inspect --json` defensively (both `Status` and `status`), surface CLI errors on the card.
- [SSH from the service fails (host key, key missing)] → the card shows the error; the reply stays readable in the card so the owner can paste it by hand.
- [A busy session never goes idle] → wait is bounded (`watches.wait_timeout`, default 45m); then the card says so.
- [Noise from chatty threads] → acknowledgements are dropped; batching keeps it to one card; Stop watching ends it.
- [The agent posts again in the thread without registering (no tag)] → the extension sends a renew-only registration for every post, so the watch's expiry follows the conversation.
- [Takeover surprises] → superseding is audited; the latest poster is the one waiting, which matches how threads are used.

## Migration Plan

Schema migration 3 adds the two tables; existing data is untouched. Without a `watches:` block the feature works with the local host only. Roll back by reverting the commit; the extra tables are ignored by older code.
