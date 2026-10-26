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
- **THEN** core receives `{ kind: "bot_mention", channel, ts, thread_ts: ts, user, text: "fix the export" }` with the bot's own mention removed

#### Scenario: mention inside an existing thread
- **WHEN** the mention is a reply inside a thread
- **THEN** `thread_ts` is the parent message's ts, so the request is keyed on the existing thread

### Requirement: Trigger on owner mention
The adapter SHALL emit an `owner_mention` message when a non-bot user mentions a configured owner's Slack id in a channel the bot is in. An owner mentioning themselves emits an `owner_mention` with `self: true`: replies go out as the owner like any owner tag, but core never drops it for low confidence (work or lookups always card; anything else is ignored quietly). An owner mentioning a different owner emits nothing. The adapter SHALL NOT react or reply in the channel for an `owner_mention`.

#### Scenario: owner tagged by a teammate
- **WHEN** Ting posts `<@OWNER> the export is blank` in #team
- **THEN** core receives `{ kind: "owner_mention", owner: OWNER, ... }` and nothing is posted or reacted in #team

#### Scenario: owner tags themselves
- **WHEN** OWNER posts `<@OWNER> what did your team do today` in #team
- **THEN** core receives `{ kind: "owner_mention", owner: OWNER, self: true, ... }`

#### Scenario: owner tags another owner
- **WHEN** OWNER posts `<@OWNER2> look at this`
- **THEN** no `owner_mention` is emitted

### Requirement: Follow-ups in engaged threads
The adapter SHALL emit a `followup` message for any non-bot reply in a thread that core reports as engaged (has a request record not in a terminal state), without requiring a mention.

#### Scenario: follow-ups in engaged threads
- **WHEN** a requester replies in a thread whose request is RUNNING, without mentioning anyone
- **THEN** core receives `{ kind: "followup" }` for that thread

### Requirement: Ignore noise
The adapter SHALL ignore messages from bots (including itself), message subtypes `message_changed`, `message_deleted`, `channel_join`, `channel_leave`, `bot_message`, messages Lekam itself posted with an owner's user token (their `app_id` is Lekam's), and messages that contain nothing but mentions. Edited messages SHALL NOT re-trigger.

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
The adapter SHALL expose `fetchThread(channel, thread_ts, limit)` returning recent messages (user, text, ts) for the brain's context, capped by `brain.thread_context_messages` (default 20), with mentions rendered as in *Mentions are rendered, not deleted*.

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


### Requirement: Captured DMs to an owner
When an owner sets `capture_dms: true` and has a user token with `im:history` (user event `message.im`), a 1:1 DM someone else sends that owner SHALL be emitted as an `owner_mention` with `dm: true`, exactly like tagging the owner (silent card, replies post as the owner after approval). The owner's own messages in those DMs SHALL be ignored. Lekam's own DMs (readable with the bot token) SHALL keep their `bot_mention` behaviour. Captured DMs SHALL NOT count towards the sender's rate limit.

#### Scenario: colleague DMs the owner
- **WHEN** Ting DMs Faraj "is the build green?" and Faraj captures DMs
- **THEN** Faraj gets a card "Ting messaged you directly", and after Delegate and Post the answer appears in that DM from Faraj's account

### Requirement: Mentions are rendered, not deleted
Message text passed to core (and thread text from `fetchThread`) SHALL render `<@ID>` as `@Display Name`, channel references as `#name`, `<!here>`-style broadcasts as `@here`, and SHALL unescape `&amp;`, `&lt;`, `&gt;`. Only the bot's own mention on the triggering message is removed. Who a message is addressed to is part of its meaning: deleting tags turned "@Preethi need your help" into "need your help" and "@Faraj & I tried" into "& I tried", and the owner was asked to act on a conversation between two other people.

#### Scenario: owner mentioned as a participant
- **WHEN** Markand replies `<@OWNER> &amp; I tried, but we don't have access` in a thread whose parent is `<@PREETHI> need your help converting OP-316`
- **THEN** core receives the text `@Faraj Farook & I tried, but we don't have access` and the thread text `@Preethi Prakash need your help converting OP-316`

### Requirement: Posts made through other apps
A message carrying an `app_id` and no `client_msg_id` was posted by an app with the author's user token, not typed by them. The adapter SHALL mark it `via_app: <app_id>` so core can tell it apart from the owner typing.

#### Scenario: agent posts as the owner
- **WHEN** an agent's Slack tool posts in a request thread with the owner's user token
- **THEN** core receives the message with `via_app` set and does not treat it as the owner talking
