// Wires chat, brain, store and executors. The only module that causes side effects on decisions.
import crypto from 'node:crypto';
import { ownerForChannel, ownerById } from './config.mjs';
import { buildCatalogue } from './catalogue.mjs';
import { decideNew, decideFollowup, forcesCard, decideWatchReply } from './router.mjs';
import { matchPost, expectsReply } from './post-match.mjs';
import { isEngaged } from './state.mjs';
import { loadPeople, peopleForPrompt, tagPeople } from './people.mjs';
import { ownerMessage, chatFollowup, watchForward } from '../executor/briefs.mjs';
import { ttlFor, rateLimited, ownerOverloaded, fmtTime } from '../approvals/policy.mjs';
import { ACTIONS, WATCH_ACTIONS, approvalCard, actionedCard, investigatingCard, resultCard, agentReplyCard, editBriefView, briefFromView, watchCard } from '../approvals/cards.mjs';

/** A Lekam request in one of these states owns its thread's follow-ups, even if a session also watches the thread. */
const LIVE_REQUEST = new Set(['PENDING_APPROVAL', 'APPROVED', 'INVESTIGATING', 'RUNNING']);
/** Watch replies don't need the skills/repos catalogue: keep that brain call small. */
const WATCH_CATALOGUE = "(Not needed here: this is a reply in a conversation the owner's own agent session is waiting on. Propose no skills, repos or actions.)";
const NO_ACCESS = /not_in_channel|channel_not_found|missing_scope|not_allowed_token_type|is_archived/;

