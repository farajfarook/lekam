// Slack adapter on @slack/bolt (Socket Mode). Filters events down to the three kinds core cares
// about (bot_mention, owner_mention, followup) and exposes the small surface core needs.
import { ACTIONS, EDIT_VIEW_ID } from '../../approvals/cards.mjs';

const IGNORED_SUBTYPES = new Set(['message_changed', 'message_deleted', 'channel_join', 'channel_leave', 'bot_message', 'message_replied', 'thread_broadcast', 'group_join', 'group_leave']);

/** Pure: strip <@ID> mentions, <#C|name> channel refs and trailing whitespace. */
export function stripMentions(text = '') {
  return text.replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, '').replace(/\s+/g, ' ').trim();
}
export function mentions(text = '', id) { return new RegExp(`<@${id}(?:\\|[^>]*)?>`).test(text); }

/** Pure: classify a raw Slack message event into {kind,...} or null. `isEngaged(channel,thread)` is a callback. */
export async function classifyEvent(ev, { botUserId, ownerIds, isEngaged }) {
  if (!ev || ev.type !== 'message' && ev.type !== 'app_mention') return null;
  if (ev.subtype && IGNORED_SUBTYPES.has(ev.subtype)) return null;
  if (ev.bot_id || ev.user === botUserId || !ev.user) return null;
  const text = ev.text ?? '';
  const channel = ev.channel;
  const ts = ev.ts;
  const thread_ts = ev.thread_ts ?? ev.ts;
  const base = { channel, ts, thread_ts, user: ev.user, event_ts: ev.event_ts, raw_text: text, text: stripMentions(text), is_dm: ev.channel_type === 'im' };
  if (!base.text) return null;
  if (mentions(text, botUserId) || base.is_dm) return { kind: 'bot_mention', ...base };
  if (!ownerIds.has(ev.user)) {
    const owner = [...ownerIds].find((id) => mentions(text, id));
    if (owner) return { kind: 'owner_mention', owner, ...base };
  }
  if (ev.thread_ts && (await isEngaged(channel, ev.thread_ts))) return { kind: 'followup', ...base };
  return null;
}

export class SlackAdapter {
  constructor({ bot_token, app_token, ownerIds, log = () => {} }) {
    this.ownerIds = ownerIds; this.log = log; this.botUserId = null;
    this.tokens = { bot_token, app_token };
    this.handlers = { message: null, action: null, view: null, isEngaged: () => false };
    this.userNames = new Map(); this.channelNames = new Map();
  }

  onMessage(fn) { this.handlers.message = fn; }
  onAction(fn) { this.handlers.action = fn; }
  onView(fn) { this.handlers.view = fn; }
  setEngagedLookup(fn) { this.handlers.isEngaged = fn; }

  async start() {
    const { App, LogLevel } = await import('@slack/bolt');
    this.app = new App({ token: this.tokens.bot_token, appToken: this.tokens.app_token, socketMode: true, logLevel: LogLevel.WARN });
    this.client = this.app.client;
    const auth = await this.client.auth.test();
    this.botUserId = auth.user_id;
    const seen = new Set(); // app_mention and message.* both fire for a mention; collapse on ts
    const handle = async (ev, event_id) => {
      const key = `${ev.channel}:${ev.ts}`;
      if (seen.has(key)) return; seen.add(key); setTimeout(() => seen.delete(key), 60_000);
      const msg = await classifyEvent(ev, { botUserId: this.botUserId, ownerIds: this.ownerIds, isEngaged: this.handlers.isEngaged });
      if (!msg) return;
      msg.event_id = event_id;
      try { await this.handlers.message?.(msg); } catch (e) { this.log('error', `message handler failed: ${e.stack ?? e}`); }
    };
    // Bolt acks Socket Mode envelopes before our handler runs; do the work after.
    this.app.event('app_mention', async ({ event, body }) => { setImmediate(() => handle(event, body.event_id)); });
    this.app.event('message', async ({ event, body }) => { setImmediate(() => handle(event, body.event_id)); });
    this.app.event('member_joined_channel', async ({ event }) => { if (event.user === this.botUserId) this.log('info', `joined channel ${event.channel}`); });
    this.app.event('member_left_channel', async ({ event }) => { if (event.user === this.botUserId) this.log('info', `left channel ${event.channel}`); });

    this.app.action(/^lekam_/, async ({ ack, body, action, respond }) => {
      await ack();
      const payload = {
        action_id: action.action_id, value: action.value ?? null, user: body.user.id, channel: body.channel?.id ?? null,
        message_ts: body.message?.ts ?? null, trigger_id: body.trigger_id,
        selected: action.selected_options?.map((o) => o.value) ?? null, respond,
      };
      try { await this.handlers.action?.(payload); } catch (e) { this.log('error', `action handler failed: ${e.stack ?? e}`); }
    });
    this.app.view(EDIT_VIEW_ID, async ({ ack, body, view }) => {
      await ack();
      try { await this.handlers.view?.({ request_id: view.private_metadata, view, user: body.user.id }); } catch (e) { this.log('error', `view handler failed: ${e.stack ?? e}`); }
    });

    await this.app.start();
    this.log('info', `slack connected as ${auth.user} (${this.botUserId}) in ${auth.team}`);
  }

