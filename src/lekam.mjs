// The whole product: a DM thread with Lekam is a chat with one Paseo session.
// The owner forwards a Slack message (or writes) -> a session starts with it -> its replies come back in that DM thread.
// Lekam posts nowhere else. Whatever has to go out to Slack, the session posts itself with its own tools.
import { parseDm, isEmpty } from './forward.mjs';
import { firstPrompt, followupPrompt, title } from './prompt.mjs';
import { toMrkdwn } from './mrkdwn.mjs';

const WORKING = 'gear';
// Messages sent into a running turn join it ("steer") instead of interrupting it; to an idle session they start a turn.
const STEER = { activeTurnBehavior: 'steer' };

export class Lekam {
  constructor({ slack, sessions, ownerName = 'the owner', timeoutMs = 2 * 36e5, log = () => {} }) {
    Object.assign(this, { slack, sessions, ownerName, timeoutMs, log });
    this.queues = new Map(); // DM thread -> tail of its turn queue (one turn at a time per thread)
    this.handles = new Map(); // DM thread -> { handle, host } (its Paseo agent and where it runs)
    this.live = new Map(); // DM thread -> the turn running now: { handle, steers: [send promises], marks: [message ts], reacts }
  }

  /** An owner DM: a new thread starts a session, a reply steers the running turn, or continues the session. */
  onDm(m) {
    const p = parseDm(m);
    if (isEmpty(p)) return Promise.resolve();
    const thread = m.thread_ts ?? m.ts;
    const live = this.live.get(thread);
    if (live) return this.steer(m, thread, p, live);
    return this.enqueue(m, thread, p);
  }

  enqueue(m, thread, p) {
    const next = (this.queues.get(thread) ?? Promise.resolve()).then(() => this.turn(m, thread, p));
    this.queues.set(thread, next);
    next.finally(() => { if (this.queues.get(thread) === next) this.queues.delete(thread); });
    return next;
  }

  /** A reply while a turn runs goes straight into it. Its answer is part of that turn's reply. */
  async steer(m, thread, p, live) {
    live.marks.push(m.ts);
    const sent = live.handle.send(followupPrompt(p), STEER);
    live.steers.push(sent);
    live.reacts.push(this.slack.react(m.channel, m.ts, WORKING));
    try { await sent; } catch (e) {
      this.log('warn', `steer failed in ${thread}, sending it as its own turn: ${e.message}`);
      live.marks = live.marks.filter((ts) => ts !== m.ts);
      await this.slack.unreact(m.channel, m.ts, WORKING);
      return this.enqueue(m, thread, p);
    }
  }

  async turn(m, thread, p) {
    await this.slack.react(m.channel, m.ts, WORKING);
    let live = null;
    const watch = (s) => { live = { handle: s.handle, steers: [], marks: [], reacts: [] }; this.live.set(thread, live); };
    try {
      let s = this.handles.get(thread) ?? await this.sessions.find(thread);
      let result; let started = false;
      if (s) {
        this.handles.set(thread, s);
        watch(s);
        result = await s.handle.run(followupPrompt(p), { ...STEER, timeoutMs: this.timeoutMs });
      } else {
        const host = await this.sessions.chooseHost(p.note);
        s = await this.sessions.start(thread, { title: title(p), prompt: firstPrompt(p, { ownerName: this.ownerName }), host });
        this.handles.set(thread, s);
        watch(s);
        started = true;
        result = await s.handle.waitForFinish(this.timeoutMs);
      }
      result = await this.settle(thread, live, result);
      await this.slack.reply(m.channel, thread, this.render(result, s.handle.id, { started, host: s.host }));
    } catch (e) {
      this.log('error', `turn failed in ${thread}: ${e.stack ?? e}`);
      this.handles.delete(thread);
      await this.slack.reply(m.channel, thread, `:warning: ${e.message}`).catch(() => {});
    } finally {
      if (live && this.live.get(thread) === live) this.live.delete(thread);
      await Promise.allSettled(live?.reacts ?? []); // a ⚙️ still being added must not outlive its removal
      for (const ts of [m.ts, ...(live?.marks ?? [])]) await this.slack.unreact(m.channel, ts, WORKING);
    }
  }

  /**
   * A steer that reaches the session just after its turn ended starts a new turn instead of joining: wait for that one
   * too, so its answer isn't lost. Ends by closing the thread to steering in the same tick as the last check, so a reply
   * arriving afterwards queues as its own turn.
   */
  async settle(thread, live, result) {
    let seen = 0;
    while (result?.status === 'idle' && live.steers.length > seen) {
      const batch = live.steers.slice(seen); seen = live.steers.length;
      await Promise.allSettled(batch);
      const agent = (await live.handle.refresh().catch(() => null))?.agent;
      if (agent?.status === 'running') result = await live.handle.waitForFinish(this.timeoutMs);
    }
    if (this.live.get(thread) === live) this.live.delete(thread);
    return result;
  }

  render(r, id, { started = false, host = null } = {}) {
    const link = `<${this.sessions.link(id)}|open in Paseo>${host ? ` · on ${host}` : ''}`;
    switch (r?.status) {
      case 'idle': return `${toMrkdwn(r.lastMessage || '') || '_(no reply)_'}${started ? `\n\n_${link}_` : ''}`;
      case 'permission': return `The session is waiting for a permission decision: ${link}`;
      case 'timeout': return `Still working after ${Math.round(this.timeoutMs / 60e3)} min. It carries on in Paseo: ${link}`;
      default: return `:warning: The session stopped with an error: ${r?.error ?? r?.status ?? 'unknown'} (${link})`;
    }
  }
}
