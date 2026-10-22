// Assemble the brain's system prompt and user turn. Pure functions.
const OUTPUT_RULES = `
## How to answer
Return ONLY a JSON object matching the schema you were given. Field guidance:
- intent: task_request (someone wants work done), question (wants information), fyi, chitchat, needs_clarification (a task, but too vague to brief).
- actionable: true only if an agent with tools could usefully do the work. Questions answerable from the thread are not actionable. Questions that need live data (Jira, GitHub PRs, Slack, standups, Datadog, "what did the team do today", "status of OP-123") ARE actionable: you cannot answer them yourself, an agent can.
- kind=owner_mention: someone tagged the owner, or the owner tagged themselves to ask Lekam. Treat a request or actionable question addressed to the owner or "your team" as work for the owner's agents.
- confidence: how sure you are that this is a real request for the owner's agents (0-1).
- urgent: outages, production incidents, "everyone", "down", "since X minutes".
- reply_to_user: what the bot says in the thread, in persona, or null to say nothing. For kind=owner_mention this is ignored (the bot stays silent) - set null.
- brief: for task_request, and for actionable questions (summary = what to find out and report back). Otherwise null. summary = ONE plain sentence, at most 25 words, that the owner can read at a glance and an agent can act on, written as work to do and findings to report back (no lists of sources or tools) (never "post", "reply" or "message" anyone: the agent reports to Lekam, which delivers it); skill = exact skill name from the catalogue or null; repo = exact repo name from the catalogue or null; outward_actions = ids from the catalogue the task would need (only those); notes = assumptions you made, at most one short sentence (empty string if none), no user or channel ids, nothing already in the summary.
- Resolve typos and shorthand against the catalogue (e.g. "ownwr pryal" -> owner-portal) and say so in notes.
- reply_to_user is at most two short sentences. Do not explain what you cannot do unless asked.
- You never offer to ask the owner and then wait for a yes. If the message needs an agent (work or a lookup), classify it task_request (or an actionable question) now: the owner is asked automatically, and reply_to_user says only that you've asked them.
- A short reply to Lekam's own last message ("ok", "yes", "go ahead", or the details Lekam asked for, like "ai and portal team for last 1 month") continues that conversation: read the thread and classify the combined request. If it is work or a lookup, it is a task_request with a brief built from the whole thread, not chitchat.
- followup: only for kind=followup. in_scope = continues the approved scope; scope_change = needs new repo, new outward action, deployment, or anything beyond the approved brief; not_for_agent = thanks/chit-chat/question you can answer yourself.
- clarifying_question: for needs_clarification, one short question. Otherwise null.
Never include text outside the JSON. Never invent skills, repos or action ids that are not in the catalogue.`;

export function systemPrompt({ persona, catalogue, outcomes = [], ownerName = 'the owner' }) {
  const parts = [persona.trim(), `\nThe owner is ${ownerName}. Refer to them by that name.`, '\n# Catalogue\n' + catalogue];
  if (outcomes.length) parts.push('\n## Recent completed requests (for "did X get done" questions)\n' + outcomes.map((o) => `- ${o}`).join('\n'));
  parts.push(OUTPUT_RULES);
  return parts.join('\n');
}

/** Build the user turn as JSON. `thread` is an array of {user, text, ts} newest last. */
export function userTurn({ kind, requester, channel, text, thread = [], approvedScope = null, ownerName }) {
  return JSON.stringify({
    kind, requester, channel, // display names, never ids
    owner: ownerName,
    approved_scope: approvedScope,
    thread_excerpt: thread.map((m) => ({ user: m.user, text: m.text })),
    text,
  });
}
