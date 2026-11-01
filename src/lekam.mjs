// The whole product: a DM thread with Lekam is a chat with one Paseo session.
// The owner forwards a Slack message (or writes) -> a session starts with it -> its replies come back in that DM thread.
// Lekam posts nowhere else. Whatever has to go out to Slack, the session posts itself with its own tools.
import { parseDm, isEmpty } from './forward.mjs';
import { firstPrompt, followupPrompt, title } from './prompt.mjs';
import { toMrkdwn } from './mrkdwn.mjs';

const WORKING = 'gear';

export class Lekam {
  constructor({ slack, sessions, ownerName = 'the owner', timeoutMs = 2 * 36e5, log = () => {} }) {
    Object.assign(this, { slack, sessions, ownerName, timeoutMs, log });
    this.queues = new Map(); // DM thread -> tail of its turn queue (one turn at a time per thread)
    this.handles = new Map(); // DM thread -> Paseo agent handle
  }

  /** An owner DM: a new thread starts a session, a reply in a thread continues it. */
  onDm(m) {
    const p = parseDm(m);
    if (isEmpty(p)) return Promise.resolve();
    const thread = m.thread_ts ?? m.ts;
    const next = (this.queues.get(thread) ?? Promise.resolve()).then(() => this.turn(m, thread, p));
    this.queues.set(thread, next);
    next.finally(() => { if (this.queues.get(thread) === next) this.queues.delete(thread); });
    return next;
  }

  async turn(m, thread, p) {
    await this.slack.react(m.channel, m.ts, WORKING);
    try {
      let h = this.handles.get(thread) ?? await this.sessions.find(thread);
      let result; let started = false;
      if (h) {
        result = await h.run(followupPrompt(p), { timeoutMs: this.timeoutMs });
      } else {
        h = await this.sessions.start(thread, { title: title(p), prompt: firstPrompt(p, { ownerName: this.ownerName }) });
        started = true;
        result = await h.waitForFinish(this.timeoutMs);
      }
      this.handles.set(thread, h);
      await this.slack.reply(m.channel, thread, this.render(result, h.id, { started }));
    } catch (e) {
      this.log('error', `turn failed in ${thread}: ${e.stack ?? e}`);
      this.handles.delete(thread);
      await this.slack.reply(m.channel, thread, `:warning: ${e.message}`).catch(() => {});
    } finally {
      await this.slack.unreact(m.channel, m.ts, WORKING);
    }
  }

  render(r, id, { started = false } = {}) {
    const link = `<${this.sessions.link(id)}|open in Paseo>`;
    switch (r?.status) {
      case 'idle': return `${toMrkdwn(r.lastMessage || '') || '_(no reply)_'}${started ? `\n\n_${link}_` : ''}`;
      case 'permission': return `The session is waiting for a permission decision: ${link}`;
      case 'timeout': return `Still working after ${Math.round(this.timeoutMs / 60e3)} min. It carries on in Paseo: ${link}`;
      default: return `:warning: The session stopped with an error: ${r?.error ?? r?.status ?? 'unknown'} (${link})`;
    }
  }
}
