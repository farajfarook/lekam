// What the owner sent in a DM: their note, the Slack messages they forwarded (or linked), and attached files.

const SLACK_LINK = /https:\/\/[a-z0-9-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d+(?:\?[^\s|>]*)?/gi;

const unescape = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Pure. `m` is a Slack message event. Returns { note, forwards: [{ url, author, text }], files: [{ name, url }] }. */
export function parseDm(m = {}) {
  const forwards = [];
  const seen = new Set();
  const add = (url, author = null, text = null) => {
    const u = unescape(url);
    if (!u || seen.has(u)) return;
    seen.add(u);
    forwards.push({ url: u, author, text });
  };
  // Forwarded messages (and unfurled message links) arrive as attachments carrying the original's permalink.
  for (const a of m.attachments ?? []) {
    const url = a.from_url ?? a.original_url;
    if (!url || !(a.is_share || a.is_msg_unfurl || /slack\.com\/archives\//.test(url))) continue;
    add(url, a.author_name ?? a.author_subname ?? null, unescape(a.text ?? a.fallback ?? '').trim() || null);
  }
  for (const [url] of String(m.text ?? '').matchAll(SLACK_LINK)) add(url);
  const note = unescape(String(m.text ?? '').replace(/<(https?:\/\/[^|>]+)\|[^>]*>/g, '$1').replace(/<(https?:\/\/[^>]+)>/g, '$1')).trim();
  const files = (m.files ?? []).map((f) => ({ name: f.name ?? f.title ?? 'file', url: f.permalink ?? f.url_private ?? null })).filter((f) => f.url);
  return { note, forwards, files };
}

export const isEmpty = (p) => !p.note && !p.forwards.length && !p.files.length;
