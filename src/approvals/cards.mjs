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
  AUTO_POST: 'lekam_auto_post',
});
export const EDIT_VIEW_ID = 'lekam_edit_brief';

const md = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const ctx = (...els) => ({ type: 'context', elements: els.map((t) => ({ type: 'mrkdwn', text: t })) });
const btn = (text, action_id, value, style) => ({ type: 'button', text: { type: 'plain_text', text }, action_id, value, ...(style ? { style } : {}) });
const quote = (s) => s.split('\n').map((l) => '> ' + l).join('\n');
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function headerBlocks({ request, requesterName, permalink, channelName, lowConfidence }) {
  const kind = request.kind === 'owner_mention' ? 'tagged you' : 'asked Lekam';
  const cls = request.classification ?? {};
  const flags = [cls.urgent ? ':rotating_light: *urgent*' : null, lowConfidence ? ':grey_question: low confidence' : null, `confidence ${Math.round((cls.confidence ?? 0) * 100)}%`].filter(Boolean);
  return [
    md(`*${requesterName ?? request.requester} ${kind} in ${channelName ? '#' + channelName : request.channel}*${permalink ? ` · <${permalink}|open thread>` : ''}`),
    md(quote(trunc(request.request_text, 2500))),
    ctx(...flags, `req \`${request.id}\``),
  ];
}

function briefBlocks({ request, config, selected }) {
  const b = request.brief ?? {};
  const lines = [`*Brief:* ${b.summary ?? '(none)'}`];
  if (b.skill) lines.push(`*Skill:* \`${b.skill}\``);
  if (b.repo) lines.push(`*Repo:* \`${b.repo}\``);
  if (b.notes) lines.push(`*Notes:* ${trunc(b.notes, 600)}`);
  const blocks = [md(lines.join('\n'))];
  const ids = Object.keys(config.outward_actions);
  if (ids.length) {
    const options = ids.map((id) => ({ text: { type: 'plain_text', text: config.outward_actions[id] }, value: id }));
    const initial = options.filter((o) => (selected ?? b.outward_actions ?? []).includes(o.value));
    blocks.push({
      type: 'section', text: { type: 'mrkdwn', text: '*Outward actions the agent may take:*' },
      accessory: { type: 'checkboxes', action_id: ACTIONS.OUTWARD_SELECT, options, ...(initial.length ? { initial_options: initial } : {}) },
    });
  }
  blocks.push({
    type: 'actions', block_id: 'lekam_opts',
    elements: [{ type: 'checkboxes', action_id: ACTIONS.AUTO_POST, options: [{ text: { type: 'plain_text', text: 'Post the result to the thread without asking me' }, value: 'auto_post' }], ...(request.auto_post ? { initial_options: [{ text: { type: 'plain_text', text: 'Post the result to the thread without asking me' }, value: 'auto_post' }] } : {}) }],
  });
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
    blocks: [...headerBlocks(args), { type: 'divider' }, ...briefBlocks(args), buttonRow(request)],
  };
}

/** Card after an action: same header + brief, outcome line, no buttons. */
export function actionedCard(args, outcomeText, extra = []) {
  const { request } = args;
  return {
    text: `${outcomeText} – ${trunc(request.request_text, 100)}`,
    blocks: [...headerBlocks(args), { type: 'divider' }, ...briefBlocks(args), md(`*${outcomeText}* ${fmtTime()}`), ...extra],
  };
}

export function investigatingCard(args, { agentLink }) {
  const { request } = args;
  return {
    text: `Investigating – ${trunc(request.request_text, 100)}`,
    blocks: [
      ...headerBlocks(args), { type: 'divider' }, ...briefBlocks(args),
      md(`*Investigating* ${fmtTime()} · ${agentLink ? `<${agentLink}|open in Paseo>` : 'session running'}\nReply in this thread to talk to the agent. Press *Proceed* when you're happy with its plan.`),
      { type: 'actions', block_id: 'lekam_buttons', elements: [btn('Proceed', ACTIONS.PROCEED, request.id, 'primary'), btn('Edit brief', ACTIONS.EDIT, request.id), btn('Drop', ACTIONS.DROP, request.id, 'danger')] },
    ],
  };
}

export function resultCard({ request, report, agentLink }) {
  return {
    text: `Result for ${request.id}: ${trunc(report, 100)}`,
    blocks: [
      md(`*Result for req \`${request.id}\`*${agentLink ? ` · <${agentLink}|open in Paseo>` : ''}`),
      md(trunc(report, 2800)),
      { type: 'actions', block_id: 'lekam_result', elements: [btn('Post to thread', ACTIONS.POST_RESULT, request.id, 'primary'), btn('Discard', ACTIONS.DISCARD_RESULT, request.id)] },
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
