# Proposal: Phase 1 – the front door

## Why

Coding agents with tools (Paseo + Pi, Claude Code, etc.) are useful to a whole team, but only one person can safely own an agent that runs with their credentials on their machine. Today a teammate has to ask that person in Slack, who then opens a terminal and briefs an agent by hand. Lekam puts a bot in front: anyone can ask in chat, the owner approves with one tap, and an agent does the work and reports back in the thread. The approval gate is the security boundary; nothing with tools runs without it.

## What Changes

- New product `lekam`: a single Node service (npm package + CLI) that connects a chat platform to a Paseo daemon through an owner-approval gate.
- Slack chat adapter (Socket Mode, no public URL): reacts to bot mentions, to mentions of a configured owner, and to follow-ups in threads it is already engaged in. Only in channels it has been invited to.
- Tool-less orchestrator ("the brain"): an OpenAI-compatible chat-completion call (LiteLLM) that classifies each message into structured JSON (intent, reply, proposed brief, outward actions) using a catalogue of skills/repos/actions built from the owner's agent config. It never calls tools.
- Approval cards sent to the owner as a DM with signed Block Kit buttons: Delegate, Discuss first, Edit brief, Ignore. Approve-task vs approve-once scoping. Expiry defaults to deny.
- Paseo executor: one agent per chat thread, labelled with the thread identity, handoff brief when a session is gone, concurrency cap, investigate-only phase for "Discuss first".
- Store: SQLite (`node:sqlite`) with request records, outcomes, event dedupe and an append-only audit log.
- Reactions as status (👀 ⚙️ ✅ 🚫 ❌ ❓); persona and guardrails as editable markdown files.
- Multi-owner config shape from day one (`owners:` list), run with one owner.

## Out of scope for phase 1

- Passive listening in channels (acting on messages that mention nobody).
- Pre-approved / auto-approved task types.
- Paseo plugin wrapper and in-app approvals panel.
- Routing worker clarifying questions back to the requester.
- Enforced read-only mode for the investigate phase (it is a brief, not a sandbox, in phase 1).
- Long-term / semantic memory. Only per-request outcomes are stored.
- Any chat platform other than Slack; any executor other than Paseo.

## Capabilities

### New Capabilities

- `chat-slack`: Slack adapter – what the bot listens to, filters, reacts to, and how it renders replies and approval cards.
- `orchestrator`: the tool-less brain – catalogue, prompt contract, JSON output schema, confidence threshold, persona rules.
- `approvals`: the owner approval gate – card contents, actions, scope, identity checks, expiry, follow-up policy.
- `executor-paseo`: running work on a Paseo daemon – session-per-thread, labels, handoff brief, investigate phase, concurrency, result delivery.
- `store`: persistence – request record, state machine, outcome, dedupe, audit log.

### Modified Capabilities

None (first change).

## Impact

- New repository `farajfarook/lekam`, npm package `lekam`, Node 22 ESM, no build step.
- Runtime dependencies: `@slack/bolt`, `@getpaseo/client`, `yaml`. Dev: none beyond Node built-ins (`node:test`, `node:sqlite`).
- External systems: a Slack app (Socket Mode scopes), a Paseo daemon reachable over WebSocket, an OpenAI-compatible endpoint (LiteLLM) with a budget-capped key.
- Deployment: systemd user unit on the owner's machine; env vars for the three secrets.
