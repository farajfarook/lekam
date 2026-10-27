// Pure decision function: (message, existing request, classification, config) -> Decision.
// Decisions are data; service.mjs executes them. Nothing here has side effects.

/** Decision shapes:
 *  { type: 'ignore', reason }
 *  { type: 'reply', text }                       // bot says something, no request
 *  { type: 'card', kind, lowConfidence }         // create request + send owner card
 *  { type: 'forward', text }                     // send follow-up to live session
 *  { type: 'forward_or_card', text }             // scope change on follow-up
 *  { type: 'clarify', question }
 */

export function forcesCard(text, config) {
  if (!text) return false;
  if (config.approvals.outward_actions_mode !== 'all') for (const re of config.approvals.force_card_regexes ?? []) if (re.test(text)) return true;
  for (const r of config.repos ?? []) if (new RegExp(`\\b${escape(r.name)}\\b`, 'i').test(text)) return true;
  return false;
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function decideNew(message, cls, config) {
  const { kind } = message; // bot_mention | owner_mention
  // Brain unavailable: don't drop the message and don't guess. The owner gets a card with the raw text.
  if (!cls) return { type: 'card', kind, lowConfidence: true, brainDown: true };
  const low = cls.confidence < config.brain.threshold;
  // A question an agent needs tools to answer ("what did the team do today") is work, like a task.
  const toolQuestion = cls.intent === 'question' && cls.actionable;
  if (kind === 'owner_mention' && message.self) {
    // The owner tagged themselves: they are certainly asking. Card any work or lookup (flag low confidence), else stay quiet.
    if (cls.intent === 'task_request' || toolQuestion) return { type: 'card', kind, lowConfidence: low };
    return { type: 'ignore', reason: `self_tag_${cls.intent}` };
  }
  if (kind === 'owner_mention') {
    // A tag is not an ask: "@Faraj & I tried" in a thread asking Preethi mentions the owner but is for Preethi.
    // A DM to the owner is addressed to them by definition.
    if (cls.addressed_to_owner === false && !message.dm) return { type: 'ignore', reason: 'not_addressed_to_owner' };
    if ((cls.intent === 'task_request' || toolQuestion) && cls.actionable && !low) return { type: 'card', kind, lowConfidence: false };
    return { type: 'ignore', reason: low ? 'below_threshold' : `intent_${cls.intent}` };
  }
  // bot_mention
  if (toolQuestion) return { type: 'card', kind, lowConfidence: low };
  switch (cls.intent) {
    case 'task_request': return { type: 'card', kind, lowConfidence: low };
    case 'needs_clarification': return { type: 'clarify', question: cls.clarifying_question ?? 'Could you say a bit more about what you need?' };
    default: return cls.reply_to_user ? { type: 'reply', text: cls.reply_to_user } : { type: 'ignore', reason: `intent_${cls.intent}` };
  }
}

export function decideFollowup(message, request, cls, config) {
  const isOwner = message.user === request.owner;
  if (isOwner) {
    // In the channel the owner is talking to people. The agent only hears them when they tag Lekam (or tag
    // themselves to ask Lekam); steering happens in the DM session thread, which never comes through here.
    if (message.kind === 'bot_mention' || message.self) return { type: 'forward', text: message.text };
    return { type: 'ignore', reason: 'owner_untagged' };
  }
  if (!request.scope) return { type: 'ignore', reason: 'not_yet_approved' }; // pending: wait for the owner
  if (forcesCard(message.text, config)) return { type: 'forward_or_card', text: message.text, reason: 'forced_pattern' };
  if (!cls) return { type: 'forward_or_card', text: message.text, reason: 'brain_error' };
  // In a thread where someone asked the owner, only the owner speaks (through Post as owner); Lekam never chimes in as itself.
  if (cls.followup === 'not_for_agent' && request.kind === 'owner_mention') return { type: 'ignore', reason: 'owner_thread_not_for_agent' };
  if (cls.followup === 'not_for_agent') return cls.reply_to_user ? { type: 'reply', text: cls.reply_to_user } : { type: 'ignore', reason: 'not_for_agent' };
  if (cls.followup === 'scope_change' || request.approval_mode === 'once') return { type: 'forward_or_card', text: message.text, reason: cls.followup === 'scope_change' ? 'scope_change' : 'approve_once' };
  return { type: 'forward', text: message.text };
}

/** A reply in a thread an external session is waiting on (thread watch). Only acknowledgements are dropped; no
 *  confidence threshold: the owner's own session asked for these replies. Brain down -> card. */
export function decideWatchReply(cls) {
  if (!cls) return { type: 'card', reason: 'brain_unavailable' };
  if (cls.intent === 'chitchat' && !cls.actionable) return { type: 'ignore', reason: 'acknowledgement' };
  return { type: 'card', reason: `intent_${cls.intent}` };
}
