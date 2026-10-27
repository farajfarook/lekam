// In-memory chat adapter for tests and `lekam smoke`. Records everything; lets a driver inject events.
export class FakeChat {
  constructor({ ownerIds, log = () => {} } = {}) {
    this.ownerIds = ownerIds ?? new Set(); this.log = log; this.botUserId = 'UBOT';
    this.posts = []; this.dms = []; this.updates = []; this.reactions = new Map(); this.modals = []; this.ephemerals = [];
    this.handlers = {}; this.threads = new Map(); this.seq = 1;
  }
  onMessage(fn) { this.handlers.message = fn; } onAction(fn) { this.handlers.action = fn; } onView(fn) { this.handlers.view = fn; }
  setEngagedLookup(fn) { this.isEngaged = fn; }
  async start() {} async stop() {}
  ts() { return `${Date.now() / 1000 + this.seq++}`.slice(0, 17); }
  // --- driver side ---
  async inject(msg) { const m = { event_id: `Ev${this.seq++}`, ts: this.ts(), ...msg }; m.thread_ts ??= m.ts; this.thread(m.channel, m.thread_ts).push({ user: m.user, text: m.text, ts: m.ts }); await this.handlers.message(m); return m; }
  async click(action_id, value, user, card) { return this.handlers.action({ action_id, value, user, channel: card?.channel ?? 'DM', message_ts: card?.ts ?? null, trigger_id: 't', selected: null }); }
  async select(action_id, value, user, selected) { return this.handlers.action({ action_id, value, user, channel: 'DM', message_ts: null, trigger_id: 't', selected }); }
  lastDm() { return this.dms[this.dms.length - 1]; }
  thread(channel, thread_ts) { const k = `${channel}:${thread_ts}`; if (!this.threads.has(k)) this.threads.set(k, []); return this.threads.get(k); }
  // --- surface used by core ---
  async react(channel, ts, name) { const k = `${channel}:${ts}`; if (!this.reactions.has(k)) this.reactions.set(k, new Set()); this.reactions.get(k).add(name); }
  async unreact(channel, ts, name) { this.reactions.get(`${channel}:${ts}`)?.delete(name); }
  reactionsOn(channel, ts) { return [...(this.reactions.get(`${channel}:${ts}`) ?? [])]; }
  canPostAs(user) { return this.postAs?.has(user) ?? false; }
  async post(channel, thread_ts, msg, { as = null } = {}) { const m = typeof msg === 'string' ? { text: msg } : msg; const ts = this.ts(); const asOwner = as && this.canPostAs(as) ? as : null; this.posts.push({ channel, thread_ts, ...m, ts, as: asOwner }); this.thread(channel, thread_ts).push({ user: asOwner ?? this.botUserId, text: m.text, ts }); return { channel, ts, ...(asOwner ? { as: asOwner } : {}) }; }
  async dm(user, msg, thread_ts) { const m = typeof msg === 'string' ? { text: msg } : msg; const ts = this.ts(); const d = { user, channel: `DM_${user}`, ts, thread_ts: thread_ts ?? null, ...m }; this.dms.push(d); return { channel: d.channel, ts }; }
  async update(channel, ts, msg) { const m = typeof msg === 'string' ? { text: msg } : msg; this.updates.push({ channel, ts, ...m }); }
  async ephemeral(channel, user, text) { this.ephemerals.push({ channel, user, text }); }
  async openModal(trigger_id, view) { this.modals.push(view); }
  async fetchThread(channel, thread_ts, limit = 20) { return this.thread(channel, thread_ts).slice(-limit); }
  /** Messages after `oldest` in one thread, or in every thread of a channel (DMs); `noAccess` channels throw like Slack. */
  async readSince(channel, { thread_ts = null, oldest }) {
    if (this.noAccess?.has(channel)) throw new Error('An API error occurred: not_in_channel');
    const out = [];
    for (const [k, list] of this.threads) {
      const [c, t] = k.split(':');
      if (c !== channel || (thread_ts && t !== thread_ts)) continue;
      for (const m of list) out.push({ thread_ts: t, raw_text: m.text, ...m });
    }
    return out.filter((m) => Number(m.ts) > Number(oldest)).sort((a, b) => Number(a.ts) - Number(b.ts));
  }
  async permalink(channel, ts) { return `https://slack.example/${channel}/${ts}`; }
  async userName(id) { return `name:${id}`; }
  async channelName(id) { return `chan-${id}`; }
}
