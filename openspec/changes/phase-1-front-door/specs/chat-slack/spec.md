# Spec Delta

## Purpose
The Slack adapter is how people reach Lekam. It decides which Slack events are worth looking at, keeps the bot quiet unless addressed or delegated, shows state with reactions, and renders replies and owner approval cards.

## ADDED Requirements

### Requirement: Connect via Socket Mode
The adapter SHALL connect with Slack Socket Mode using a bot token and an app-level token read from environment variables named in config. It SHALL NOT require a public URL. It SHALL reconnect automatically and log connection state changes.

#### Scenario: connect via socket mode
- **WHEN** the service starts with `LEKAM_SLACK_BOT_TOKEN` and `LEKAM_SLACK_APP_TOKEN` set
- **THEN** it connects over Socket Mode without any inbound port and logs `slack connected` with the bot user id

### Requirement: Listen only where invited
The adapter SHALL act only on events from conversations the bot is a member of. It SHALL log `member_joined_channel` and `member_left_channel` for the bot user at info level.

#### Scenario: listen only where invited
- **WHEN** a user mentions the owner in a channel the bot is not a member of
- **THEN** no event reaches core

### Requirement: Trigger on bot mention
The adapter SHALL emit a `bot_mention` message to core when the bot user is mentioned in a channel message or receives a direct message from a non-bot user.

#### Scenario: mention in a channel
- **WHEN** a user posts `<@BOT> fix the export` in a channel the bot is in
- **THEN** core receives `{ kind: "bot_mention", channel, ts, thread_ts: ts, user, text: "fix the export" }` with the mention stripped

#### Scenario: mention inside an existing thread
- **WHEN** the mention is a reply inside a thread
- **THEN** `thread_ts` is the parent message's ts, so the request is keyed on the existing thread

### Requirement: Trigger on owner mention
The adapter SHALL emit an `owner_mention` message when a non-bot, non-owner user mentions a configured owner's Slack id in a channel the bot is in. The adapter SHALL NOT react or reply in the channel for an `owner_mention`.

#### Scenario: owner tagged by a teammate
- **WHEN** Ting posts `<@OWNER> the export is blank` in #team
- **THEN** core receives `{ kind: "owner_mention", owner: OWNER, ... }` and nothing is posted or reacted in #team

#### Scenario: owner tags themselves or another owner
- **WHEN** the message author is any configured owner
- **THEN** no `owner_mention` is emitted

### Requirement: Follow-ups in engaged threads
The adapter SHALL emit a `followup` message for any non-bot reply in a thread that core reports as engaged (has a request record not in a terminal state), without requiring a mention.

#### Scenario: follow-ups in engaged threads
- **WHEN** a requester replies in a thread whose request is RUNNING, without mentioning anyone
- **THEN** core receives `{ kind: "followup" }` for that thread

### Requirement: Ignore noise
The adapter SHALL ignore messages from bots (including itself), message subtypes `message_changed`, `message_deleted`, `channel_join`, `channel_leave`, `bot_message`, and messages whose text is empty after stripping mentions. Edited messages SHALL NOT re-trigger.

#### Scenario: ignore noise
- **WHEN** Slack delivers a `message_changed` event for an earlier mention
- **THEN** no event reaches core

### Requirement: Acknowledge fast, dedupe retries
The adapter SHALL acknowledge every event before processing and SHALL pass Slack's `event_id` to core so duplicates are dropped by the store.

#### Scenario: acknowledge fast, dedupe retries
- **WHEN** Slack delivers the same `event_id` twice
- **THEN** the second delivery is acknowledged and dropped with an audit row `duplicate_event`

### Requirement: Reactions as status
The adapter SHALL expose `react(channel, ts, emoji)` and `unreact` so core can set exactly one status reaction on the originating message. Emoji names SHALL come from config with defaults 👀 `eyes`, ⚙️ `gear`, ✅ `white_check_mark`, 🚫 `no_entry_sign`, ❌ `x`, ❓ `question`.

#### Scenario: status transitions
- **WHEN** a request moves PENDING_APPROVAL → RUNNING → DONE
- **THEN** the originating message shows `eyes`, then only `gear`, then only `white_check_mark`

### Requirement: Post, DM and update
The adapter SHALL expose `post(channel, thread_ts, text|blocks)`, `dm(user, text|blocks) -> {channel, ts}`, and `update(channel, ts, blocks)` so cards can be edited in place rather than re-sent.

#### Scenario: post, dm and update
- **WHEN** core calls `dm(owner, blocks)`
- **THEN** the adapter returns the DM channel id and message ts so the card can later be updated

### Requirement: Thread context
The adapter SHALL expose `fetchThread(channel, thread_ts, limit)` returning recent messages (user, text, ts) for the brain's context, capped by `brain.thread_context_messages` (default 20).

#### Scenario: thread context
- **WHEN** a follow-up arrives in a 40-message thread
- **THEN** the brain receives at most `thread_context_messages` most recent messages

### Requirement: Interactive actions
The adapter SHALL route Block Kit `block_actions` payloads to core as `{ action_id, value, user, channel, message_ts }` and SHALL acknowledge them within Slack's 3-second limit. The adapter SHALL open a modal for "Edit brief" and route the submitted view to core.

#### Scenario: interactive actions
- **WHEN** the owner clicks a card button
- **THEN** the adapter acknowledges within 3 seconds and core receives `{ action_id, value, user, channel, message_ts }`

### Requirement: Required Slack scopes
The shipped manifest SHALL request exactly: `app_mentions:read`, `channels:history`, `channels:read`, `groups:history`, `groups:read`, `im:history`, `im:write`, `chat:write`, `reactions:write`, `reactions:read`, `users:read`, with Socket Mode enabled and events `app_mention`, `message.channels`, `message.groups`, `message.im`, `member_joined_channel`, `member_left_channel`.

#### Scenario: required slack scopes
- **WHEN** an operator installs the shipped manifest
- **THEN** the app requests the listed scopes and events and nothing broader

