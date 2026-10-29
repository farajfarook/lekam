# Lekam

**A human-gated front door for your coding agents.** Anyone can ask in Slack; the owner approves with one tap; agents on a [Paseo](https://paseo.sh) daemon do the work and report back in the thread.

*Lekam* (ලේකම්, Sinhala): secretary; historically the officer who handled requests to the chief.

```
Slack ──Socket Mode──▶ lekam ──▶ brain (LLM, JSON only, no tools)
                         │
                         ├──▶ approval card → owner (DM, signed buttons)
                         ├──▶ store (SQLite: requests, outcomes, audit)
                         └──▶ Paseo daemon ──▶ agent (Pi, Claude Code, Codex, …)
```

## The one rule

**Nothing with tools runs until an owner has approved, and the owner sees exactly what will run.**

- The *brain* classifies messages and drafts briefs. It has no tools, no MCP, no network beyond one chat-completion call. It returns JSON; deterministic code decides.
- Approval is a Block Kit button pressed by a configured owner. Text, reactions and timeouts never approve. Timeouts deny.
- The owner approves a *scope* (brief + allowed outward actions). Follow-ups that stay in scope flow to the same agent; anything that smells like a scope change (new repo, PR, deploy, Jira, prod…) comes back as a new card.
- Results always go to the owner first, with **Post to thread** / **Discard**. Nothing reaches the thread without that second tap.
- Who speaks: replies when someone tagged **Lekam** come from Lekam. Replies when someone tagged **the owner** come from the owner's own account if `user_token_env` is set (see Install), else from Lekam. Posts as the owner are rewritten in the owner's voice first (friendly, Slack-style, an emoji or two at most; facts and links kept exactly), the result card shows exactly that text, and a small grey *Sent using Lekam* line is added underneath (`chat.owner_post_footer: false` turns it off). Set `owners[].voice` or `voice_file` to describe how you write; there is a sensible default.

## What it does

| Someone… | Lekam… |
|---|---|
| mentions `@Lekam` with a task or a question that needs live data | reacts 👀, sends the owner a card (verbatim request, proposed brief, skill, repo, outward-action checkboxes). Buttons: Approve task · Approve once · Discuss first · Edit brief · Decline |
| tags **the owner** with a task or a question that needs tools ("what did your team do today?"). The owner can tag themselves too: never dropped for low confidence, and the answer goes out as the owner. A tag is not an ask: "@Faraj & I tried" in a thread asking someone else is ignored | stays silent in the channel; DMs the owner: Delegate · Delegate (no outward actions) · Discuss first · Edit brief · Ignore. Only after Delegate does it speak in the thread |
| replies in a thread Lekam is working on | forwards in-scope follow-ups to the same agent session; cards scope changes. In a thread where someone asked the owner, Lekam never chimes in as itself |
| is the owner, replying in the channel thread | nothing, unless they tag Lekam: in the channel the owner is talking to people. Steer the agent in the DM thread |
| asks something that needs no agent | answers briefly in persona, or stays quiet |

**One thread per request.** In your DMs, everything about a request lives in one thread: under the approval card, or under your own message when you DM Lekam yourself. That includes follow-up cards, the Discuss-first chat, results, failures and your replies to the agent. Reply in that thread to keep talking to the same agent, even after the result was posted. Your messages reach the agent marked as coming from you (a per-request token only Lekam can produce), so they are authoritative: "approve it" or "go" is the confirmation a skill waits for, and you can allow actions the brief didn't list. Anyone else's follow-ups are marked untrusted, and so is the thread history the agent gets with its brief (so it can see who asked whom). The agent never posts its own reply: if something is posted as you in the request thread by another app (an agent's Slack tool), Lekam ignores it and tells you, unless session-post detection shows it came from one of your own sessions (say a manual pi session answering in the thread), in which case it stays quiet. One agent turn runs at a time per request. The agent's answers to you appear as-is; press **Draft reply as Faraj** (or **Post to thread** for Lekam's own threads) to turn the latest one into a thread reply, which you see exactly before posting. Older result cards stop working once there is a newer answer. When you DM Lekam yourself, the report is simply the reply in your thread; there is no Post step, because nobody else is in that conversation.

**Discuss first** starts the agent in investigate-only mode (read, reproduce, propose; change nothing). You chat with it in the card's DM thread or in the Paseo app, then press **Proceed** (same session, keeps its context) or **Drop**.

Status lives in one reaction on the original message: 👀 pending → ⚙️ running → ✅ done · 🚫 declined · ❌ failed · ❓ needs info. The ✅ lands when the result is posted to the thread.

## Thread watches: replies back to sessions Lekam didn't start

You also run agents by hand. When one of them posts in Slack with your account ("@Priya, ready for your review") and goes idle, the reply would normally go nowhere. Lekam watches for that and brings replies back to the session. Nothing needs installing in the agent, and it works for any provider Paseo runs (pi, Claude Code, Codex, …).

**How Lekam knows which session posted.** Every message your account posts in a channel Lekam is in (and in your DMs, with `capture_dms`) is checked: Lekam asks each configured Paseo daemon for agents active in the last few minutes, reads their recent timelines, and looks for the Slack tool call whose output names that exact message. A match registers a **watch** for that session. A post that tags someone (or a group, @here) or is a DM starts a watch; any other post only renews one the session already has. Scheduled runs and Lekam's own sessions are skipped. Messages you type yourself match nothing and are ignored.

**What happens with a watch.**
- Replies in the thread (in a DM: the next messages in that conversation) from anyone but you, including ones that tag you, come to you as one card in your DMs: who replied, the reply, the waiting session. **Forward to session** · **Ignore** · **Stop watching**. Nothing reaches the session without your tap.
- Acknowledgements ("thanks", "ok", emoji) are dropped. Replies that arrive before you act join the same card and are forwarded together.
- Forward starts a new turn in the same Paseo session, with each reply quoted as coming from that person (not you: information, not permission). A busy session is waited for, never interrupted. An archived one isn't sent to; the card says so and you can retry.
- One waiting session per thread: a later session posting there takes it over. Watches expire after `watches.ttl` (3 days) without a renewal or a forward.
- Lekam re-reads watched conversations at start-up and every `watches.catch_up_interval`, so replies posted while it was disconnected aren't lost. If it can't read a conversation (not invited to the channel), it tells you once.
- A live Lekam request in the same thread keeps its follow-ups, and `@Lekam` mentions there are normal requests.

**What it needs.** Lekam in the channel; `capture_dms` for DMs; and each daemon listed under `watches.hosts`: `local` for the one on Lekam's machine, `ssh://user@host` for others (Lekam runs `ssh` itself through the Paseo SDK, so the other host's daemon stays on 127.0.0.1), or a `ws://` URL. `lekam check` shows whether each is reachable.

**Manual fallback.** For a session Lekam can't see posting (another Slack app, a channel it joined late):

```bash
lekam watch --channel C0123 --thread 1712345678.123456 --agent <paseo agent id> --host <host name> --title "PR session" [--message-ts <ts of the session's post>]
```

It needs no secrets, so it can run over SSH. `lekam watches` lists active watches (and how each was registered); `lekam unwatch --channel … --thread …` ends one.

## Install

Requirements: Node ≥ 22.13, a running Paseo daemon with at least one provider, an OpenAI-compatible endpoint (LiteLLM, OpenAI, …) for the brain, and a Slack workspace where you can create an app.

```bash
git clone https://github.com/farajfarook/lekam && cd lekam && npm install
cp config/lekam.example.yml lekam.yml
cp config/persona.md config/guardrails.md .     # edit to taste
```

1. **Slack app**: create one from `config/slack-manifest.yml` (api.slack.com → Create app → From manifest). Install to the workspace. Copy the bot token (`xoxb-…`) and create an app-level token with `connections:write` (`xapp-…`).
2. **Brain key**: a budget-capped key on your LiteLLM/OpenAI endpoint. A Sonnet-class model is recommended: the brain has to read who each thread message is addressed to, and it also writes the owner-voice rewrite.
3. **Environment** (never in files):
   ```bash
   export LEKAM_SLACK_BOT_TOKEN=xoxb-…
   export LEKAM_SLACK_APP_TOKEN=xapp-…
   export LEKAM_BRAIN_KEY=sk-…
   export LITELLM_RMS_URL=https://your-litellm   # or whatever brain.base_url_env names
   ```
4. **Config**: edit `lekam.yml` — your Slack user id under `owners`, the Paseo `provider/model` (run `lekam check` to see options), `cwd`, repos, skills dirs, outward actions.
5. ```bash
   node src/cli.mjs check      # env present, brain answers, daemon + provider reachable, Slack auth
   node src/cli.mjs run
   ```
6. Invite the bot to a channel: `/invite @Lekam`. It only hears channels it's in.
7. Optional, capture your DMs: set `capture_dms: true` on your owner entry, add the user scope `im:history` and, under *Event Subscriptions → Subscribe to events on behalf of users*, the event `message.im`, then reinstall. DMs people send you are then handled like tagging you (silent card, reply as you, nothing sent without your tap). Every such DM is read by the brain model to decide whether it is a request.
8. Optional, reply as yourself: the manifest asks for the user scope `chat:write`. After installing, copy the **User OAuth Token** (`xoxp-…`) from *OAuth & Permissions* into an env var and name it in `owners[].user_token_env`. `lekam check` confirms whose account it posts as.
9. To DM Lekam: api.slack.com/apps → your app → **App Home** → **Show Tabs** → turn on **Messages Tab** and tick **Allow users to send Slash commands and messages from the messages tab**. Without it Slack shows "Sending messages to this app has been turned off". Restart the Slack client after changing it.

As a service: `config/lekam.service` (systemd user unit). Without a login session, run `systemctl --user` with `XDG_RUNTIME_DIR=/run/user/$(id -u)` and `DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus` set, and `loginctl enable-linger $USER` so it starts at boot.

## Configuration

Everything personal lives in `lekam.yml`, `persona.md` (the bot's voice) and `guardrails.md` (rules prepended to every agent brief). `*_env` keys name environment variables; the loader never logs their values.

- `owners[]` — one or more. Each has a Slack id, the channels it is default for, and its own executor (`paseo_url`, `provider/model`, `cwd`, `max_concurrent`, `run_timeout`, `workspace_label`). Every session Lekam creates is put under the Paseo workspace label `workspace_label` (default `Lekam`): an existing label with that name is reused with its colour, otherwise it is created (`workspace_label_color`, default amber). Set `workspace_label: null` to turn it off.
- `brain` — endpoint, models (`classify_model`, optional stronger `brief_model`), `threshold` (owner-mentions below it never card), context sizes.
- `approvals` — TTLs per kind (expiry = deny), `owner_auto_start` (the owner tagging Lekam starts the job with no approval card; the result still waits for the owner's Post) with `owner_withhold` (outward actions those jobs don't get, default Slack posts and email), `force_card_patterns`, `outward_actions_mode` (`ask` checkboxes, `proposed` the brief's actions, `all` everything; the card always shows what will be granted).
- `outward_actions` — the ids the brain may propose and you approve per request.
- `people_file` / `people` — who to @-tag in posted results (a JSON roster like `{members:[{name, slackId, github}]}`, or inline `{name, slack_id, github, aliases}`). Names, GitHub logins and the owner-voice rewrite's references become Slack mentions; the owner is never tagged.
- `agent_tools` — plain-text list of live data sources your agents can reach (HR, Jira, CI…). Without it the brain may shrug at questions like "any leave plans?" instead of carding them.
- `watches` — thread watches: `ttl` (default `3d`), `hosts` (host name → `local`, `ssh://user@host[?daemonPort=N]` or `ws://…`; default: this machine only), `wait_timeout` (how long Forward waits for a busy session, `45m`), `catch_up_interval` (`15m`), and `detect`: `enabled` (true), `lookback` (`10m`: agents active this long before a post are searched), `delays` (`[3s, 15s, 60s]`: when to look, as the tool's output can land after the post; typed-looking posts get the first only), `send_tools` (regex of Slack send tool names), `skip_labels` (`[lekam, paseo.schedule-id]`), `timeline_limit` (150).
- `repos`, `skills_dirs` — the catalogue the brain sees. Skills are read from `*/SKILL.md` frontmatter (`name`, `description`, optional `lekam_outward_actions`). A `catalogue_file` can replace the auto-generated skills section.

## CLI

```
lekam run        start the service
lekam check      verify env, brain, daemon/provider, Slack auth (exit 1 on any failure)
lekam catalogue  print what the brain sees
lekam audit      tail the append-only audit log (--tail N)
lekam watch      register or renew a thread watch by hand (JSON out; no secrets needed)
lekam unwatch    end the watch on a thread
lekam watches    list active watches (--all for ended ones)
```

## Design

The spec lives in `openspec/` (OpenSpec): `openspec/changes/phase-1-front-door/` has the proposal, design and tasks; `openspec/specs/*/spec.md` are the capability specs. Three seams — chat adapter, brain, executor — are interfaces with one implementation each (Slack, OpenAI-compatible, Paseo), so other platforms/endpoints/executors can be added.

Phase 1 limits: Slack only, Paseo only, no passive listening (watched threads are the one exception, and only for registered threads), no auto-approved task types, investigate-only mode is a brief not a sandbox.

## Development

```bash
npm test                 # node:test, fakes for chat/brain/executor; no network
```

Apache-2.0.
