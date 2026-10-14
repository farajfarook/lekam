// Assemble the brain's system prompt and user turn. Pure functions.
const OUTPUT_RULES = `
## How to answer
Return ONLY a JSON object matching the schema you were given. Field guidance:
- intent: task_request (someone wants work done), question (wants information), fyi, chitchat, needs_clarification (a task, but too vague to brief).
- actionable: true only if an agent with tools could usefully do the work. Questions answerable from the thread are not actionable.
- confidence: how sure you are that this is a real request for the owner's agents (0-1).
- urgent: outages, production incidents, "everyone", "down", "since X minutes".
- reply_to_user: what the bot says in the thread, in persona, or null to say nothing. For kind=owner_mention this is ignored (the bot stays silent) - set null.
- brief: for task_request only. summary = one or two sentences an agent could act on; skill = exact skill name from the catalogue or null; repo = exact repo name from the catalogue or null; outward_actions = ids from the catalogue the task would need (only those); notes = assumptions and context worth passing on.
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
    kind, requester, channel,
    owner: ownerName,
    approved_scope: approvedScope,
    thread_excerpt: thread.map((m) => ({ user: m.user, text: m.text })),
    text,
  });
}
