# Design: Phase 1 – the front door

## Context

Lekam sits between a chat platform and a Paseo daemon. The daemon already runs agents (Pi in the reference deployment) with full access to the owner's machine and credentials. The product's job is to make that safely reachable by other people. The one invariant that everything else serves: **no AI with tools runs until a configured owner has explicitly approved, and the owner sees exactly what will run.**

Paseo Hub was evaluated and rejected for this use: it only dispatches Claude/Codex/OpenCode agents and has no human gate. Paseo plugins were rejected as the primary packaging because they are unsandboxed daemon subprocesses with no settings/secret story; a plugin wrapper may be added later for an in-app approvals panel.

## Architecture

```
Slack ──Socket Mode──▶ chat/slack ──▶ core ──▶ brain (LLM, JSON only, no tools)
                                        │
                                        ├──▶ approvals (cards to owner, signed actions)
                                        ├──▶ store (sqlite: requests, outcomes, audit, dedupe)
                                        └──▶ executor/paseo ──ws──▶ Paseo daemon ──▶ Pi agent
```

Three seams, each an interface with one implementation in phase 1:

| Seam | Interface | Phase-1 impl |
|---|---|---|
| chat | `ChatAdapter`: `start()`, `onMessage`, `onAction`, `react()`, `post()`, `dm()`, `updateCard()`, `fetchThread()` | Slack via `@slack/bolt` |
| brain | `Brain`: `classify(input) -> Classification` | OpenAI-compatible `/chat/completions` with `response_format: json_schema` |
| executor | `Executor`: `start(brief) -> session`, `send(session, text)`, `waitForFinish`, `archive`, `find(labels)` | Paseo via `@getpaseo/client` |

`core` owns the state machine and is the only module allowed to call `executor.start`. The brain cannot reach the executor; it only returns data.

## Module layout

```
src/
  cli.mjs                 `lekam --config lekam.yml` (and `lekam check`, `lekam catalogue`)
  core/
    config.mjs            load + validate lekam.yml, resolve $ENV refs, no secret echo
    state.mjs             request state machine (pure functions)
    catalogue.mjs         build the brain's catalogue from skills dirs + repo table + actions
    router.mjs            message -> (new request | follow-up | ignore), scope-change detection
    service.mjs           wires adapters; the only place with side-effect orchestration
  brain/
    openai-compatible.mjs HTTP client, JSON schema, retries, token/cost accounting
    schema.mjs            Classification JSON schema (shared with tests)
    prompt.mjs            system prompt assembly: persona + catalogue + recent outcomes
  chat/
    slack/
      adapter.mjs         Bolt app, event filters, reactions, DMs
      blocks.mjs          Block Kit builders for approval cards, replies, errors
  approvals/
    cards.mjs             card model <-> blocks; action ids; identity checks
    policy.mjs            follow-up policy (task vs once), expiry, forced-card keywords
  executor/
    paseo.mjs             sessions, labels, briefs, handoff, concurrency semaphore
    briefs.mjs            compose worker prompt: guardrails + brief + delimited request
  store/
    sqlite.mjs            node:sqlite; migrations; requests, events, audit
    audit.mjs             append-only audit writer
config/
  lekam.example.yml  persona.md  guardrails.md  slack-manifest.yml  lekam.service
test/                     node:test; fakes for chat, brain, executor
```

## Key decisions

### D1. The LLM proposes, code decides
The brain returns a `Classification` object validated against a JSON schema. `core/router.mjs` maps it, plus deterministic checks, to an action. The brain's text fields (`reply_to_user`, `brief`) are only ever rendered to humans or embedded, delimited, in a worker prompt. No field of the classification is executed.

### D2. Thread is the unit of work
Identity of a request is `(channel, thread_ts)`. One request ↔ at most one live executor session. Sessions are labelled `{ lekam: "1", channel, thread_ts, request_id }` so the mapping can be rebuilt from the executor if the store is lost.

### D3. Approvals are scoped, not per-message
Owner approves a *scope*: brief text + allowed outward actions. Follow-ups classified `in_scope` go straight to the session. `scope_change` or any forced-card keyword (configurable list: repo names, "PR", "deploy", "merge", "Jira", "email", "prod") produces a new card. Owner can choose *Approve task* (follow-ups flow) or *Approve once* (every follow-up re-asks).