  async stop() { await this.app?.stop(); }

  // ---- surface used by core ----
  async react(channel, ts, name) { try { await this.client.reactions.add({ channel, timestamp: ts, name }); } catch (e) { if (!/already_reacted/.test(e.message)) this.log('warn', `react failed: ${e.message}`); } }
  async unreact(channel, ts, name) { try { await this.client.reactions.remove({ channel, timestamp: ts, name }); } catch (e) { if (!/no_reaction/.test(e.message)) this.log('warn', `unreact failed: ${e.message}`); } }
  async post(channel, thread_ts, msg) {
    const m = typeof msg === 'string' ? { text: msg } : msg;
    const r = await this.client.chat.postMessage({ channel, thread_ts, ...m });
    return { channel: r.channel, ts: r.ts };
  }
  async dm(user, msg, thread_ts = undefined) {
    const conv = await this.client.conversations.open({ users: user });
    const m = typeof msg === 'string' ? { text: msg } : msg;
    const r = await this.client.chat.postMessage({ channel: conv.channel.id, ...(thread_ts ? { thread_ts } : {}), ...m });
    return { channel: r.channel, ts: r.ts };
  }
  async update(channel, ts, msg) {
    const m = typeof msg === 'string' ? { text: msg } : msg;
    await this.client.chat.update({ channel, ts, ...m });
  }
  async ephemeral(channel, user, text) { try { await this.client.chat.postEphemeral({ channel, user, text }); } catch (e) { this.log('warn', `ephemeral failed: ${e.message}`); } }
  async openModal(trigger_id, view) { await this.client.views.open({ trigger_id, view }); }
  async fetchThread(channel, thread_ts, limit = 20) {
    try {
      const r = await this.client.conversations.replies({ channel, ts: thread_ts, limit: Math.min(limit, 100) });
      const msgs = (r.messages ?? []).filter((m) => !m.subtype || m.subtype === 'thread_broadcast').map((m) => ({ user: m.user ?? m.bot_id ?? '?', text: stripMentions(m.text ?? ''), ts: m.ts }));
      return msgs.slice(-limit);
    } catch (e) { this.log('warn', `fetchThread failed: ${e.message}`); return []; }
  }
  async permalink(channel, ts) { try { return (await this.client.chat.getPermalink({ channel, message_ts: ts })).permalink; } catch { return null; } }
  async userName(id) {
    if (this.userNames.has(id)) return this.userNames.get(id);
    try { const u = await this.client.users.info({ user: id }); const n = u.user?.profile?.display_name || u.user?.real_name || id; this.userNames.set(id, n); return n; } catch { return id; }
  }
  async channelName(id) {
    if (this.channelNames.has(id)) return this.channelNames.get(id);
    try { const c = await this.client.conversations.info({ channel: id }); const n = c.channel?.name ?? null; this.channelNames.set(id, n); return n; } catch { return null; }
  }
}
