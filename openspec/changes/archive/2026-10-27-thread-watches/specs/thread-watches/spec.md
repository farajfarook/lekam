# Spec Delta

## Purpose

Let an agent session that Lekam did not start wait on a chat thread: replies in that thread come to the owner as a card, and only the owner's tap sends them back to the waiting session.

## ADDED Requirements

### Requirement: Watch registration

A caller SHALL be able to register a watch with: channel, thread timestamp, the waiting agent's id, the host name of the daemon it runs on, an optional title, and an optional owner (default: the first configured owner). Registration SHALL NOT require any secret and SHALL be usable from another host over SSH.

- Registering a thread that already has an active watch for the same agent renews it (new expiry); for a different agent it replaces it (the old watch is marked superseded).
- A renew-only registration renews an existing watch for that thread and agent and otherwise does nothing.
- A host name that is not configured is rejected with a clear error.
- The thread timestamp's message counts as already seen: only later messages are replies.
- Unregister ends the watch (state stopped). Listing shows active watches with expiry.

#### Scenario: Renewal by a later post
- **WHEN** agent A is watching thread T and A registers T again
- **THEN** there is still one active watch for T, owned by A, with its expiry moved to now + TTL

#### Scenario: Takeover
- **WHEN** agent A is watching thread T and agent B registers T
- **THEN** B's watch is active and A's is superseded

### Requirement: Routing replies in watched conversations

A message in a watched thread (channel threads) or a watched DM conversation (any later message in that DM) SHALL be routed as follows:

- From the owner, typed by the owner: ignored (the owner is talking to people).
- From the owner via another app (the waiting agent's own post): ignored apart from bookkeeping; never treated as a reply.
- From Lekam itself or any bot: ignored.
- A message that mentions Lekam: handled by the normal bot-mention flow.
- If the thread also has a live Lekam request (pending approval, approved, investigating or running), the existing follow-up flow handles it.
- Otherwise, from anyone else, including a message that tags the owner: it is a watch reply. It does not go through the owner-tag or new-request flows.

#### Scenario: A tag of the owner in a watched thread
- **WHEN** someone writes "@Owner I've approved your PR" in a watched thread
- **THEN** no owner-tag decision is made and the message is handled as a reply to the watch

#### Scenario: The waiting agent posts again
- **WHEN** the owner's account posts in a watched thread through another app
- **THEN** no card is created

### Requirement: Classifying watch replies

Each watch reply SHALL be classified by the brain with the waiting session's title as context. Replies that are only acknowledgement or chit-chat (thanks, emoji, "ok", "will do") with nothing to act on SHALL be dropped silently (audited). Every other reply, and every reply when the brain is unavailable, SHALL go to the owner. Confidence thresholds SHALL NOT drop watch replies.

#### Scenario: Thanks is dropped, an approval is not
- **WHEN** one reply says "thanks!" and another says "I have approved your PR"
- **THEN** the first produces no card and the second produces a card

### Requirement: Watch card and owner gate

A reply that goes to the owner SHALL produce a card in the owner's DMs showing: who replied and where (with a link to the message), the reply quoted verbatim, the waiting session (title, host, link), and the buttons Forward, Ignore and Stop watching.

- While a card for a watch is pending, further replies are added to the same card rather than creating new ones.
- Later cards for the same watch are posted in the DM thread of its first card, mentioning the owner.
- Only the watch's owner can act on a card; anyone else gets "Not yours to approve." and nothing happens.
- Text, reactions and timeouts never forward.
- Forward sends every pending reply on that card; Ignore drops them; Stop watching drops them and ends the watch.

#### Scenario: Two replies before the owner looks
- **WHEN** two replies arrive in a watched thread and the owner has not acted on the first card
- **THEN** there is one card listing both replies, and Forward sends both in one turn

#### Scenario: Someone else presses Forward
- **WHEN** a user who is not the watch's owner presses Forward
- **THEN** nothing is sent to the session and the attempt is audited

### Requirement: Forwarding to the waiting session

On Forward, Lekam SHALL send the replies to the watch's agent on the watch's host as a new turn:

- The text marks each reply as quoted from a named person in the thread, not from the owner, with the thread link, and tells the agent it grants no new permissions; it cannot contain or forge an owner-message block.
- If the session is in the middle of a turn, Lekam waits for it to go idle and then sends; it never interrupts or steers a running turn.
- If the session is archived or cannot be reached, nothing is sent and the card says why.
- Turns to the same watch are sent one at a time.
- A successful forward renews the watch and updates the card ("Forwarded").

#### Scenario: Busy session
- **WHEN** the owner presses Forward while the session is running a turn
- **THEN** Lekam waits for the session to become idle and only then sends the replies

#### Scenario: Archived session
- **WHEN** the owner presses Forward and the session is archived
- **THEN** nothing is sent and the card says the session is archived

### Requirement: Expiry

A watch SHALL expire when it has had no renewal for the configured TTL (default 3 days). Expired, stopped and superseded watches receive no further replies. Cards already showing pending replies stay actionable.

#### Scenario: Reply after expiry
- **WHEN** a watch's TTL has passed without renewal and someone replies in the thread
- **THEN** no card is created for that reply

### Requirement: Catch-up and access

Lekam SHALL re-read active watched conversations for messages newer than the last one it saw: soon after a watch is registered, periodically, and at start-up. Messages found this way are handled exactly like live ones, and a message is never handled twice (live and caught up). If Lekam cannot read a watched conversation, the watch SHALL be marked no-access and the owner told once, naming the conversation and how to fix it (invite Lekam).

#### Scenario: Reply while Lekam was disconnected
- **WHEN** a reply was posted in a watched thread while Lekam was not connected
- **THEN** the next catch-up handles it as a reply, and a later live delivery of the same message does nothing

#### Scenario: Lekam is not in the channel
- **WHEN** a watch is registered on a channel Lekam is not a member of
- **THEN** the watch is marked no-access and the owner gets one DM saying to invite Lekam
