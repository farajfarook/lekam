// Approval card model <-> Slack Block Kit. Action ids are the contract with the adapter.
import { fmtTime } from './policy.mjs';

export const ACTIONS = Object.freeze({
  APPROVE_TASK: 'lekam_approve_task',
  APPROVE_ONCE: 'lekam_approve_once',
  DELEGATE: 'lekam_delegate',
  DELEGATE_NO_OUTWARD: 'lekam_delegate_no_outward',
  DISCUSS: 'lekam_discuss',
  EDIT: 'lekam_edit',
  DECLINE: 'lekam_decline',
  IGNORE: 'lekam_ignore',
  PROCEED: 'lekam_proceed',
  DROP: 'lekam_drop',
  POST_RESULT: 'lekam_post_result',
  DISCARD_RESULT: 'lekam_discard_result',
  OUTWARD_SELECT: 'lekam_outward_select',
});
export const EDIT_VIEW_ID = 'lekam_edit_brief';

const md = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const ctx = (...els) => ({ type: 'context', elements: els.map((t) => ({ type: 'mrkdwn', text: t })) });
const btn = (text, action_id, value, style) => ({ type: 'button', text: { type: 'plain_text', text }, action_id, value, ...(style ? { style } : {}) });
const quote = (s) => s.split('\n').map((l) => '> ' + l).join('\n');
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// The card is deliberately short: who/where + link, the request, one plan line, buttons.
// Notes, confidence and the request id live in Edit brief / the audit log, not on the card.
function headerBlocks({ request, requesterName, permalink, channelName, lowConfidence, excerpt = [] }) {
  const kind = request.kind === 'owner_mention' ? (request.requester === request.owner ? 'asked' : 'tagged you') : 'asked Lekam';
  const where = channelName ? '#' + channelName : 'a DM';
  const cls = request.classification ?? {};
  const flags = [cls.urgent ? ':rotating_light: urgent' : null, lowConfidence ? ':grey_question: unsure this is a request' : null].filter(Boolean);
  const head = `*${requesterName ?? request.requester}* ${kind} in ${permalink ? `<${permalink}|${where}>` : where}${flags.length ? ' · ' + flags.join(' · ') : ''}`;
  const blocks = [md(`${head}\n${quote(trunc(request.request_text, 600))}`)];
  if (excerpt.length) blocks.push(ctx('Earlier in the thread: ' + excerpt.slice(-2).map((m) => `${m.name}: ${trunc(m.text.replace(/\n+/g, ' '), 100)}`).join(' · ')));
  return blocks;
}

function briefBlocks({ request, config, selected }) {
  const b = request.brief ?? {};
  const extras = [b.skill ? `skill \`${b.skill}\`` : null, b.repo ? `repo \`${b.repo}\`` : null].filter(Boolean);
  const blocks = [md(`*Plan:* ${trunc(b.summary || '(none)', 300)}${extras.length ? `\n_${extras.join(' · ')}_` : ''}`)];
  const ids = Object.keys(config.outward_actions);
  const proposed = selected ?? b.outward_actions ?? [];
  const mode = config.approvals?.outward_actions_mode ?? 'ask';
  if (mode === 'all') {
    // nothing to show: every outward action is allowed
  } else if (mode === 'proposed') {
    if (proposed.length) blocks.push(ctx('May: ' + proposed.map((id) => config.outward_actions[id] ?? id).join(', ')));
  } else if (ids.length && proposed.length === 0) {
    // nothing proposed: the agent only reports back
  } else if (ids.length) {
    const options = ids.map((id) => ({ text: { type: 'plain_text', text: config.outward_actions[id] }, value: id }));
    const initial = options.filter((o) => proposed.includes(o.value));
    // Checkbox actions carry no `value`; the adapter reads the request id from the block_id.
    blocks.push({
      type: 'section', block_id: `lekam_outward|${request.id}`, text: { type: 'mrkdwn', text: '*Outward actions the agent may take:*' },
      accessory: { type: 'checkboxes', action_id: ACTIONS.OUTWARD_SELECT, options, ...(initial.length ? { initial_options: initial } : {}) },
    });
  }
  return blocks;
}

function buttonRow(request) {
  const v = request.id;
  const els = request.kind === 'owner_mention'
    ? [btn('Delegate', ACTIONS.DELEGATE, v, 'primary'), btn('Delegate, no outward actions', ACTIONS.DELEGATE_NO_OUTWARD, v), btn('Discuss first', ACTIONS.DISCUSS, v), btn('Edit brief', ACTIONS.EDIT, v), btn('Ignore', ACTIONS.IGNORE, v)]
    : [btn('Approve task', ACTIONS.APPROVE_TASK, v, 'primary'), btn('Approve once', ACTIONS.APPROVE_ONCE, v), btn('Discuss first', ACTIONS.DISCUSS, v), btn('Edit brief', ACTIONS.EDIT, v), btn('Decline', ACTIONS.DECLINE, v, 'danger')];
  return { type: 'actions', block_id: 'lekam_buttons', elements: els };
}

