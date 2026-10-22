# Spec Delta

## Purpose
The approval gate is the product's security boundary. It presents the owner with exactly what would run, accepts only unforgeable approvals, and defaults to deny.

## ADDED Requirements

### Requirement: Card contents
An approval card SHALL be short enough to read at a glance: one **Plan** line (the brief summary, plus skill/repo when set) ending in a link to the original message, at most two earlier thread messages when the request refers back, the outward actions as checkboxes only in `ask` mode when some are proposed, an urgent / "unsure this is a request" flag only when it applies, and the buttons. For a channel message the card SHALL NOT repeat the requester, channel or request text: Slack's own unfurled preview of the linked message shows them verbatim. When no preview is possible (a DM to Lekam, or no permalink) the card SHALL instead name the requester and quote the verbatim request text. Notes, confidence and the request id SHALL NOT be shown on the card (notes are visible in Edit brief; the rest is in the audit log).

#### Scenario: card contents
- **WHEN** the brain proposes a brief for a request whose text is `fix the export <script>`
- **THEN** the card shows the Plan line with a thread link that Slack previews as the original message; for a DM to Lekam the card quotes that exact text, unmodified

### Requirement: Actions
A card for a `bot_mention` SHALL offer: **Approve task**, **Approve once**, **Discuss first**, **Edit brief**, **Decline**. A card for an `owner_mention` SHALL offer: **Delegate**, **Delegate (no outward actions)**, **Discuss first**, **Edit brief**, **Ignore**.

#### Scenario: actions
- **WHEN** a card is built for kind `owner_mention`
- **THEN** its buttons are exactly Delegate, Delegate (no outward actions), Discuss first, Edit brief, Ignore, with `request_id` in each action value

### Requirement: Only owners can act
An action SHALL be honoured only if the acting Slack user id equals the request's assigned owner. Any other actor SHALL receive an ephemeral "not yours to approve" and the action SHALL be audited as `approval_rejected_identity`.

#### Scenario: requester clicks approve on a forwarded card
- **WHEN** a non-owner somehow invokes action `approve_task` for request R
- **THEN** state is unchanged, the actor gets an ephemeral refusal, and an audit row is written

### Requirement: Text and reactions are not approvals
Core SHALL NOT transition a request out of PENDING_APPROVAL on any message text, reaction, or non-interactive event.

#### Scenario: text and reactions are not approvals
- **WHEN** the owner replies `approved` in the thread or adds ✅ to the message
- **THEN** the request stays PENDING_APPROVAL and no session is created

### Requirement: Expiry defaults to deny
A card SHALL expire after `approvals.ttl_bot_mention` (default 24h) or `approvals.ttl_owner_mention` (default 4h). On expiry the request becomes EXPIRED, the card is updated to say so, and nothing is posted in the channel.

#### Scenario: expiry defaults to deny
- **WHEN** an `owner_mention` card has had no action for `ttl_owner_mention`
- **THEN** the request is EXPIRED, the card text reads Expired, no session exists and nothing was posted in the channel

### Requirement: Card updates in place
After any action the card SHALL be edited in place to show the outcome and time ("Approved task 14:32", "Ignored 09:14", "Expired"). Buttons SHALL be removed from an actioned card.

#### Scenario: card updates in place
- **WHEN** the owner clicks Approve task at 14:32
- **THEN** the same DM message is edited to show `Approved task 14:32` and has no buttons

### Requirement: Scope
Approving SHALL record `scope = { brief, outward_actions }` on the request. Follow-ups classified `in_scope` SHALL be forwarded without a card when the approval was *task*; every follow-up SHALL produce a card when the approval was *once*.

#### Scenario: scope change forces a card
- **WHEN** a follow-up is classified `scope_change`, or its text matches any `approvals.force_card_patterns` (default: repo names from config, `\bPR\b`, `deploy`, `merge`, `prod`, `jira`, `email`, `delete`)
- **THEN** a new card is sent to the owner and the follow-up is not forwarded until approved

#### Scenario: owner writes in the thread
- **WHEN** the follow-up author is the request's owner
- **THEN** it is forwarded to the session without a card

### Requirement: Decline and ignore wording
Decline (bot_mention) SHALL post one short line in the thread and set 🚫. Ignore (owner_mention) SHALL post nothing.

#### Scenario: decline and ignore wording
- **WHEN** the owner clicks Decline on a bot_mention card
- **THEN** one short line is posted in the thread, the origin message shows 🚫, and no second message follows

### Requirement: Edit brief
**Edit brief** SHALL open a modal with the brief summary, notes and outward-action checkboxes; submitting SHALL store the edited brief and present the same card again with updated contents.

#### Scenario: edit brief
- **WHEN** the owner changes the summary and unticks `pr_create` in the modal
- **THEN** the stored brief reflects both edits and the re-rendered card shows them

### Requirement: Result release
When a session finishes, the owner SHALL receive a DM with the final report, a link to the original thread and **Post to thread** / **Discard**. Nothing is posted to the thread without that second owner action; there is no auto-post option.

### Requirement: Who speaks in the thread
Replies on a `bot_mention` SHALL be posted as Lekam. Owner-approved posts on an `owner_mention` (the pickup line and the released result) SHALL be posted as the owner when `owners[].user_token_env` names a valid Slack user token (user scope `chat:write`) belonging to that owner, and as Lekam otherwise; the result button then reads **Post to thread as <owner>**. Lekam's own automatic replies (persona answers, rate-limit and failure lines) SHALL always post as Lekam. Messages posted as the owner SHALL NOT be read back as the owner talking. When the owner tagged themselves, no pickup line is posted. Before a result that will post as the owner is shown on the result card, the brain SHALL rewrite it in the owner's voice (`owners[].voice` / `voice_file`, else a friendly default: casual, Slack-style, at most two emoji), keeping every fact and link and dropping agent process narration; the card SHALL show exactly the text that will be posted, and the raw report stays in Paseo. If the rewrite fails the raw report is used. Every post as the owner SHALL end with a small context line "Sent using <Slack app name>" (plain text: no link, never an @-mention), unless `chat.owner_post_footer` is false. Results posted to a thread (as the owner or as Lekam) SHALL @-mention people from `people_file` / `people` wherever the text refers to them (owner-voice placeholders, exact full names, aliases, GitHub logins; never inside links or code), never the owner themselves, and the result card SHALL show the tagged text.

#### Scenario: owner tag answered as the owner
- **WHEN** Ting tags the owner, the owner delegates and later presses Post to thread, and a user token is configured
- **THEN** both "Looking into this, I'll reply here." and the report appear in the thread from the owner's account, and neither is forwarded to the agent as an owner follow-up

#### Scenario: result release
- **WHEN** a session finishes
- **THEN** the owner receives the report by DM with Post to thread / Discard and the thread is untouched until Post is clicked

### Requirement: Rate limits
Core SHALL enforce `limits.per_user_per_hour` (default 10) new messages per requester (owners are exempt; refused messages are not counted) and `limits.pending_per_owner` (default 20) open cards; excess requests get a polite reply and no card.

#### Scenario: rate limits
- **WHEN** a requester has created `per_user_per_hour` requests in the last hour and mentions the bot again
- **THEN** the bot replies once that it is rate-limited for now, no card is sent, and an audit row `rate_limited` is written

