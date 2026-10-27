// Pure: find the agent tool call that produced a Slack post (session-post detection), and decide whether the post
// expects a reply. Works on Paseo timeline entries ({ item: { type, name, callId, detail: { input, output } }, timestamp }),
// read defensively: a shape change makes a post "unmatched", never an error.

/** Comparable form of a message text (Slack escapes &<> and reflows whitespace; mentions differ in rendering). */
export function normText(s = '') {
  return String(s).replace(/<@([A-Z0-9]+)(\|[^>]*)?>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 400);
}

const str = (v) => { try { return typeof v === 'string' ? v : JSON.stringify(v ?? ''); } catch { return ''; } };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The tool call that sent `post`, or null.
 * Exact: a send-tool call whose output names the post's own timestamp (`message_ts`, or the permalink's `p<digits>`;
 * a reply's link also carries its parent's `thread_ts`, which is deliberately not a match).
 * Fallback: a send-tool call with the same text, to the same conversation (or a user id for a DM), within `windowMs`.
 * @param {Array} entries timeline entries
 * @param {{channel:string, ts:string, text?:string, raw_text?:string, dm?:boolean}} post
 * @returns {{callId:string|null, how:'ts'|'text'}|null}
 */
export function matchPost(entries, post, { sendTools = /slack.*(send|post)_?message/i, windowMs = 120e3 } = {}) {
  const digits = 'p' + String(post.ts).replace('.', '');
  const tsField = new RegExp(`message_ts\\W{1,12}${escapeRe(String(post.ts))}`);
  const wanted = normText(post.raw_text ?? post.text ?? '');
  const postMs = Number(post.ts) * 1000;
  let fallback = null;
  for (const e of entries ?? []) {
    const it = e?.item;
    if (!it || it.type !== 'tool_call') continue;
    const d = it.detail ?? {};
    // The send call itself, or a script tool (pi codemode) that made one: its record lists the nested calls.
    const nested = (Array.isArray(d.output?.details?.calls) ? d.output.details.calls : []).filter((c) => sendTools.test(String(c?.name ?? '')));
    const direct = sendTools.test(String(it.name ?? ''));
    if (!direct && !nested.length) continue;
    const out = str(d.output ?? it.output ?? it.result);
    if (out.includes(digits) || tsField.test(out)) return { callId: it.callId ?? null, how: 'ts' };
    if (fallback || !wanted) continue;
    const inputs = direct ? [d.input ?? it.input ?? {}] : nested.map((c) => { try { return typeof c.args === 'string' ? JSON.parse(c.args) : (c.args ?? {}); } catch { return {}; } });
    const at = Date.parse(e.timestamp ?? '') || 0;
    if (at && Math.abs(at - postMs) > windowMs) continue;
    for (const input of inputs) {
      const text = input?.message ?? input?.text ?? input?.markdown_text;
      if (!text || normText(text) !== wanted) continue;
      const ch = String(input.channel_id ?? input.channel ?? '');
      if (ch === post.channel || (post.dm && /^[UW][A-Z0-9]+$/.test(ch))) { fallback = { callId: it.callId ?? null, how: 'text' }; break; }
    }
  }
  return fallback;
}

/** A DM, or a post that tags someone other than an owner (a user, a user group, @here/@channel/@everyone). */
export function expectsReply(rawText = '', { ownerIds = new Set(), dm = false } = {}) {
  if (dm) return true;
  if (/<!subteam\^|<!here|<!channel|<!everyone/.test(rawText)) return true;
  for (const m of String(rawText).matchAll(/<@([UW][A-Z0-9]+)/g)) if (!ownerIds.has(m[1])) return true;
  return false;
}
