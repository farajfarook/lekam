# Spec Delta

## Purpose
The store is the single source of truth for requests, their state, outcomes and an audit trail, so the service can restart safely and the owner can see what happened.

## ADDED Requirements

### Requirement: SQLite via node:sqlite
The store SHALL use `node:sqlite` with WAL mode, a single file at `store.path` (default `./lekam.db`), and forward-only migrations applied at startup.

#### Scenario: sqlite via node:sqlite
- **WHEN** the service starts against a missing db file
- **THEN** the file is created, WAL mode is on, and all migrations are applied

### Requirement: Request record
`requests` SHALL hold: `id`, `kind` (bot_mention|owner_mention), `channel`, `thread_ts`, `origin_ts`, `requester`, `owner`, `state`, `request_text`, `classification` (JSON), `brief` (JSON), `scope` (JSON|null), `approval_mode` (task|once|null), `card` ({channel, ts}|null), `session_id`, `outcome` (JSON|null), `created_at`, `updated_at`, `expires_at`.

#### Scenario: request record
- **WHEN** a request is created from an owner_mention
- **THEN** the row has kind owner_mention, state NEW, and `expires_at` set from `ttl_owner_mention`

### Requirement: State machine
Allowed transitions SHALL be exactly: NEW→PENDING_APPROVAL, NEW→IGNORED, PENDING_APPROVAL→{APPROVED, INVESTIGATING, DENIED, EXPIRED}, APPROVED→RUNNING, INVESTIGATING→{RUNNING, DROPPED}, RUNNING→{DONE, FAILED}, DONE→{RELEASED, DISCARDED}. Any other transition SHALL throw and be audited.

#### Scenario: illegal transition
- **WHEN** code attempts DONE→RUNNING
- **THEN** the store throws `IllegalTransition` and writes an audit row `illegal_transition`

### Requirement: Thread lookup
`findByThread(channel, thread_ts)` SHALL return the most recent non-terminal request for that thread, else the most recent terminal one, else null.

#### Scenario: thread lookup
- **WHEN** a thread has a DONE request and a newer PENDING_APPROVAL one
- **THEN** `findByThread` returns the PENDING_APPROVAL one

### Requirement: Event dedupe
`seen(event_id)` SHALL return true if the id was recorded in the last 24h, otherwise record it and return false. Expired rows SHALL be pruned hourly.

#### Scenario: event dedupe
- **WHEN** `seen(id)` is called twice within 24h
- **THEN** it returns false then true

### Requirement: Audit log
`audit(type, request_id|null, data)` SHALL append `{ ts, type, request_id, actor, data }` as JSON. Audit rows SHALL never be updated or deleted by the service. Secrets SHALL never be written to audit.

#### Scenario: audit log
- **WHEN** any audit row is written with data containing a value equal to a configured secret
- **THEN** the value is replaced with `[redacted]` before writing

### Requirement: Outcomes feed
`recentOutcomes(n)` SHALL return the last n DONE/RELEASED requests as one-line summaries (date, requester, brief summary, first line of outcome) for the brain prompt.

#### Scenario: outcomes feed
- **WHEN** `recentOutcomes(3)` is called
- **THEN** it returns at most three lines, newest first, each under 200 characters

### Requirement: Sessions table
`sessions` SHALL map `request_id` → `session_id`, `status`, `started_at`, `finished_at` so a dead session can be detected without asking the daemon.

#### Scenario: sessions table
- **WHEN** a session is started and later finishes
- **THEN** the row shows `started_at` and `finished_at` and status finished

