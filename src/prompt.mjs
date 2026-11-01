// What the Paseo session is told. Kept short: the session has all of the owner's tools and skills.

function context(p) {
  const lines = [];
  for (const f of p.forwards) {
    lines.push(`- ${f.url}`);
    if (f.author || f.text) lines.push(`  Preview${f.author ? ` (${f.author})` : ''}: ${String(f.text ?? '').replace(/\s+/g, ' ').slice(0, 500)}`);
  }
  const files = p.files.map((f) => `- ${f.name}: ${f.url}`);
  return [
    lines.length ? `Forwarded Slack message${p.forwards.length > 1 ? 's' : ''}:\n${lines.join('\n')}` : null,
    files.length ? `Attached files:\n${files.join('\n')}` : null,
  ].filter(Boolean).join('\n\n');
}

/** First turn of a DM thread. */
export function firstPrompt(p, { ownerName = 'the owner' } = {}) {
  const ctx = context(p);
  const ask = p.note
    ? `${ownerName}'s message:\n${p.note}`
    : `${ownerName} didn't say what he wants. Work out what the thread is about and what he likely needs from it, then suggest the next step. Don't act on it yet.`;
  return [
    `You are chatting with ${ownerName} in a Slack DM, through Lekam. Lekam relays your final message of each turn to him as-is, and his replies in that DM thread come back to you here. Write Slack mrkdwn (*bold*, _italic_, \`code\`, <https://url|text>, "- " bullets; no headings or tables) and keep it short. Don't message him with your Slack tools: your reply here reaches him.`,
    ctx ? `${ctx}\n\nRead ${p.forwards.length ? 'the forwarded message and its whole thread' : 'these'} with your Slack tools (slack_read_thread, slack_read_channel, slack_read_file) before anything else.` : null,
    ask,
  ].filter(Boolean).join('\n\n');
}

/** Later turns: what he wrote, plus anything new he forwarded or attached. */
export function followupPrompt(p) {
  const ctx = context(p);
  return [p.note || null, ctx || null].filter(Boolean).join('\n\n');
}

/** A short session title for Paseo. */
export function title(p) {
  const t = p.note || p.forwards[0]?.text || p.forwards[0]?.url || 'Slack DM';
  return `Lekam: ${t.replace(/\s+/g, ' ').slice(0, 70)}`;
}
