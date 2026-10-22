// Wires chat, brain, store and executors. The only module that causes side effects on decisions.
import { ownerForChannel, ownerById } from './config.mjs';
import { buildCatalogue } from './catalogue.mjs';
import { decideNew, decideFollowup, forcesCard } from './router.mjs';
import { isEngaged } from './state.mjs';
import { ttlFor, rateLimited, ownerOverloaded, fmtTime } from '../approvals/policy.mjs';
import { ACTIONS, approvalCard, actionedCard, investigatingCard, resultCard, editBriefView, briefFromView } from '../approvals/cards.mjs';

export class Service {
  constructor({ config, store, chat, brain, executors, log = () => {} }) {
    Object.assign(this, { config, store, chat, brain, executors, log });
    this.catalogue = buildCatalogue(config, { log });
    this.timers = [];
    this.reactionChains = new Map();
  }

  async start() {
    this.chat.setEngagedLookup((channel, thread_ts) => this.isEngagedThread(channel, thread_ts));
    this.chat.onMessage((m) => this.onMessage(m));
    this.chat.onAction((a) => this.onAction(a));
    this.chat.onView((v) => this.onView(v));
    await this.chat.start();
    this.timers.push(setInterval(() => this.expireCards().catch((e) => this.log('error', e.stack)), 60e3).unref());
    this.timers.push(setInterval(() => this.store.pruneEvents(), 36e5).unref());
    this.timers.push(setInterval(() => this.idleSweep().catch((e) => this.log('error', e.stack)), 24 * 36e5).unref());
    this.log('info', `lekam started: ${this.catalogue.skills.length} skills, ${this.config.repos.length} repos, ${this.config.owners.length} owner(s)`);
  }

  async stop() { for (const t of this.timers) clearInterval(t); await this.chat.stop?.(); for (const e of this.executors.values()) await e.close?.(); }