export class Service {
  constructor({ config, store, chat, brain, executors, daemons = null, log = () => {} }) {
    Object.assign(this, { config, store, chat, brain, executors, daemons, log });
    this.catalogue = buildCatalogue(config, { log });
    this.timers = [];
    this.reactionChains = new Map();
    this.turns = new Map(); // request id -> tail of its agent-turn queue
    this.detections = new Set(); // session-post detections in flight
    this.daemonDownAt = new Map(); // host -> last time an unreachable daemon was audited
  }
  /** Wait between detection attempts (tests replace it). */
  sleep(ms) { return new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }); }

  async start() {
    this.chat.setEngagedLookup((channel, thread_ts) => this.isEngagedThread(channel, thread_ts));
    this.chat.onMessage((m) => this.onMessage(m));
    this.chat.onAction((a) => this.onAction(a));
    this.chat.onView((v) => this.onView(v));
    await this.chat.start();
    this.timers.push(setInterval(() => this.expireCards().catch((e) => this.log('error', e.stack)), 60e3).unref());
    this.timers.push(setInterval(() => this.store.pruneEvents(), 36e5).unref());
    this.timers.push(setInterval(() => this.idleSweep().catch((e) => this.log('error', e.stack)), 24 * 36e5).unref());
    // Thread watches: expire, check new registrations every minute; re-read every watched conversation now and then.
    this.timers.push(setInterval(() => this.watchTick().catch((e) => this.log('error', e.stack)), 60e3).unref());
    this.timers.push(setInterval(() => this.catchUpWatches().catch((e) => this.log('error', e.stack)), this.config.watches.catch_up_interval_ms).unref());
    // Replies posted while Lekam was down. Not awaited: Slack retries can be slow and events already flow.
    this.catchUpWatches().catch((e) => this.log('warn', `watch catch-up at start failed: ${e.message}`));
    this.log('info', `lekam started: ${this.catalogue.skills.length} skills, ${this.config.repos.length} repos, ${this.config.owners.length} owner(s)`);
  }

  async stop() { for (const t of this.timers) clearInterval(t); await this.chat.stop?.(); for (const e of this.executors.values()) await e.close?.(); await this.daemons?.close?.(); }

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
    if (this.store.activeWatchFor(channel, thread_ts)) return true;
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
  /** A card's button carries the outcome version it showed (v<at>); refuse actions from an older card. Cards from before versioning pass. */
  staleCard(request, tag) { return !!tag && tag.startsWith('v') && tag !== `v${request.outcome?.at}`; }

  /** The agent's report rewritten as the owner's own friendly Slack reply; null (post the raw report) if the brain can't. */
  async ownerVoice(r, report) {
    if (!this.brain.rewriteAsOwner) return null;
    const owner = ownerById(this.config, r.owner);
    const people = loadPeople(this.config, { log: this.log }).filter((p) => p.slack_id !== r.owner);
    try {
      return await this.brain.rewriteAsOwner({ report, request_text: r.request_text, requesterName: r.requester === r.owner ? null : await this.chat.userName(r.requester), ownerName: owner?.name ?? 'the owner', voice: owner?.voice ?? null, people: peopleForPrompt(people), request_id: r.id });
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

  /** Post in a channel thread and remember that Lekam spoke there (keeps the thread engaged). Posts made as the owner
   *  don't count: people replying to them are talking to the owner, not to Lekam. */
  async post(channel, thread_ts, msg, opts = {}) { const r = await this.chat.post(channel, thread_ts, msg, opts); if (!r?.as) this.store.touchThread(channel, thread_ts); return r; }
  /** One agent turn at a time per request: overlapping sends to the same session resolve on the same last message. */
  serial(id, fn) {
    const next = (this.turns.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.turns.set(id, next);
    next.catch(() => {}).then(() => { if (this.turns.get(id) === next) this.turns.delete(id); });
    return next;
  }
  async updateCard(request, msg) { if (request.card) await this.chat.update(request.card.channel, request.card.ts, msg); }
  async classify(msg, { request = null, ownerId, thread = null } = {}) {
    try {
      thread ??= await this.chat.fetchThread(msg.channel, msg.thread_ts, this.config.brain.thread_context_messages);
      // The brain sees names, never ids.
      const named = [];
      for (const m of thread) named.push({ user: m.user === this.chat.botUserId ? (this.chat.appName ?? 'Lekam') : await this.chat.userName(m.user), text: m.text, ts: m.ts });
      const channelName = await this.chat.channelName(msg.channel);
      const cls = await this.brain.classify(
        { kind: msg.kind, requester: await this.chat.userName(msg.user), channel: channelName ? '#' + channelName : msg.dm ? `a direct message to ${this.ownerName(ownerId)}` : 'a direct message', text: msg.text, thread: named, approvedScope: request?.scope ?? null },
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
    if (!msg.is_dm && this.config.ownerIds.has(msg.user)) {
      // The owner's own message, typed or posted by an agent with the owner's account. Never acted on as a request:
      // bookkeeping, then session-post detection (which session posted it, so replies can come back to it).
      if (msg.kind === 'owner_post' || msg.via_app) return this.onOwnerPost(msg);
      // In the channel the owner is talking to people. Lekam only listens when tagged; steering happens in the DM session thread.
      if (msg.kind === 'followup') { this.store.audit('owner_untagged_ignored', this.store.findByThread(msg.channel, msg.thread_ts)?.id ?? null, msg.user, { channel: msg.channel }); return; }
    }
    // Owner replying in a session thread (DM): talk to that request's agent.
    if (msg.is_dm && this.config.ownerIds.has(msg.user) && msg.thread_ts !== msg.ts) {
      const r = this.store.findByCard(msg.channel, msg.thread_ts);
      if (r) return this.onSessionReply(r, msg);
    }
    // Someone replied where a session Lekam didn't start is waiting (thread watch): the owner decides whether it goes on.
    const watch = this.watchFor(msg);
    if (watch) return this.onWatchReply(msg, watch);
    const existing = this.store.findByThread(msg.channel, msg.thread_ts);
    if (existing && isEngaged(existing.state) && (msg.kind === 'followup' || existing.state !== 'DONE')) return this.onFollowup(msg, existing);
    if (msg.kind === 'followup') {
      // No live request but Lekam spoke in this thread recently: treat the reply as addressed to it.
      if (!(await this.isEngagedThread(msg.channel, msg.thread_ts))) return;
      msg = { ...msg, kind: 'bot_mention' };
    }
    return this.onNew(msg);
  }

  /** A message by the owner that Lekam didn't post. */
  async onOwnerPost(msg) {
    const w = this.store.activeWatchFor(msg.channel, msg.thread_ts);
    if (w) this.store.watchSeen(w.id, msg.ts); // most likely the waiting session posting again
    const r = this.store.findByThread(msg.channel, msg.thread_ts);
    if (msg.via_app) {
      // Posted as the owner through another app in a request's thread: the agent skipped the owner's Post step.
      this.store.audit('owner_post_via_other_app', r?.id ?? null, msg.user, { channel: msg.channel, ts: msg.ts, app: msg.via_app });
      if (r?.card && r.owner === msg.user) {
        const link = await this.chat.permalink(msg.channel, msg.ts);
        await this.toOwner(r, `${this.nudge(r)}Something was posted as you in this request's thread by another app, not through Lekam${link ? ` (<${link}|view>)` : ''}. If it was the agent, it skipped your Post step. I haven't acted on it.`).catch(() => {});
      }
    } else if (r) this.store.audit('owner_untagged_ignored', r.id, msg.user, { channel: msg.channel });
    if (this.daemons && this.config.watches.detect.enabled) this.track(this.runDetection(msg));
  }
  track(p) { const q = p.catch((e) => this.log('warn', `session-post detection failed: ${e.message}`)); this.detections.add(q); q.finally(() => this.detections.delete(q)); return q; }

  async onNew(msg) {
    const owner = msg.kind === 'owner_mention' ? ownerById(this.config, msg.owner) : ownerForChannel(this.config, msg.channel);
    if (!owner) return;
    if (msg.kind === 'bot_mention' && this.config.ownerIds.has(msg.user) && !msg.is_dm) { /* owners asking the bot directly are allowed: fall through */ }
    // Captured DMs to the owner are mostly conversation and never answered automatically: don't count them.
    if (!msg.dm && rateLimited(this.store, msg.user, this.config)) {
      this.store.audit('rate_limited', null, msg.user, { channel: msg.channel });
      if (msg.kind === 'bot_mention') await this.post(msg.channel, msg.thread_ts, `You've sent a lot my way this hour. Give it a little while and try again.`);
      return;
    }
    const thread = await this.chat.fetchThread(msg.channel, msg.thread_ts, this.config.brain.thread_context_messages);
    const cls = await this.classify(msg, { ownerId: owner.slack_id, thread });
    // Kept for the card (last two) and the agent's brief (all of it): who asked whom matters.
    if (cls) cls.thread_excerpt = thread.filter((m) => m.ts !== msg.ts && m.user !== this.chat.botUserId).slice(-8);
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
      intent: 'task_request', addressed_to_owner: true, actionable: true, confidence: 0, urgent: false, brain_unavailable: true, followup: null, clarifying_question: null,
      reply_to_user: msg.kind === 'bot_mention' ? `I've passed this to ${ownerForChannel(this.config, msg.channel)?.name ?? 'the owner'}; I'll post back here.` : null,
      brief: { summary: msg.text.slice(0, 300), skill: null, repo: null, outward_actions: [], notes: 'Not pre-read: the brain was unavailable. Read the thread for context.' },
      thread_excerpt: thread.filter((m) => m.ts !== msg.ts && m.user !== this.chat.botUserId).slice(-8),
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
      case 'forward': return this.forward(request, d.text, msg, { ownerTurn: msg.user === request.owner, fromName: await this.chat.userName(msg.user) });
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

  /** What the agent receives: owner messages carry the owner token (authoritative); anyone else's are marked untrusted. */
  agentText(request, text, { ownerTurn, fromName }) {
    return ownerTurn ? ownerMessage({ config: this.config, request, ownerName: this.ownerName(request.owner), text }) : chatFollowup({ fromName, text });
  }

  /** ownerTurn: the owner is talking to the agent (DM session thread or the channel thread) - show the agent's answer to them as-is. */
  async forward(request, text, msg, opts = {}) { return this.serial(request.id, () => this.forwardTurn(this.store.getRequest(request.id) ?? request, text, msg, opts)); }
  async forwardTurn(request, text, msg, { owner = false, ownerTurn = false, fromName = null } = {}) {
    // The owner may keep talking to a session after its result was posted or discarded.
    const ok = ['RUNNING', 'DONE', 'APPROVED', 'INVESTIGATING', ...(owner ? ['RELEASED', 'DISCARDED'] : [])];
    if (!ok.includes(request.state)) return;
    const exec = this.exec(request.owner);
    text = this.agentText(request, text, { ownerTurn, fromName });
    if (request.state === 'DONE') {
      // Re-open: a follow-up after completion continues the same thread; new turn on same or new session.
      await this.react(request, 'running');
    }
    try {
      if (!(await exec.alive(request))) {
        const args = await this.cardArgs(request);
        const { sessionId, result } = await exec.start({ request, brief: request.brief, allowed: request.scope?.outward_actions ?? [], permalink: args.permalink, requesterName: args.requesterName, channelName: args.channelName, thread: args.excerpt, previousOutcome: request.outcome, onStarted: (id) => this.store.setSession(request.id, id) });
        this.store.audit('session_handoff', request.id, msg?.user ?? null, { session: sessionId, handoff_status: result.status });
        // The handoff turn only restores context; the answer that matters is the reply to this message.
        const { result: reply } = await exec.send({ request: this.store.getRequest(request.id), text });
        await this.deliverResult(this.store.getRequest(request.id), reply, { followup: true, ownerTurn });
        return;
      }
      const { result } = await exec.send({ request, text });
      await this.deliverResult(this.store.getRequest(request.id), result, { followup: true, ownerTurn });
    } catch (e) { this.log('error', `forward failed: ${e.message}`); this.store.audit('forward_failed', request.id, null, { message: e.message }); await this.toOwner(request, `Couldn't reach the agent: ${e.message}`).catch(() => {}); }
  }

  async pipeToSession(request, msg) { return this.serial(request.id, () => this.pipeTurn(request, msg)); }
  async pipeTurn(request, msg) {
    try {
      const { result } = await this.exec(request.owner).send({ request, text: this.agentText(request, msg.text, { ownerTurn: true }) });
      await this.toOwner(request, result.text || `(agent finished with status ${result.status})`);
    } catch (e) { await this.toOwner(request, `Couldn't reach the session: ${e.message}`); }
  }

  /** The owner wrote in a request's DM thread. */
  async onSessionReply(r, msg) {
    if (r.state === 'INVESTIGATING') return this.pipeToSession(r, msg);
    if (r.state === 'PENDING_APPROVAL') return this.toOwner(r, `Use the buttons above to start the agent (or *Edit brief* to change the plan).`);
    if (!['RUNNING', 'DONE', 'APPROVED', 'RELEASED', 'DISCARDED'].includes(r.state) || !r.scope) return this.toOwner(r, `This request is closed (${r.state.toLowerCase()}). Message me again to start a new one.`);
    return this.forward(r, msg.text, msg, { owner: true, ownerTurn: true });
  }

  // ---------- owner actions ----------
  async onAction(a) {
    if (WATCH_ACTIONS.has(a.action_id)) return this.onWatchAction(a);
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
            return this.forward(request, text, { user: a.user }, { fromName: 'someone in the thread' });
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
        case ACTIONS.DRAFT_REPLY: {
          if (this.staleCard(request, tag)) return this.chat.ephemeral(a.channel, a.user, `There's a newer reply from the agent below; use that one.`);
          const voiced = await this.ownerVoice(request, request.outcome?.text || '');
          const outcome = { ...request.outcome, voiced: !!voiced, post_text: tagPeople(voiced ?? request.outcome?.text ?? '', loadPeople(this.config, { log: this.log }), { plain: new Set([request.owner]) }) };
          const r2 = this.store.updateRequest(id, { outcome });
          if (a.message_ts) await this.chat.update(a.channel, a.message_ts, agentReplyCard({ request: r2, text: request.outcome?.text || '', version: outcome.at, drafted: true }));
          await this.toOwner(r2, resultCard({ request: r2, report: outcome.post_text || '(empty)', rewritten: outcome.voiced, version: outcome.at, agentLink: this.exec(r2.owner).agentLink(r2.session_id), permalink: await this.chat.permalink(r2.channel, r2.origin_ts), postAs: this.ownerName(r2.owner) }));
          return;
        }
        case ACTIONS.POST_RESULT: {
          if (this.staleCard(request, tag)) return this.chat.ephemeral(a.channel, a.user, `That result is out of date; use the latest card in this thread.`);
          if (this.postsAsOwner(request) && !request.outcome?.post_text) return this.chat.ephemeral(a.channel, a.user, `Press *Draft reply* first so you can see exactly what will be posted as you.`);
          if (request.state === 'DONE') this.store.transition(id, 'RELEASED', { actor: a.user });
          else this.store.audit('result_reposted', id, a.user, { state: request.state });
          const posted = await this.postFor(request, request.outcome?.post_text || request.outcome?.text || '(no report)');
          await this.react(request, 'done');
          const link = await this.chat.permalink(request.channel, posted?.ts ?? request.origin_ts);
          const done = `*Posted${posted?.as ? ` as ${this.ownerName(request.owner)}` : ''}* ${fmtTime()}${link ? ` · <${link}|view>` : ''}`;
          await this.chat.update(a.channel, a.message_ts, { text: `Posted ${fmtTime()}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${done}\n${(request.outcome?.post_text || request.outcome?.text || '').slice(0, 2800)}` } }] });
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
        request, brief: request.scope.brief, allowed: request.scope.outward_actions, permalink: args.permalink, requesterName: args.requesterName, channelName: args.channelName, thread: args.excerpt,
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
      const { sessionId, result } = await exec.startInvestigation({ request, brief: request.brief, permalink: args.permalink, requesterName: args.requesterName, channelName: args.channelName, thread: args.excerpt, onStarted: async (id) => { this.store.setSession(request.id, id); await this.updateCard(request, investigatingCard({ ...args, request: this.store.getRequest(request.id) }, { agentLink: exec.agentLink(id) })); } });
      this.store.audit('investigation_plan', request.id, null, { session: sessionId, status: result.status });
      await this.toOwner(request, this.nudge(request) + (result.text || `(agent stopped with status ${result.status}${result.error ? ': ' + result.error : ''})`));
    } catch (e) { this.log('error', `investigate failed: ${e.message}`); await this.toOwner(request, `Investigation failed: ${e.message}`); }
  }

  async deliverResult(request, result, { followup = false, ownerTurn = false } = {}) {
    if (request.state === 'APPROVED') this.store.transition(request.id, 'RUNNING'); // queued-then-finished edge
    const r = this.store.getRequest(request.id);
    if (result.status === 'error' || result.status === 'timeout') return this.fail(r, result.error ?? result.status);
    const outcome = { text: result.text, status: result.status, summary: result.text.split('\n')[0].slice(0, 200), at: Date.now() };
    if (ownerTurn && !this.ownerOwnDm(r)) {
      // The agent is answering the owner: show it as-is. Posting it is a separate step (Draft reply / Post to thread).
      outcome.post_text = this.postsAsOwner(r) ? null : tagPeople(result.text, loadPeople(this.config, { log: this.log }), { plain: new Set([r.owner]) });
      this.store.updateRequest(r.id, { outcome });
      this.store.finishSession(r.id);
      if (r.state === 'RUNNING') this.store.transition(r.id, 'DONE');
      await this.toOwner(r, agentReplyCard({ request: r, text: result.text || `(agent finished with status ${result.status})`, version: outcome.at, postAs: this.postsAsOwner(r) ? this.ownerName(r.owner) : null }));
      return;
    }
    // Work out the exact thread text now so the card shows it: in the owner's voice when posting as them,
    // and with people @-tagged either way (never the owner, who is the one posting or approving).
    if (result.text) {
      const voiced = this.postsAsOwner(r) ? await this.ownerVoice(r, result.text) : null;
      outcome.voiced = !!voiced;
      outcome.post_text = tagPeople(voiced ?? result.text, loadPeople(this.config, { log: this.log }), { plain: new Set([r.owner]) });
    }
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
    await this.toOwner(r, resultCard({ request: r, report: outcome.post_text || outcome.text || '(no report)', rewritten: !!outcome.voiced, version: outcome.at, agentLink: link, permalink: await this.chat.permalink(r.channel, r.origin_ts), postAs: this.postsAsOwner(r) ? this.ownerName(r.owner) : null, mention: this.nudge(r) }));
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

  // ---------- thread watches ----------
  // A session Lekam didn't start (e.g. one the owner runs by hand) posted somewhere and registered a watch with
  // `lekam watch`. Replies there come to the owner as a card; only the owner's Forward sends them to the session.

  /** The watch that should take this message, or null. Bot mentions, the owner, and threads with a live request keep their flows. */
  watchFor(msg) {
    if (msg.kind === 'bot_mention' || this.config.ownerIds.has(msg.user)) return null;
    const w = this.store.activeWatchFor(msg.channel, msg.thread_ts);
    if (!w) return null;
    const live = this.store.findByThread(msg.channel, msg.thread_ts);
    if (live && LIVE_REQUEST.has(live.state)) return null;
    return w;
  }

  async onWatchReply(msg, watch) {
    return this.serial(`wr:${watch.id}`, async () => {
      const reply = this.store.addWatchReply(watch.id, { ts: msg.ts, user: msg.user, text: msg.text });
      this.store.watchSeen(watch.id, msg.ts);
      if (!reply) return; // already handled: live delivery and catch-up both saw it
      const cls = await this.classifyWatchReply(msg, watch);
      const d = decideWatchReply(cls);
      this.store.audit('watch_reply', null, msg.user, { watch: watch.id, decision: d.type, reason: d.reason, intent: cls?.intent ?? null, ts: msg.ts });
      if (d.type === 'ignore') { this.store.updateWatchReply(reply.id, { state: 'skipped' }); return; }
      await this.addToWatchCard(this.store.getWatch(watch.id), reply);
    });
  }

  async classifyWatchReply(msg, watch) {
    try {
      const thread = await this.chat.fetchThread(msg.channel, watch.is_dm ? msg.thread_ts : watch.thread_ts, this.config.brain.thread_context_messages);
      const named = [];
      for (const m of thread) named.push({ user: m.user === this.chat.botUserId ? (this.chat.appName ?? 'Lekam') : await this.chat.userName(m.user), text: m.text, ts: m.ts });
      const channelName = await this.chat.channelName(msg.channel);
      return await this.brain.classify(
        { kind: 'watch_reply', requester: await this.chat.userName(msg.user), channel: channelName ? '#' + channelName : `a direct message to ${this.ownerName(watch.owner)}`, text: msg.text, thread: named, watchedSession: watch.title || 'an agent session' },
        { persona: this.config.persona, catalogue: WATCH_CATALOGUE, outcomes: [], ownerName: this.ownerName(watch.owner), request_id: null },
      );
    } catch (e) { this.log('warn', `brain failed on watch reply: ${e.message}`); this.store.audit('brain_error', null, msg.user, { message: e.message, watch: watch.id }); return null; }
  }

  /** One pending card per watch: a new reply joins it while the owner hasn't acted, else a new card is posted
   *  (the first top-level in the owner's DM, later ones in its thread with an @-mention). */
  async addToWatchCard(watch, reply) {
    const pending = watch.pending_card;
    if (pending) {
      this.store.updateWatchReply(reply.id, { state: 'pending', batch: pending.batch });
      await this.chat.update(pending.channel, pending.ts, await this.renderWatchCard(watch, pending.batch, { mention: pending.threaded }));
      this.store.audit('watch_card_updated', null, watch.owner, { watch: watch.id, batch: pending.batch });
      return;
    }
    const batch = 'b' + crypto.randomBytes(4).toString('hex');
    this.store.updateWatchReply(reply.id, { state: 'pending', batch });
    const threaded = !!watch.card;
    const posted = await this.chat.dm(watch.owner, await this.renderWatchCard(watch, batch, { mention: threaded }), threaded ? watch.card.ts : undefined);
    this.store.updateWatch(watch.id, { pending_card: { channel: posted.channel, ts: posted.ts, batch, threaded }, ...(threaded ? {} : { card: { channel: posted.channel, ts: posted.ts } }) });
    this.store.audit('watch_card', null, watch.owner, { watch: watch.id, batch });
  }

  async renderWatchCard(watch, batch, { mention = false, outcome = null, note = null } = {}) {
    const replies = [];
    for (const r of this.store.repliesInBatch(watch.id, batch)) replies.push({ name: await this.chat.userName(r.user), text: r.text, link: await this.chat.permalink(watch.channel, r.ts) });
    const channelName = watch.is_dm ? null : await this.chat.channelName(watch.channel);
    const where = watch.is_dm ? `a DM with ${replies[0]?.name ?? 'someone'}` : channelName ? `#${channelName}` : 'a thread';
    const permalink = watch.is_dm ? null : await this.chat.permalink(watch.channel, watch.thread_ts);
    return watchCard({ watch, batch, replies, where, permalink, host: watch.host, agentLink: this.daemons?.agentLink(watch.agent_id) ?? null, mention: mention ? `<@${watch.owner}> ` : '', outcome, note });
  }

  async onWatchAction(a) {
    const [watchId, batch] = String(a.value ?? '').split('|');
    const watch = this.store.getWatch(watchId);
    if (!watch) return this.chat.ephemeral(a.channel, a.user, `That watch no longer exists.`);
    if (a.user !== watch.owner) {
      this.store.audit('watch_action_rejected_identity', null, a.user, { watch: watchId, action: a.action_id });
      return this.chat.ephemeral(a.channel, a.user, `Not yours to approve.`);
    }
    const to = { [ACTIONS.WATCH_FORWARD]: 'forwarded', [ACTIONS.WATCH_IGNORE]: 'ignored', [ACTIONS.WATCH_STOP]: 'stopped' }[a.action_id];
    // Same queue as incoming replies: a reply can't join this batch after the owner has acted on it.
    const taken = await this.serial(`wr:${watchId}`, async () => {
      const replies = this.store.repliesInBatch(watchId, batch, { state: 'pending' });
      if (!replies.length) return null;
      this.store.setBatchState(watchId, batch, 'pending', to);
      if (this.store.getWatch(watchId).pending_card?.batch === batch) this.store.updateWatch(watchId, { pending_card: null });
      if (a.action_id === ACTIONS.WATCH_STOP) this.store.updateWatch(watchId, { state: 'stopped' });
      return replies;
    });
    if (!taken) return this.chat.ephemeral(a.channel, a.user, `Already handled.`);
    this.store.audit(`watch_${to}`, null, a.user, { watch: watchId, batch, replies: taken.length });
    const card = { channel: a.channel, ts: a.message_ts };
    const update = async (opts) => { if (card.ts) await this.chat.update(card.channel, card.ts, await this.renderWatchCard(watch, batch, opts)); };
    try {
      switch (a.action_id) {
        case ACTIONS.WATCH_IGNORE: return await update({ outcome: `*Ignored* ${fmtTime()}` });
        case ACTIONS.WATCH_STOP: return await update({ outcome: `*Stopped watching* ${fmtTime()}. Replies in this conversation won't come to you any more.` });
        case ACTIONS.WATCH_FORWARD: {
          await update({ outcome: `*Forwarding* ${fmtTime()}` });
          return this.forwardWatch(watch, taken, card, batch);
        }
      }
    } catch (e) { this.log('error', `watch action ${a.action_id} failed: ${e.stack ?? e}`); await this.chat.ephemeral(a.channel, a.user, `That didn't work: ${e.message}`); }
  }

  /** Send forwarded replies to the waiting session: wait for it to be idle (never interrupt a turn), then start a new turn. */
  forwardWatch(watch, replies, card, batch) {
    return this.serial(`wf:${watch.id}`, async () => {
      const update = async (opts) => { if (card.ts) await this.chat.update(card.channel, card.ts, await this.renderWatchCard(watch, batch, opts)); };
      const link = this.daemons?.agentLink(watch.agent_id) ?? null;
      try {
        if (!this.daemons) throw new Error('no watch executor configured');
        const st = await this.daemons.status(watch);
        if (st.archived) throw new Error('the session is archived. Unarchive it in Paseo, then try again');
        if (st.status === 'running') {
          await update({ outcome: `*Waiting* for the session to finish its current turn, then forwarding` });
          await this.daemons.waitIdle(watch, this.config.watches.wait_timeout_ms);
        }
        const channelName = watch.is_dm ? null : await this.chat.channelName(watch.channel);
        const quotedReplies = [];
        for (const r of replies) quotedReplies.push({ fromName: await this.chat.userName(r.user), text: r.text, link: await this.chat.permalink(watch.channel, r.ts) });
        const text = watchForward({ ownerName: this.ownerName(watch.owner), permalink: watch.is_dm ? null : await this.chat.permalink(watch.channel, watch.thread_ts), where: watch.is_dm ? `a DM with ${quotedReplies[0]?.fromName ?? 'someone'}` : channelName ? `#${channelName}` : null, replies: quotedReplies });
        await this.daemons.send(watch, text);
        if (this.store.getWatch(watch.id)?.state === 'active') this.store.updateWatch(watch.id, { expires_at: Date.now() + this.config.watches.ttl_ms });
        this.store.audit('watch_delivered', null, watch.owner, { watch: watch.id, batch, replies: replies.length, agent: watch.agent_id, host: watch.host });
        await update({ outcome: `*Forwarded* ${fmtTime()}${link ? ` \u00b7 <${link}|open in Paseo>` : ''}` });
      } catch (e) {
        this.log('warn', `forward to ${watch.agent_id}@${watch.host} failed: ${e.message}`);
        this.store.audit('watch_forward_failed', null, watch.owner, { watch: watch.id, batch, message: e.message });
        // Put the replies back so the owner can try again from the same card.
        await this.serial(`wr:${watch.id}`, async () => {
          this.store.setBatchState(watch.id, batch, 'forwarded', 'pending');
          const w = this.store.getWatch(watch.id);
          if (w && !w.pending_card && card.ts) this.store.updateWatch(watch.id, { pending_card: { channel: card.channel, ts: card.ts, batch, threaded: !!w.card && w.card.ts !== card.ts } });
        });
        await update({ note: `:warning: Couldn't forward: ${String(e.message).slice(0, 300)}` }).catch(() => {});
      }
    });
  }

  // ---------- session-post detection ----------
  // Which agent session posted this message with the owner's account? Read the timelines of agents that were active
  // shortly before it, on every configured daemon, and find the Slack tool call whose output names this message.

  /** A few attempts (the tool's output may not be in the timeline yet). Posts that look typed get one attempt. */
  async runDetection(msg) {
    const d = this.config.watches.detect;
    const h = msg.hints ?? {};
    const likelyApp = !!(h.app_id || h.no_client_msg_id || h.footer || msg.via_app);
    const delays = likelyApp ? d.delays_ms : d.delays_ms.slice(0, 1);
    let waited = 0;
    for (const at of delays) {
      await this.sleep(Math.max(0, at - waited)); waited = at;
      const r = await this.detectSessionPost(msg);
      if (r) return r;
    }
    if (likelyApp) this.store.audit('session_post_unmatched', null, msg.user, { channel: msg.channel, ts: msg.ts, hints: h });
    return null;
  }

  async detectSessionPost(msg) {
    const d = this.config.watches.detect;
    const post = { channel: msg.channel, ts: msg.ts, raw_text: msg.raw_text ?? msg.text, dm: !!msg.dm || String(msg.channel).startsWith('D') };
    const since = Number(msg.ts) * 1000 - d.lookback_ms;
    let best = null;
    for (const host of this.daemons.names()) {
      let agents;
      try { agents = await this.daemons.listRecentAgents(host, since); } catch (e) { this.daemonDown(host, e); continue; }
      for (const agent of agents) {
        if (agent.archived) continue;
        let entries;
        try { entries = await this.daemons.timeline(host, agent.id, { limit: d.timeline_limit }); } catch (e) { this.daemonDown(host, e); continue; }
        const m = matchPost(entries, post, { sendTools: d.send_tools_re });
        if (!m) continue;
        if (m.how === 'ts') { best = { host, agent, m }; break; }
        best ??= { host, agent, m };
      }
      if (best?.m.how === 'ts') break;
    }
    return best ? this.registerFromPost(msg, post, best) : null;
  }

  registerFromPost(msg, post, { host, agent, m }) {
    const audit = { channel: msg.channel, ts: msg.ts, agent: agent.id, host, how: m.how };
    const label = this.config.watches.detect.skip_labels.find((l) => agent.labels?.[l] !== undefined);
    if (label) { this.store.audit('session_post_skipped', null, msg.user, { ...audit, reason: `label:${label}` }); return { action: 'skipped' }; }
    if (this.store.requestBySession(agent.id)) { this.store.audit('session_post_skipped', null, msg.user, { ...audit, reason: 'lekam_session' }); return { action: 'skipped' }; }
    const expects = expectsReply(post.raw_text, { ownerIds: this.config.ownerIds, dm: post.dm });
    const r = this.store.registerWatch({ channel: msg.channel, thread_ts: msg.thread_ts ?? msg.ts, agent_id: agent.id, host, owner: msg.user, title: agent.title, message_ts: msg.ts, ttlMs: this.config.watches.ttl_ms, renewOnly: !expects, source: 'detected' });
    this.store.audit('session_post_matched', null, msg.user, { ...audit, action: r.action, watch: r.watch?.id ?? null, expects_reply: expects });
    return r;
  }

  /** An unreachable daemon is audited at most every 10 minutes per host; `lekam check` reports it. */
  daemonDown(host, e) {
    const last = this.daemonDownAt.get(host) ?? 0;
    if (Date.now() - last < 10 * 60e3) return;
    this.daemonDownAt.set(host, Date.now());
    this.log('warn', `daemon ${host} unreachable: ${e.message}`);
    this.store.audit('daemon_unreachable', null, null, { host, message: String(e.message).slice(0, 300) });
  }

  /** Every minute: expire watches, and read new registrations once (replies posted before they registered, access check). */
  async watchTick() {
    this.store.expireWatches();
    for (const w of this.store.listWatches()) if (!w.checked_at) await this.catchUpWatch(w).catch((e) => this.log('warn', `watch catch-up ${w.id}: ${e.message}`));
  }
  async catchUpWatches() {
    this.store.expireWatches();
    for (const w of this.store.listWatches()) await this.catchUpWatch(w).catch((e) => this.log('warn', `watch catch-up ${w.id}: ${e.message}`));
  }
  /** Handle messages in a watched conversation that arrived while Lekam wasn't listening. Same rules as live ones. */
  async catchUpWatch(watch) {
    if (!this.chat.readSince) return;
    let msgs;
    try { msgs = await this.chat.readSince(watch.channel, { thread_ts: watch.is_dm ? null : watch.thread_ts, oldest: watch.last_seen_ts }); }
    catch (e) {
      if (NO_ACCESS.test(e.message)) return this.watchNoAccess(watch, e.message);
      throw e;
    }
    this.store.updateWatch(watch.id, { checked_at: Date.now() });
    for (const m of msgs) {
      if (Number(m.ts) <= Number(watch.last_seen_ts)) continue;
      if (this.store.getWatch(watch.id)?.state !== 'active') return;
      const skip = (m.subtype && m.subtype !== 'thread_broadcast') || !m.user || m.bot_id || m.user === this.chat.botUserId || this.config.ownerIds.has(m.user)
        || (this.chat.botUserId && String(m.raw_text ?? '').includes(`<@${this.chat.botUserId}`)); // asked Lekam: the live bot-mention flow owns it
      const thread_ts = m.thread_ts ?? m.ts;
      const live = this.store.findByThread(watch.channel, thread_ts);
      if (skip || !String(m.text ?? '').trim() || (live && LIVE_REQUEST.has(live.state))) { this.store.watchSeen(watch.id, m.ts); continue; }
      await this.onWatchReply({ channel: watch.channel, ts: m.ts, thread_ts, user: m.user, text: m.text, kind: 'catch_up' }, watch);
    }
  }
  async watchNoAccess(watch, reason) {
    this.store.updateWatch(watch.id, { state: 'no_access' });
    this.store.audit('watch_no_access', null, watch.owner, { watch: watch.id, channel: watch.channel, reason });
    const name = watch.is_dm ? null : await this.chat.channelName(watch.channel);
    const what = watch.is_dm ? 'that DM' : name ? `#${name}` : `channel ${watch.channel}`;
    const fix = watch.is_dm
      ? `I can only read DMs people send you when \`capture_dms\` is on with the \`im:history\` user scope.`
      : `I'm not in ${what}: invite me there (\`/invite @${this.chat.appName ?? 'Lekam'}\`), then have the session post in the thread again.`;
    await this.chat.dm(watch.owner, `I can't watch ${what} for *${watch.title || 'an agent session'}*, so replies there won't reach it. ${fix}`).catch(() => {});
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