### D4. Owner-mention path is silent until delegated
When a non-bot user mentions an owner, the bot does nothing visible in the channel. The owner gets a DM card with Delegate / Discuss first / Edit brief / Ignore. Only after Delegate or Proceed does the bot post in the thread. Ignore and expiry are invisible to the requester.

### D5. Identity of approvals
Only interactive Block Kit actions whose `user.id` is in `owners[]` for that request are honoured. Reactions and message text are never treated as approval. Bolt verifies Socket Mode envelopes; the bridge additionally checks the action's `user.id` against the request's owner.

### D6. Timeouts deny
A pending card expires after `approvals.ttl` (default 4h for owner-mention suggestions, 24h for bot-mention requests). Expiry transitions to `EXPIRED`, updates the card, posts nothing in the channel.

### D7. Investigate-only phase
"Discuss first" starts the session now with an *investigate brief* (read, reproduce, propose; change nothing; no outward actions). Owner converses via Paseo (link on the card) or a DM thread piped to the session. *Proceed* sends the go brief to the same session; *Drop* archives it. Phase 1 relies on the brief; enforcement is a later phase.

### D8. Results go to the owner first
On session finish, the final message is DM'd to the owner with Post / Discard. Posting to the thread is always a second owner action (the auto-post option was removed).

### D9. Secrets
`lekam.yml` names env vars (`api_key_env: LEKAM_BRAIN_KEY`); the loader reads them and never logs them. `lekam check` reports presence/length only.

### D10. Storage
`node:sqlite` (unflagged in Node 22.13+). Tables: `requests`, `events` (dedupe by Slack `event_id`, TTL 24h), `audit` (append-only JSON rows), `sessions`. Single file, WAL mode.

### D11. Reactions as status
One reaction on the originating message, swapped on transitions: 👀 pending → ⚙️ running → ✅ done | 🚫 declined | ❌ failed | ❓ needs info. Emoji names configurable.

### D12. Multi-owner shape
`owners:` is a list; each owner has `slack_id`, executor settings (`paseo_url`, `provider`, `cwd`, `max_concurrent`), and `default_for_channels`. Bot-mentions route to the channel's default owner, else the first owner. Owner-mentions route to that owner. Phase 1 runs with one entry.

## Request state machine

```
NEW ─► PENDING_APPROVAL ─► APPROVED ─► RUNNING ─► DONE ─► RELEASED | DISCARDED
            │                   │          └──► FAILED
            ├─► DENIED          └─► INVESTIGATING ─► (Proceed) RUNNING
            └─► EXPIRED                           └─► (Drop) DROPPED
NEW ─► IGNORED        (owner-mention classified not-actionable, or below threshold)
```

Transitions are pure functions in `core/state.mjs` and tested exhaustively. Illegal transitions throw.

## Prompt contract (brain)

System prompt = persona.md + catalogue + "recent outcomes" (last N DONE requests: one line each) + output rules. User turn = JSON `{ kind: bot_mention|owner_mention|followup, requester, channel, thread_excerpt[], text, approved_scope? }`.

Output schema (strict):

```json
{
  "intent": "task_request | question | fyi | chitchat | needs_clarification",
  "actionable": true,
  "confidence": 0.0,
  "urgent": false,
  "reply_to_user": "string | null",
  "brief": { "summary": "", "skill": "string|null", "repo": "string|null",
             "outward_actions": ["jira_comment","pr_create"], "notes": "" } ,
  "followup": "in_scope | scope_change | not_for_agent | null",
  "clarifying_question": "string | null"
}
```

`(task_request || question) && actionable && confidence >= brain.threshold` is the only thing that creates a card for owner-mentions. For bot-mentions a card is created for any `task_request` or actionable `question`; below-threshold ones are marked "low confidence" on the card.

## Risks and mitigations

- **Prompt injection via request text** → request text is delimited in the worker prompt; owner reads verbatim text on the card; guardrails forbid outward actions not in the approved scope.
- **Approval fatigue** → owner-mentions need the threshold; FYI/chit-chat never card; digest later.
- **Worker hangs on a question/permission** → guardrails instruct "assume and report"; session `waitForFinish` timeout → FAILED with reason; owner can open in Paseo.
- **Box overload** → per-owner `max_concurrent` semaphore; queued requests show ⚙️ with "queued" on the card.
- **Slack retries** → ack immediately, dedupe by `event_id`.
- **Key spend** → dedicated budget-capped LiteLLM key; per-user rate limit (`limits.per_user_per_hour`).
