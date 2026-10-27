# Spec Delta

## MODIFIED Requirements

### Requirement: Watch registration

A watch SHALL be registrable from two sources with identical effect: automatic detection of a session post (see `session-post-detection`) and the `lekam watch` command. Both take: channel, thread timestamp, the waiting agent's id, the host name of the daemon it runs on, an optional title, and an optional owner (default: the first configured owner). The command SHALL NOT require any secret and SHALL be usable from another host over SSH.

- Registering a thread that already has an active watch for the same agent renews it (new expiry); for a different agent it replaces it (the old watch is marked superseded).
- A renew-only registration renews an existing watch for that thread and agent and otherwise does nothing.
- A host name that is not configured is rejected with a clear error.
- The thread timestamp's message counts as already seen: only later messages are replies.
- Unregister ends the watch (state stopped). Listing shows active watches with expiry and how each was registered.

#### Scenario: Renewal by a later post
- **WHEN** agent A is watching thread T and A registers T again
- **THEN** there is still one active watch for T, owned by A, with its expiry moved to now + TTL

#### Scenario: Takeover
- **WHEN** agent A is watching thread T and agent B registers T
- **THEN** B's watch is active and A's is superseded

### Requirement: Forwarding to the waiting session

On Forward, Lekam SHALL send the replies to the watch's agent through its daemon connection for the watch's host (see Hosts), as a new turn:

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

## ADDED Requirements

### Requirement: Hosts are daemon connections

`watches.hosts` SHALL map a host name to a daemon target: `local` (the local daemon), a `ws://`/`wss://` URL, or an `ssh://user@host[:port][?daemonPort=N]` target reached through an SSH tunnel. Lekam SHALL keep one connection per host, reconnect on failure, and need no `paseo` binary. Other values SHALL be rejected at config load with a message naming the key. `lekam check` SHALL report each host as reachable or not.

#### Scenario: Remote host over SSH
- **WHEN** a watch's host is configured as `ssh://user@box`
- **THEN** status, wait and send for that watch go through a tunnel to that box's daemon, and a tunnel failure is reported on the card as the reason
