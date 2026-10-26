# Spec Delta

## Purpose
The orchestrator ("brain") turns a chat message plus context into a structured classification and a short reply. It has no tools and no side effects; it only returns data that deterministic code acts on.

## ADDED Requirements

### Requirement: No tools, ever
The brain SHALL make exactly one HTTP call per classification to an OpenAI-compatible `/chat/completions` endpoint. The request SHALL NOT include `tools`, `functions` or `tool_choice`. The brain module SHALL NOT import the executor, the store or the chat adapter.

#### Scenario: no tools, ever
- **WHEN** the brain builds a request body
- **THEN** it has no `tools`, `functions` or `tool_choice` keys

### Requirement: Structured output
The brain SHALL request `response_format: { type: "json_schema", strict: true }` with the Classification schema and SHALL validate the response against the same schema locally. An invalid or unparsable response SHALL be retried once, then surfaced as a `brain_error` (never treated as actionable).

#### Scenario: structured output
- **WHEN** the endpoint returns text that is not valid JSON twice
- **THEN** the brain returns a `brain_error` and core replies that it could not understand, with no card

### Requirement: Classification shape
The Classification SHALL contain: `intent` (task_request | question | fyi | chitchat | needs_clarification), `addressed_to_owner` (bool: the message asks something of the owner, their team, Lekam or the agents, rather than only mentioning the owner while talking to someone else), `actionable` (bool), `confidence` (0–1), `urgent` (bool), `reply_to_user` (string|null), `brief` ({ summary, skill|null, repo|null, outward_actions[], notes }), `followup` (in_scope | scope_change | not_for_agent | null), `clarifying_question` (string|null).

#### Scenario: classification shape
- **WHEN** the endpoint returns an object missing `confidence`
- **THEN** local validation rejects it and the retry path runs

### Requirement: Catalogue in the prompt
The system prompt SHALL include a catalogue of (a) skills: name + description read from each configured skills directory's `*/SKILL.md` frontmatter, (b) repositories: name, path/URL, default branch from config, (c) outward actions: ids and human labels from config. The catalogue SHALL be built at startup and on `lekam catalogue` and SHALL be truncated to `brain.catalogue_max_chars` (default 16000) with a logged warning. A `catalogue.md` file in config, when present, SHALL replace the auto-generated skills section.

#### Scenario: skill proposes outward actions
- **WHEN** a skill's frontmatter declares `lekam_outward_actions: [jira_comment, pr_create]`
- **THEN** a brief that selects that skill lists those actions in `brief.outward_actions`

### Requirement: Persona and tone rules
The system prompt SHALL begin with the contents of `persona.md`. The shipped default persona SHALL instruct: lead with the answer; one or two sentences; never narrate process; no emoji in text (state is shown by reactions); kind and direct; light humour only when the moment is relaxed; never promise owner decisions ("I've asked <owner>"); match the asker's register.

#### Scenario: persona and tone rules
- **WHEN** the service starts
- **THEN** the system prompt begins with the exact contents of `persona.md`

### Requirement: Confidence threshold
Config `brain.threshold` (default 0.7) SHALL be applied by core: an `owner_mention` becomes a card only if `addressed_to_owner` is not false, `intent` is `task_request` or `question`, `actionable`, and `confidence >= threshold`. Self-tags and captured DMs are addressed to the owner by definition. A `bot_mention` with `intent = task_request`, or an actionable `question` (one that needs tools or live data to answer), SHALL always become a card, flagged "low confidence" when below threshold.

#### Scenario: confidence threshold
- **WHEN** an owner_mention is classified actionable with confidence 0.6 and threshold is 0.7
- **THEN** no card is sent and an audit row `below_threshold` is written

#### Scenario: a tag is not an ask
- **WHEN** Markand posts "@Preethi need your help converting OP-316" and then, in the same thread, "@Faraj & I tried, but looks like we dont have access"
- **THEN** the brain returns `addressed_to_owner: false`, no card is sent and an audit row `not_addressed_to_owner` is written

#### Scenario: actionable question to the owner
- **WHEN** an owner_mention "what did your team do today" is classified `question`, actionable, confidence 0.85
- **THEN** a card is sent with a brief to find out and report back

### Requirement: Recent outcomes as context
The prompt SHALL include up to `brain.recent_outcomes` (default 10) one-line summaries of recently completed requests so the brain can answer "did X get done" without tools.

#### Scenario: recent outcomes as context
- **WHEN** ten requests have completed
- **THEN** the system prompt lists the ten most recent as one line each

### Requirement: Cost and token accounting
Every call SHALL record model, prompt/completion tokens and reported cost (if present in the response) to the audit log.

#### Scenario: cost and token accounting
- **WHEN** a classification call returns `usage`
- **THEN** an audit row `brain_call` records model, prompt_tokens, completion_tokens and cost when present

### Requirement: Model selection
Config SHALL allow `brain.classify_model` and `brain.brief_model`; when they differ, the brief step is a second call with the same contract. Default is one model for both.

#### Scenario: model selection
- **WHEN** `brief_model` differs from `classify_model`
- **THEN** a task_request results in two calls, the second using `brief_model`

