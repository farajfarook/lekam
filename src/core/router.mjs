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
  if (!cls) return { type: 'reply', text: "I couldn't make sense of that just now. Try again in a moment." };
  const low = cls.confidence < config.brain.threshold;
  // A question an agent needs tools to answer ("what did the team do today") is work, like a task.
  const toolQuestion = cls.intent === 'question' && cls.actionable;
  if (kind === 'owner_mention') {
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
  if (isOwner) return { type: 'forward', text: message.text };
  if (!request.scope) return { type: 'ignore', reason: 'not_yet_approved' }; // pending: wait for the owner
  if (forcesCard(message.text, config)) return { type: 'forward_or_card', text: message.text, reason: 'forced_pattern' };
  if (!cls) return { type: 'ignore', reason: 'brain_error' };
  if (cls.followup === 'not_for_agent') return cls.reply_to_user ? { type: 'reply', text: cls.reply_to_user } : { type: 'ignore', reason: 'not_for_agent' };
  if (cls.followup === 'scope_change' || request.approval_mode === 'once') return { type: 'forward_or_card', text: message.text, reason: cls.followup === 'scope_change' ? 'scope_change' : 'approve_once' };
  return { type: 'forward', text: message.text };
}