  // ---------- helpers ----------
  /** Outward actions granted on approval, per approvals.outward_actions_mode. */
  grantedOutward(request, { none = false } = {}) {
    if (none) return [];
    const mode = this.config.approvals.outward_actions_mode;
    if (mode === 'all') return Object.keys(this.config.outward_actions);
    return request.brief?.outward_actions ?? [];
  }
  /** Engaged = live request, or Lekam posted in the thread within chat.thread_engagement (store first, then the thread itself). */
  async isEngagedThread(channel, thread_ts) {
    const r = this.store.findByThread(channel, thread_ts);
    if (r && isEngaged(r.state)) return true;
    const within = this.config.chat.thread_engagement_ms;
    if (this.store.botSpokeRecently(channel, thread_ts, { withinMs: within })) return true;
    if (!this.chat.botUserId) return false;
    const msgs = await this.chat.fetchThread(channel, thread_ts, 50);
    const last = msgs.filter((m) => m.user === this.chat.botUserId).map((m) => Number(m.ts) * 1000).sort((x, y) => y - x)[0];
    if (last && Date.now() - last < within) { this.store.touchThread(channel, thread_ts, last); return true; }
    return false;
  }
  exec(ownerId) { const e = this.executors.get(ownerId); if (!e) throw new Error(`no executor for owner ${ownerId}`); return e; }
  ownerName(id) { return ownerById(this.config, id)?.name ?? id; }
  /** Owner-tag threads get owner-approved posts as the owner when a user token is configured; everything else posts as Lekam. */
  postsAsOwner(r) { return r.kind === 'owner_mention' && !!this.chat.canPostAs?.(r.owner); }
  postFor(r, msg) { return this.post(r.channel, r.thread_ts, msg, this.postsAsOwner(r) ? { as: r.owner } : {}); }
  /** Thread ack after Delegate/Proceed on an owner tag. None when the owner tagged themselves. */
  async ackPickup(r) {
    if (r.kind !== 'owner_mention' || r.requester === r.owner) return;
    await this.postFor(r, this.postsAsOwner(r) ? `Looking into this :eyes: I'll get back to you here shortly.` : `${this.ownerName(r.owner)} asked me to pick this up. I'll post back here when there's something to see.`);
  }
  react(request, key) { return this.setReaction(request, this.config.chat.reactions[key]); }
  setReaction(request, name) {
    // Serialised per message so concurrent transitions cannot interleave add/remove calls.
    const key = `${request.channel}:${request.origin_ts}`;
    const prev = this.reactionChains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      for (const n of Object.values(this.config.chat.reactions)) if (n !== name) await this.chat.unreact(request.channel, request.origin_ts, n);
      if (name) await this.chat.react(request.channel, request.origin_ts, name);
    });
    this.reactionChains.set(key, next);
    return next;
  }
  async cardArgs(request) {
    const excerpt = [];
    for (const m of request.classification?.thread_excerpt ?? []) excerpt.push({ name: await this.chat.userName(m.user), text: m.text });
    return { request, config: this.config, excerpt, requesterName: await this.chat.userName(request.requester), permalink: await this.chat.permalink(request.channel, request.origin_ts), channelName: await this.chat.channelName(request.channel), lowConfidence: (request.classification?.confidence ?? 1) < this.config.brain.threshold };
  }
  /** The agent's report rewritten as the owner's own friendly Slack reply; null (post the raw report) if the brain can't. */
  async ownerVoice(r, report) {
    if (!this.brain.rewriteAsOwner) return null;
    const owner = ownerById(this.config, r.owner);
    try {
      return await this.brain.rewriteAsOwner({ report, request_text: r.request_text, requesterName: r.requester === r.owner ? null : await this.chat.userName(r.requester), ownerName: owner?.name ?? 'the owner', voice: owner?.voice ?? null, request_id: r.id });
    } catch (e) { this.log('warn', `owner-voice rewrite failed for ${r.id}: ${e.message}`); this.store.audit('owner_voice_failed', r.id, null, { message: e.message }); return null; }
  }

  // ---------- the owner's session thread ----------
  // Everything about one request (card, follow-up cards, investigation chat, results, failures) lives in one DM thread:
  // under the approval card, or under the owner's own message when the owner DM'd Lekam.
  sessionThread(r) { return r.card ? (r.card.thread ?? r.card.ts) : undefined; }
  /** The owner DM'd Lekam themselves: the request thread IS the session thread and nobody else can see it. */
  ownerOwnDm(r) { return r.card?.thread != null && r.card.thread === r.thread_ts && r.channel === r.card.channel; }
  /** Bot-started threads are not followed by the owner: @-mention them on anything that needs their attention. */
  nudge(r) { return this.ownerOwnDm(r) ? '' : `<@${r.owner}> `; }
  toOwner(r, msg) { return this.chat.dm(r.owner, msg, this.sessionThread(r)); }

  /** Post in a channel thread and remember that Lekam spoke there (keeps the thread engaged). */
  async post(channel, thread_ts, msg, opts = {}) { const r = await this.chat.post(channel, thread_ts, msg, opts); this.store.touchThread(channel, thread_ts); return r; }
  async updateCard(request, msg) { if (request.card) await this.chat.update(request.card.channel, request.card.ts, msg); }
  async classify(msg, { request = null, ownerId, thread = null } = {}) {
    try {
      thread ??= await this.chat.fetchThread(msg.channel, msg.thread_ts, this.config.brain.thread_context_messages);
      // The brain sees names, never ids.
      const named = [];
      for (const m of thread) named.push({ user: m.user === this.chat.botUserId ? 'Lekam' : await this.chat.userName(m.user), text: m.text, ts: m.ts });
      const channelName = await this.chat.channelName(msg.channel);
      const cls = await this.brain.classify(
        { kind: msg.kind, requester: await this.chat.userName(msg.user), channel: channelName ? '#' + channelName : 'a direct message', text: msg.text, thread: named, approvedScope: request?.scope ?? null },
        { persona: this.config.persona, catalogue: this.catalogue.text, outcomes: this.store.recentOutcomes(this.config.brain.recent_outcomes), ownerName: this.ownerName(ownerId), request_id: request?.id ?? null },
      );
      if (cls.brief) {
        const refined = await this.brain.refineBrief?.({ kind: msg.kind, requester: msg.user, channel: msg.channel, text: msg.text, thread }, { persona: this.config.persona, catalogue: this.catalogue.text, outcomes: [], ownerName: this.ownerName(ownerId), request_id: request?.id ?? null });
        if (refined) cls.brief = refined;
        cls.brief.outward_actions = (cls.brief.outward_actions ?? []).filter((a) => a in this.config.outward_actions);
        if (cls.brief.skill && !this.catalogue.skillByName.has(cls.brief.skill)) cls.brief.skill = null;
        if (cls.brief.repo && !this.config.repos.some((r) => r.name === cls.brief.repo)) cls.brief.repo = null;
      }
      return cls;
    } catch (e) { this.log('warn', `brain failed: ${e.message}`); this.store.audit('brain_error', request?.id ?? null, msg.user, { message: e.message }); return null; }
  }

  // ---------- inbound messages ----------
  async onMessage(msg) {
    if (this.store.seen(msg.event_id)) { this.store.audit('duplicate_event', null, msg.user, { event_id: msg.event_id }); return; }
    // Owner replying in a session thread (DM): talk to that request's agent.
    if (msg.is_dm && this.config.ownerIds.has(msg.user) && msg.thread_ts !== msg.ts) {
      const r = this.store.findByCard(msg.channel, msg.thread_ts);
      if (r) return this.onSessionReply(r, msg);
    }
    const existing = this.store.findByThread(msg.channel, msg.thread_ts);
    if (existing && isEngaged(existing.state) && (msg.kind === 'followup' || existing.state !== 'DONE')) return this.onFollowup(msg, existing);
    if (msg.kind === 'followup') {
      // No live request but Lekam spoke in this thread recently: treat the reply as addressed to it.
      if (!(await this.isEngagedThread(msg.channel, msg.thread_ts))) return;
      msg = { ...msg, kind: 'bot_mention' };
    }
    return this.onNew(msg);
  }

  async onNew(msg) {
    const owner = msg.kind === 'owner_mention' ? ownerById(this.config, msg.owner) : ownerForChannel(this.config, msg.channel);
    if (!owner) return;
    if (msg.kind === 'bot_mention' && this.config.ownerIds.has(msg.user) && !msg.is_dm) { /* owners asking the bot directly are allowed: fall through */ }
    if (rateLimited(this.store, msg.user, this.config)) {
      this.store.audit('rate_limited', null, msg.user, { channel: msg.channel });
      if (msg.kind === 'bot_mention') await this.post(msg.channel, msg.thread_ts, `You've sent a lot my way this hour. Give it a little while and try again.`);
      return;
    }
    const thread = await this.chat.fetchThread(msg.channel, msg.thread_ts, this.config.brain.thread_context_messages);
    const cls = await this.classify(msg, { ownerId: owner.slack_id, thread });
    if (cls) cls.thread_excerpt = thread.filter((m) => m.ts !== msg.ts && m.user !== this.chat.botUserId).slice(-4);
    const d = decideNew(msg, cls, this.config);
    this.store.audit('decision', null, msg.user, { kind: msg.kind, decision: d.type, reason: d.reason ?? null, intent: cls?.intent ?? null, confidence: cls?.confidence ?? null });
    switch (d.type) {
      case 'reply': return this.post(msg.channel, msg.thread_ts, d.text);
      case 'clarify': {
        await this.post(msg.channel, msg.thread_ts, d.question);
        await this.chat.react(msg.channel, msg.ts, this.config.chat.reactions.needs_info);
        return;
      }
      case 'ignore': return;
      case 'card': return this.openCard(msg, owner, cls ?? this.unreadCls(msg, thread), d);
    }
  }

  /** Stand-in classification when the brain is down: the owner sees the raw request and decides. */
  unreadCls(msg, thread) {
    return {
      intent: 'task_request', actionable: true, confidence: 0, urgent: false, brain_unavailable: true, followup: null, clarifying_question: null,
      reply_to_user: msg.kind === 'bot_mention' ? `I've passed this to ${ownerForChannel(this.config, msg.channel)?.name ?? 'the owner'}; I'll post back here.` : null,
      brief: { summary: msg.text.slice(0, 300), skill: null, repo: null, outward_actions: [], notes: 'Not pre-read: the brain was unavailable. Read the thread for context.' },
      thread_excerpt: thread.filter((m) => m.ts !== msg.ts && m.user !== this.chat.botUserId).slice(-4),
    };
  }

  async openCard(msg, owner, cls, d) {
    if (ownerOverloaded(this.store, owner.slack_id, this.config)) {
      this.store.audit('owner_overloaded', null, msg.user, { owner: owner.slack_id });
      if (msg.kind === 'bot_mention') await this.post(msg.channel, msg.thread_ts, `${owner.name} has a queue of requests already. I'll be able to take this a bit later.`);
      return;
    }
    const brief = cls.brief ?? { summary: msg.text.slice(0, 300), skill: null, repo: null, outward_actions: [], notes: '' };
    let request = this.store.createRequest({ kind: msg.kind, channel: msg.channel, thread_ts: msg.thread_ts, origin_ts: msg.ts, requester: msg.user, owner: owner.slack_id, request_text: msg.text, classification: cls, brief, expires_at: Date.now() + ttlFor(msg.kind, this.config) });
    request = this.store.transition(request.id, 'PENDING_APPROVAL');
    // Owner DM'd Lekam: the card replies under their message, so the whole session stays in that thread.
    const ownDm = msg.is_dm && msg.user === owner.slack_id;
    const posted = await this.chat.dm(owner.slack_id, approvalCard(await this.cardArgs(request)), ownDm ? msg.thread_ts : undefined);
    const card = { channel: posted.channel, ts: posted.ts, thread: ownDm ? msg.thread_ts : posted.ts };
    request = this.store.updateRequest(request.id, { card });
    if (msg.kind === 'bot_mention') {
      await this.react(request, 'pending');
      // "I've asked Faraj" is for other people; the owner asking gets the 👀 and the card.
      if (cls.reply_to_user && msg.user !== owner.slack_id) await this.post(msg.channel, msg.thread_ts, cls.reply_to_user);
    }
  }

  async onFollowup(msg, request) {
    const isOwner = msg.user === request.owner;
    const needsBrain = !isOwner && request.scope && !forcesCard(msg.text, this.config);
    const cls = needsBrain ? await this.classify(msg, { request, ownerId: request.owner }) : null;
    const d = decideFollowup(msg, request, cls, this.config);
    this.store.audit('decision', request.id, msg.user, { kind: 'followup', decision: d.type, reason: d.reason ?? null, followup: cls?.followup ?? null });
    switch (d.type) {
      case 'ignore': return;
      case 'reply': return this.post(msg.channel, msg.thread_ts, d.text);
      case 'forward': return this.forward(request, d.text, msg);
      case 'forward_or_card': {
        const owner = ownerById(this.config, request.owner);
        const card = await this.toOwner(request, {
          text: `Follow-up from ${await this.chat.userName(msg.user)} needs your OK`,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `${this.nudge(request)}*Follow-up* from ${await this.chat.userName(msg.user)} (${d.reason.replace('_', ' ')}):\n> ${msg.text.slice(0, 1500)}` } },
            { type: 'actions', block_id: 'lekam_followup', elements: [
              { type: 'button', text: { type: 'plain_text', text: 'Forward to agent' }, style: 'primary', action_id: ACTIONS.APPROVE_ONCE, value: `${request.id}|fu|${Buffer.from(msg.text).toString('base64url')}` },
              { type: 'button', text: { type: 'plain_text', text: 'Ignore' }, action_id: ACTIONS.IGNORE, value: `${request.id}|fu` },
            ] },
          ],
        });
        this.store.audit('followup_card', request.id, msg.user, { card, reason: d.reason, owner: owner?.slack_id });
        return;
      }
    }
  }

  async forward(request, text, msg, { owner = false } = {}) {
    // The owner may keep talking to a session after its result was posted or discarded.
    const ok = ['RUNNING', 'DONE', 'APPROVED', 'INVESTIGATING', ...(owner ? ['RELEASED', 'DISCARDED'] : [])];
    if (!ok.includes(request.state)) return;
    const exec = this.exec(request.owner);
    if (request.state === 'DONE') {
      // Re-open: a follow-up after completion continues the same thread; new turn on same or new session.
      await this.react(request, 'running');
    }
    try {
      if (!(await exec.alive(request))) {
        const args = await this.cardArgs(request);
        const { sessionId, result } = await exec.start({ request, brief: request.brief, allowed: request.scope?.outward_actions ?? [], permalink: args.permalink, requesterName: args.requesterName, previousOutcome: request.outcome, onStarted: (id) => this.store.setSession(request.id, id) });
        this.store.audit('session_handoff', request.id, msg?.user ?? null, { session: sessionId });
        await exec.send({ request: this.store.getRequest(request.id), text });
        await this.deliverResult(this.store.getRequest(request.id), result);
        return;
      }
      const { result } = await exec.send({ request, text });
      await this.deliverResult(this.store.getRequest(request.id), result, { followup: true });
    } catch (e) { this.log('error', `forward failed: ${e.message}`); this.store.audit('forward_failed', request.id, null, { message: e.message }); await this.toOwner(request, `Couldn't reach the agent: ${e.message}`).catch(() => {}); }
  }

  async pipeToSession(request, msg) {
    try {
      const { result } = await this.exec(request.owner).send({ request, text: msg.text });
      await this.toOwner(request, result.text || `(agent finished with status ${result.status})`);
    } catch (e) { await this.toOwner(request, `Couldn't reach the session: ${e.message}`); }
  }

  /** The owner wrote in a request's DM thread. */
  async onSessionReply(r, msg) {
    if (r.state === 'INVESTIGATING') return this.pipeToSession(r, msg);
    if (r.state === 'PENDING_APPROVAL') return this.toOwner(r, `Use the buttons above to start the agent (or *Edit brief* to change the plan).`);
    if (!['RUNNING', 'DONE', 'APPROVED', 'RELEASED', 'DISCARDED'].includes(r.state) || !r.scope) return this.toOwner(r, `This request is closed (${r.state.toLowerCase()}). Message me again to start a new one.`);
    return this.forward(r, msg.text, msg, { owner: true });
  }

  // ---------- owner actions ----------
  async onAction(a) {
    const [id, tag, extra] = String(a.value ?? '').split('|');
    const request = this.store.getRequest(id);
    if (!request) { if (a.action_id !== ACTIONS.OUTWARD_SELECT) await this.chat.ephemeral(a.channel, a.user, `That request no longer exists.`); return; }
    if (a.user !== request.owner) {
      this.store.audit('approval_rejected_identity', request.id, a.user, { action: a.action_id });
      await this.chat.ephemeral(a.channel, a.user, `Not yours to approve.`);
      return;
    }
    const args = async () => this.cardArgs(this.store.getRequest(id));
    try {
      switch (a.action_id) {
        case ACTIONS.OUTWARD_SELECT: this.store.updateRequest(id, { brief: { ...request.brief, outward_actions: a.selected ?? [] } }); return;
        case ACTIONS.EDIT: return this.chat.openModal(a.trigger_id, editBriefView({ request, config: this.config }));

        case ACTIONS.APPROVE_TASK: case ACTIONS.APPROVE_ONCE: case ACTIONS.DELEGATE: case ACTIONS.DELEGATE_NO_OUTWARD: {
          if (tag === 'fu') { // follow-up forwarding card
            const text = Buffer.from(extra ?? '', 'base64url').toString();
            await this.chat.update(a.channel, a.message_ts, { text: `Forwarded ${fmtTime()}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*Forwarded* ${fmtTime()}\n> ${text.slice(0, 1500)}` } }] });
            this.store.audit('followup_forwarded', id, a.user, {});
            return this.forward(request, text, { user: a.user });
          }
          const mode = a.action_id === ACTIONS.APPROVE_ONCE ? 'once' : 'task';
          const outward = this.grantedOutward(request, { none: a.action_id === ACTIONS.DELEGATE_NO_OUTWARD });
          const scope = { brief: request.brief, outward_actions: outward };
          this.store.updateRequest(id, { scope, approval_mode: mode });
          this.store.transition(id, 'APPROVED', { actor: a.user, data: { mode, outward } });
          await this.updateCard(request, actionedCard(await args(), mode === 'once' ? 'Approved once' : request.kind === 'owner_mention' ? 'Delegated' : 'Approved task'));
          await this.ackPickup(request);
          return this.run(this.store.getRequest(id));
        }
        case ACTIONS.DISCUSS: {
          this.store.transition(id, 'INVESTIGATING', { actor: a.user });
          await this.updateCard(request, investigatingCard(await args(), { agentLink: null }));
          return this.investigate(this.store.getRequest(id));
        }
        case ACTIONS.DECLINE: case ACTIONS.IGNORE: {
          if (tag === 'fu') { await this.chat.update(a.channel, a.message_ts, { text: `Ignored ${fmtTime()}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*Ignored* ${fmtTime()}` } }] }); return; }
          this.store.transition(id, 'DENIED', { actor: a.user, data: { via: a.action_id } });
          await this.updateCard(request, actionedCard(await args(), a.action_id === ACTIONS.IGNORE ? 'Ignored' : 'Declined'));
          if (request.kind === 'bot_mention') {
            await this.react(request, 'declined');
            await this.post(request.channel, request.thread_ts, `${this.ownerName(request.owner)} passed on this one. Ping them directly if it's urgent.`);
          }
          return;
        }
        case ACTIONS.PROCEED: {
          const outward = this.grantedOutward(request);
          this.store.updateRequest(id, { scope: { brief: request.brief, outward_actions: outward }, approval_mode: 'task' });
          this.store.transition(id, 'RUNNING', { actor: a.user, data: { outward } });
          await this.updateCard(request, actionedCard(await args(), 'Proceeding'));
          await this.ackPickup(request);
          await this.react(request, 'running');
          const exec = this.exec(request.owner);
          const { result } = await exec.proceed({ request: this.store.getRequest(id), brief: request.brief, allowed: outward, onQueued: (n) => this.updateCard(request, actionedCard(args, `Queued (${n} ahead)`)).catch(() => {}) });
          return this.deliverResult(this.store.getRequest(id), result);
        }
        case ACTIONS.DROP: {
          this.store.transition(id, 'DROPPED', { actor: a.user });
          await this.exec(request.owner).archive(request);
          await this.updateCard(request, actionedCard(await args(), 'Dropped'));
          return;
        }
        case ACTIONS.POST_RESULT: {
          if (request.state === 'DONE') this.store.transition(id, 'RELEASED', { actor: a.user });
          else this.store.audit('result_reposted', id, a.user, { state: request.state });
          const posted = await this.postFor(request, (this.postsAsOwner(request) && request.outcome?.post_text) || request.outcome?.text || '(no report)');
          await this.react(request, 'done');
          const link = await this.chat.permalink(request.channel, posted?.ts ?? request.origin_ts);
          const done = `*Posted${posted?.as ? ` as ${this.ownerName(request.owner)}` : ''}* ${fmtTime()}${link ? ` · <${link}|view>` : ''}`;
          await this.chat.update(a.channel, a.message_ts, { text: `Posted ${fmtTime()}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${done}\n${((posted?.as && request.outcome?.post_text) || request.outcome?.text || '').slice(0, 2800)}` } }] });
          return;
        }
        case ACTIONS.DISCARD_RESULT: {
          if (request.state === 'DONE') this.store.transition(id, 'DISCARDED', { actor: a.user });
          await this.react(request, 'done');
          await this.chat.update(a.channel, a.message_ts, { text: `Discarded ${fmtTime()}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*Discarded* ${fmtTime()}` } }] });
          return;
        }
      }
    } catch (e) {
      this.log('error', `action ${a.action_id} on ${id} failed: ${e.stack ?? e}`);
      this.store.audit('action_failed', id, a.user, { action: a.action_id, message: e.message });
      await this.chat.ephemeral(a.channel, a.user, `That didn't work: ${e.message}`);
    }
  }

  async onView({ request_id, view, user }) {
    const request = this.store.getRequest(request_id);
    if (!request || user !== request.owner) return;
    const brief = briefFromView(view);
    const updated = this.store.updateRequest(request_id, { brief });
    this.store.audit('brief_edited', request_id, user, { brief });
    if (updated.state === 'PENDING_APPROVAL') await this.updateCard(updated, approvalCard(await this.cardArgs(updated)));
    else if (updated.state === 'INVESTIGATING') await this.updateCard(updated, investigatingCard(await this.cardArgs(updated), { agentLink: this.exec(updated.owner).agentLink(updated.session_id) }));
  }

  // ---------- execution ----------
  async run(request) {
    const exec = this.exec(request.owner);
    const args = await this.cardArgs(request);
    try {
      const { result } = await exec.start({
        request, brief: request.scope.brief, allowed: request.scope.outward_actions, permalink: args.permalink, requesterName: args.requesterName,
        onQueued: (n) => this.updateCard(request, actionedCard(args, `Queued (${n} ahead)`)).catch(() => {}),
        onStarted: async (id) => {
          this.store.setSession(request.id, id);
          this.store.transition(request.id, 'RUNNING');
          await this.react(request, 'running');
          await this.updateCard(request, actionedCard({ ...args, request: this.store.getRequest(request.id) }, 'Running', [{ type: 'context', elements: [{ type: 'mrkdwn', text: `<${exec.agentLink(id)}|open in Paseo>` }] }]));
        },
      });
      await this.deliverResult(this.store.getRequest(request.id), result);
    } catch (e) {
      this.log('error', `run failed for ${request.id}: ${e.stack ?? e}`);
      await this.fail(this.store.getRequest(request.id), e.message);
    }
  }

  async investigate(request) {
    const exec = this.exec(request.owner);
    const args = await this.cardArgs(request);
    try {
      const { sessionId, result } = await exec.startInvestigation({ request, brief: request.brief, permalink: args.permalink, requesterName: args.requesterName, onStarted: async (id) => { this.store.setSession(request.id, id); await this.updateCard(request, investigatingCard({ ...args, request: this.store.getRequest(request.id) }, { agentLink: exec.agentLink(id) })); } });
      this.store.audit('investigation_plan', request.id, null, { session: sessionId, status: result.status });
      await this.toOwner(request, this.nudge(request) + (result.text || `(agent stopped with status ${result.status}${result.error ? ': ' + result.error : ''})`));
    } catch (e) { this.log('error', `investigate failed: ${e.message}`); await this.toOwner(request, `Investigation failed: ${e.message}`); }
  }

  async deliverResult(request, result, { followup = false } = {}) {
    if (request.state === 'APPROVED') this.store.transition(request.id, 'RUNNING'); // queued-then-finished edge
    const r = this.store.getRequest(request.id);
    if (result.status === 'error' || result.status === 'timeout') return this.fail(r, result.error ?? result.status);
    const outcome = { text: result.text, status: result.status, summary: result.text.split('\n')[0].slice(0, 200), at: Date.now() };
    // Posting as the owner: rewrite the report in their voice now, so the card shows exactly what will be posted.
    if (this.postsAsOwner(r) && result.text) outcome.post_text = await this.ownerVoice(r, result.text);
    this.store.updateRequest(r.id, { outcome });
    this.store.finishSession(r.id);
    if (r.state === 'RUNNING') this.store.transition(r.id, 'DONE');
    // Results always wait for the owner: Post to thread / Discard.
    const link = this.exec(r.owner).agentLink(r.session_id);
    if (this.ownerOwnDm(r)) {
      // The owner asked in their own DM: nobody else to release it to, so the report is simply the reply.
      await this.toOwner(r, outcome.text || '(no report)');
      if (this.store.getRequest(r.id).state === 'DONE') this.store.transition(r.id, 'RELEASED');
      await this.react(r, 'done');
      if (!followup) await this.updateCard(r, actionedCard(await this.cardArgs(r), 'Done'));
      return;
    }
    await this.toOwner(r, resultCard({ request: r, report: outcome.post_text || outcome.text || '(no report)', rewritten: !!outcome.post_text, agentLink: link, permalink: await this.chat.permalink(r.channel, r.origin_ts), postAs: this.postsAsOwner(r) ? this.ownerName(r.owner) : null, mention: this.nudge(r) }));
    if (!followup) await this.updateCard(r, actionedCard(await this.cardArgs(r), 'Finished, result is in this thread'));
  }

  async fail(request, reason) {
    try { if (request.state === 'APPROVED') this.store.transition(request.id, 'RUNNING'); if (this.store.getRequest(request.id).state === 'RUNNING') this.store.transition(request.id, 'FAILED', { data: { reason } }); } catch {}
    this.store.finishSession(request.id, 'failed');
    await this.react(request, 'failed');
    const link = this.exec(request.owner).agentLink(request.session_id);
    await this.updateCard(request, actionedCard(await this.cardArgs(request), `Failed: ${String(reason).slice(0, 200)}`, link ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `<${link}|open in Paseo>` }] }] : []));
    if (request.card) await this.toOwner(request, `${this.nudge(request)}Failed: ${String(reason).slice(0, 300)}${link ? ` · <${link}|open in Paseo>` : ''}`).catch(() => {});
    if (request.kind === 'bot_mention') await this.post(request.channel, request.thread_ts, `That didn't go through (${String(reason).slice(0, 120)}). ${this.ownerName(request.owner)} has the details.`);
  }

  // ---------- timers ----------
  async expireCards() {
    for (const r of this.store.expired()) {
      this.store.transition(r.id, 'EXPIRED');
      await this.updateCard(r, actionedCard(await this.cardArgs(r), 'Expired'));
      if (r.kind === 'bot_mention') await this.setReaction(r, null);
    }
  }
  async idleSweep() {
    for (const r of this.store.listByState('DONE', 'RELEASED', 'DISCARDED', 'FAILED')) {
      const owner = ownerById(this.config, r.owner); if (!owner || !r.session_id) continue;
      if (Date.now() - r.updated_at < owner.executor.idle_archive_days * 864e5) continue;
      await this.exec(r.owner).archive(r);
      this.store.updateRequest(r.id, { session_id: null });
      this.store.audit('session_archived', r.id, null, { session: r.session_id });
    }
  }
}