/** Pending approval card. */
export function approvalCard(args) {
  const { request } = args;
  return {
    text: `${args.requesterName ?? request.requester}: ${trunc(request.request_text, 120)}`,
    blocks: [...headerBlocks(args), ...briefBlocks(args), buttonRow(request)],
  };
}

/** Card after an action: same header + brief, outcome line, no buttons. */
export function actionedCard(args, outcomeText, extra = []) {
  const { request } = args;
  return {
    text: `${outcomeText} – ${trunc(request.request_text, 100)}`,
    blocks: [...headerBlocks(args), ...briefBlocks(args), ctx(`*${outcomeText}* ${fmtTime()}`), ...extra],
  };
}

export function investigatingCard(args, { agentLink }) {
  const { request } = args;
  return {
    text: `Investigating – ${trunc(request.request_text, 100)}`,
    blocks: [
      ...headerBlocks(args), ...briefBlocks(args),
      ctx(`*Investigating* ${fmtTime()} · ${agentLink ? `<${agentLink}|open in Paseo>` : 'session running'} · reply in this thread to talk to the agent, then *Proceed*`),
      { type: 'actions', block_id: 'lekam_buttons', elements: [btn('Proceed', ACTIONS.PROCEED, request.id, 'primary'), btn('Edit brief', ACTIONS.EDIT, request.id), btn('Drop', ACTIONS.DROP, request.id, 'danger')] },
    ],
  };
}

export function resultCard({ request, report, agentLink, permalink = null, postAs = null }) {
  const ask = trunc(request.request_text.replace(/\n+/g, ' '), 80);
  return {
    text: `Result: ${trunc(report, 100)}`,
    blocks: [
      ctx(`Result for ${permalink ? `<${permalink}|${ask}>` : ask}${agentLink ? ` · <${agentLink}|Paseo>` : ''}`),
      md(trunc(report, 2800)),
      { type: 'actions', block_id: 'lekam_result', elements: [btn(postAs ? `Post to thread as ${postAs}` : 'Post to thread', ACTIONS.POST_RESULT, request.id, 'primary'), btn('Discard', ACTIONS.DISCARD_RESULT, request.id)] },
    ],
  };
}

/** Modal for Edit brief. */
export function editBriefView({ request, config }) {
  const b = request.brief ?? { summary: '', notes: '', outward_actions: [] };
  const ids = Object.keys(config.outward_actions);
  const options = ids.map((id) => ({ text: { type: 'plain_text', text: config.outward_actions[id] }, value: id }));
  const initial = options.filter((o) => (b.outward_actions ?? []).includes(o.value));
  const blocks = [
    { type: 'input', block_id: 'summary', label: { type: 'plain_text', text: 'Brief' }, element: { type: 'plain_text_input', action_id: 'v', multiline: true, initial_value: b.summary ?? '' } },
    { type: 'input', block_id: 'skill', optional: true, label: { type: 'plain_text', text: 'Skill' }, element: { type: 'plain_text_input', action_id: 'v', initial_value: b.skill ?? '' } },
    { type: 'input', block_id: 'repo', optional: true, label: { type: 'plain_text', text: 'Repository' }, element: { type: 'plain_text_input', action_id: 'v', initial_value: b.repo ?? '' } },
    { type: 'input', block_id: 'notes', optional: true, label: { type: 'plain_text', text: 'Notes for the agent' }, element: { type: 'plain_text_input', action_id: 'v', multiline: true, initial_value: b.notes ?? '' } },
  ];
  if (options.length) blocks.push({ type: 'input', block_id: 'outward', optional: true, label: { type: 'plain_text', text: 'Outward actions' }, element: { type: 'checkboxes', action_id: 'v', options, ...(initial.length ? { initial_options: initial } : {}) } });
  return {
    type: 'modal', callback_id: EDIT_VIEW_ID, private_metadata: request.id,
    title: { type: 'plain_text', text: 'Edit brief' }, submit: { type: 'plain_text', text: 'Save' }, close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}

/** Extract the brief from a submitted edit view. */
export function briefFromView(view) {
  const v = view.state.values;
  const get = (b) => v[b]?.v?.value ?? '';
  return {
    summary: get('summary').trim(),
    skill: get('skill').trim() || null,
    repo: get('repo').trim() || null,
    notes: get('notes').trim(),
    outward_actions: (v.outward?.v?.selected_options ?? []).map((o) => o.value),
  };
}
