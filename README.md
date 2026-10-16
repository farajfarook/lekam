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
- Results go to the owner first, with **Post to thread** / **Discard**, unless they ticked auto-post.

## What it does

| Someone… | Lekam… |
|---|---|
| mentions `@Lekam` with a task | reacts 👀, sends the owner a card (verbatim request, proposed brief, skill, repo, outward-action checkboxes). Buttons: Approve task · Approve once · Discuss first · Edit brief · Decline |
| tags **the owner** with a task | stays silent in the channel; DMs the owner: Delegate · Delegate (no outward actions) · Discuss first · Edit brief · Ignore. Only after Delegate does it speak in the thread |
| replies in a thread Lekam is working on | forwards in-scope follow-ups to the same agent session; cards scope changes |
| asks something that needs no agent | answers briefly in persona, or stays quiet |

**Discuss first** starts the agent in investigate-only mode (read, reproduce, propose; change nothing). You chat with it in the card's DM thread or in the Paseo app, then press **Proceed** (same session, keeps its context) or **Drop**.

Status lives in one reaction on the original message: 👀 pending → ⚙️ running → ✅ done · 🚫 declined · ❌ failed · ❓ needs info. The ✅ lands when the result is posted to the thread.

## Install

Requirements: Node ≥ 22.13, a running Paseo daemon with at least one provider, an OpenAI-compatible endpoint (LiteLLM, OpenAI, …) for the brain, and a Slack workspace where you can create an app.

```bash
git clone https://github.com/farajfarook/lekam && cd lekam && npm install
cp config/lekam.example.yml lekam.yml
cp config/persona.md config/guardrails.md .     # edit to taste
```

1. **Slack app**: create one from `config/slack-manifest.yml` (api.slack.com → Create app → From manifest). Install to the workspace. Copy the bot token (`xoxb-…`) and create an app-level token with `connections:write` (`xapp-…`).
2. **Brain key**: a budget-capped key on your LiteLLM/OpenAI endpoint. A small fast model is plenty (Claude Haiku class).
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

As a service: `config/lekam.service` (systemd user unit). Without a login session, run `systemctl --user` with `XDG_RUNTIME_DIR=/run/user/$(id -u)` and `DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus` set, and `loginctl enable-linger $USER` so it starts at boot.

## Configuration

Everything personal lives in `lekam.yml`, `persona.md` (the bot's voice) and `guardrails.md` (rules prepended to every agent brief). `*_env` keys name environment variables; the loader never logs their values.

- `owners[]` — one or more. Each has a Slack id, the channels it is default for, and its own executor (`paseo_url`, `provider/model`, `cwd`, `max_concurrent`, `run_timeout`).
- `brain` — endpoint, models (`classify_model`, optional stronger `brief_model`), `threshold` (owner-mentions below it never card), context sizes.
- `approvals` — TTLs per kind (expiry = deny), `force_card_patterns`, auto-post default.
- `outward_actions` — the ids the brain may propose and you approve per request.
- `repos`, `skills_dirs` — the catalogue the brain sees. Skills are read from `*/SKILL.md` frontmatter (`name`, `description`, optional `lekam_outward_actions`). A `catalogue_file` can replace the auto-generated skills section.

## CLI

```
lekam run        start the service
lekam check      verify env, brain, daemon/provider, Slack auth (exit 1 on any failure)
lekam catalogue  print what the brain sees
lekam audit      tail the append-only audit log (--tail N)
```

## Design

The spec lives in `openspec/` (OpenSpec): `openspec/changes/phase-1-front-door/` has the proposal, design and tasks; `openspec/specs/*/spec.md` are the capability specs. Three seams — chat adapter, brain, executor — are interfaces with one implementation each (Slack, OpenAI-compatible, Paseo), so other platforms/endpoints/executors can be added.

Phase 1 limits: Slack only, Paseo only, no passive listening, no auto-approved task types, investigate-only mode is a brief not a sandbox.

## Development

```bash
npm test                 # node:test, fakes for chat/brain/executor; no network
```

Apache-2.0.
