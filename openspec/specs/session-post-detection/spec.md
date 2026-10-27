# session-post-detection Specification

## Purpose
Find the agent session behind a Slack post made with the owner's account, by matching the post to a tool call in a Paseo agent's timeline, and register a thread watch for that session without any hook in the agent.

## Requirements

### Requirement: Owner posts are candidates

Every message authored by an owner in a conversation Lekam can hear (channels it is in; DMs captured with the owner's token) SHALL be a detection candidate, except messages Lekam posted itself, messages that mention Lekam, and self-tags (which keep their existing handling). Lekam SHALL NOT rely on Slack's app markers (`app_id`, missing `client_msg_id`, a footer) to decide that a session posted; they are hints only.

#### Scenario: The owner types in a channel
- **WHEN** the owner types a message in a channel and no agent produced it
- **THEN** detection finds no match, nothing is registered, and nothing is posted or sent to the owner

### Requirement: Matching a post to a session

Lekam SHALL look for the post among the recent tool calls of agents that were active shortly before the post, on every configured daemon:

- An agent is a candidate when it is not archived, was updated within the detection lookback (default 10 minutes) of the post, and carries none of the skip labels (default: Lekam's own sessions and scheduled runs).
- A tool call matches when its name matches the configured send-tool pattern and its output contains the post's exact message timestamp (as `message_ts` or in a permalink). Nested calls (a tool run from inside another tool, such as a script runner) count.
- Fallback: a send-tool call whose input text, normalised, equals the post's text, whose target conversation agrees (channel id, or a user id for a DM), and which completed within two minutes of the post.
- Detection runs a few seconds after the post and retries twice with growing delays, because the tool's output may not be in the timeline yet.
- Exactly one agent wins: the first exact match; else the first fallback match. Two exact matches for the same timestamp cannot happen.

#### Scenario: Sent from inside a script tool
- **WHEN** an agent sends the message through a script tool that calls the Slack tool
- **THEN** the nested Slack call's output contains the timestamp and the agent is matched

#### Scenario: Output not yet recorded
- **WHEN** the post event arrives before the tool's output is in the timeline
- **THEN** a later retry matches it and the watch is registered with the original post's timestamp

#### Scenario: Scheduled run
- **WHEN** the matching agent carries the scheduled-run label
- **THEN** no watch is registered and the match is audited as skipped

### Requirement: Registration from a match

A match SHALL register a watch exactly as `lekam watch` would: channel, thread (the post's thread, or the post itself when top-level; the DM conversation for DMs), the agent id, the host name of the daemon it was found on, the agent's title, and the post's timestamp as already seen. A post that tags someone other than the owner (a user, user group, @here/@channel) or is a DM expects a reply and creates or renews the watch; any other post is renew-only. A match for an agent that already has a live Lekam request is ignored.

#### Scenario: Plain follow-up post by the session
- **WHEN** a watched session posts again in its thread without tagging anyone
- **THEN** the existing watch is renewed and no new watch is created elsewhere

### Requirement: Unmatched posts

A candidate with no match after the retries SHALL be audited (with the Slack hints) and otherwise ignored. If a daemon cannot be reached during detection, Lekam SHALL audit it, continue with the other daemons, and SHALL NOT tell the owner for each post; `lekam check` reports unreachable daemons.

#### Scenario: One daemon down
- **WHEN** a configured remote daemon is unreachable and the local daemon has the matching agent
- **THEN** the watch is registered for the local agent and the remote failure is audited
