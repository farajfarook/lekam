# Proposal: Thread watches – replies back to the session that is waiting

## Why

The owner also runs agents by hand (manual Paseo sessions). Those agents often post in Slack as the owner ("@Priya, ready for your review") and then go idle. When the person replies, nothing reaches the session: Lekam drops the reply because it is not one of Lekam's threads, or treats a tag of the owner as a brand-new request with no context. The owner has to notice the reply and paste it into the session by hand.

## What Changes

- New `watch` registration: a session that posted in a thread (or DM) tells Lekam "watch this thread for agent X on host Y". Registration is a CLI command (`lekam watch`) that writes to Lekam's store and needs no secrets, so it can be called locally or over SSH from another host. `lekam unwatch` and `lekam watches` end and list watches.
- Lekam listens to watched threads: replies there count as engaged (like its own threads). A reply from someone other than the owner, including one that tags the owner, goes to the watch instead of the owner-tag or new-request paths.
- The brain classifies each watch reply (new kind `watch_reply`). Acknowledgements (thanks, emoji, "ok") are dropped silently. Everything else goes to the owner.
- New watch card in the owner's DMs: who replied, the quoted reply, the waiting session (title, host, Paseo link), and **Forward** / **Ignore** / **Stop watching**. Replies that arrive while a card is pending are added to it. Nothing reaches the session without the owner's tap.
- Forward delivers the replies to the same Paseo session as a new turn, marked as quoted from a person in the thread (untrusted). It waits for a busy session to go idle instead of interrupting it. It reaches other hosts through the `paseo` CLI over SSH (`--host ssh://…`), configured per host name.
- Watches expire after a configurable idle time (default 3 days), renewed when the session posts again in the thread or the owner forwards a reply.
- Catch-up: Lekam re-reads watched threads periodically and on restart, so replies posted while it was disconnected, or before the watch registered, are not lost. A watch on a conversation Lekam cannot read is marked and the owner is told once.

## Out of scope

- Forwarding without the owner's tap (auto-forward).
- Registering watches automatically from inside Lekam (the caller registers; the owner's pi extension does this for manual sessions, outside this repo).
- Replies outside the watched thread (a new top-level message about the same topic) – they go through the normal owner-tag path.
- More than one waiting session per thread: the latest registration takes the thread over.
- Conversations Lekam is not a member of (it can't hear them; the owner is told).
- Starting a replacement session when the waiting one is archived.

## Capabilities

### New Capabilities

- `thread-watches`: registering, routing, classifying, carding, forwarding, expiring and catching up replies in threads that an external agent session is waiting on.

### Modified Capabilities

None at spec level. (`openspec/specs/` has no archived capabilities yet; the routing precedence between watches and existing Lekam requests is specified in `thread-watches`.)

## Impact

- `src/store/sqlite.mjs`: migration adding `watches` and `watch_replies`; busy timeout so the CLI and the service can write concurrently.
- `src/core/service.mjs`, `src/core/router.mjs`: watch routing, sweep timers, card actions.
- `src/approvals/cards.mjs`: watch card and action ids.
- `src/executor/paseo-cli.mjs` (new): inspect / wait / send through the `paseo` CLI, local or `--host`.
- `src/brain/prompt.mjs`: `watch_reply` kind guidance.
- `src/chat/slack/adapter.mjs`, `src/chat/fake.mjs`: read a thread or DM since a timestamp, with errors surfaced.
- `src/cli.mjs`, `src/core/config.mjs`: `watch` / `unwatch` / `watches` commands, lenient config loading for them, `watches:` config block.
- Docs: README, `config/lekam.example.yml`.
- Runtime dependency on the `paseo` CLI being on the service's PATH (already true where the daemon runs), and SSH keys from the Lekam host to each remote host.
