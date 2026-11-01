// Slack over Socket Mode. Lekam only reads its own DMs with the owner and only posts in those DM threads.

/** Pure: is this event a message the owner wrote in their DM with Lekam? */
export function isOwnerDm(ev, owner) {
  return ev?.type === 'message' && ev.channel_type === 'im' && ev.user === owner && !ev.bot_id
    && (!ev.subtype || ev.subtype === 'file_share');
}

/** Pure: split long text into Slack-sized messages, on paragraph or line breaks where possible. */
export function chunks(text, max = 3500) {
  const out = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.trim() || !out.length) out.push(rest);
  return out;
}

export class Slack {
  constructor({ botToken, appToken, owner, log = () => {} }) {
    Object.assign(this, { botToken, appToken, owner, log });
  }

  async start(onDm) {
    const { App, LogLevel } = await import('@slack/bolt');
    this.app = new App({ token: this.botToken, appToken: this.appToken, socketMode: true, logLevel: LogLevel.WARN });
    this.client = this.app.client;
    const seen = new Set();
    this.app.event('message', async ({ event }) => {
      if (!isOwnerDm(event, this.owner) || seen.has(event.ts)) return;
      seen.add(event.ts); setTimeout(() => seen.delete(event.ts), 10 * 60e3).unref?.();
      // Acked already; the turn can take minutes.
      setImmediate(() => onDm(event).catch((e) => this.log('error', `dm handler failed: ${e.stack ?? e}`)));
    });
    await this.app.start();
    const auth = await this.client.auth.test();
    this.log('info', `slack connected as ${auth.user} in ${auth.team}`);
  }
  async stop() { await this.app?.stop(); }

  async ownerName() {
    try { const u = (await this.client.users.info({ user: this.owner })).user; return u?.profile?.display_name || u?.real_name || 'the owner'; } catch { return 'the owner'; }
  }
  async reply(channel, thread_ts, text) {
    for (const part of chunks(text)) await this.client.chat.postMessage({ channel, thread_ts, text: part, unfurl_links: false, unfurl_media: false });
  }
  async react(channel, timestamp, name) { try { await this.client.reactions.add({ channel, timestamp, name }); } catch (e) { if (!/already_reacted/.test(e.message)) this.log('warn', `react: ${e.message}`); } }
  async unreact(channel, timestamp, name) { try { await this.client.reactions.remove({ channel, timestamp, name }); } catch (e) { if (!/no_reaction/.test(e.message)) this.log('warn', `unreact: ${e.message}`); } }
}
