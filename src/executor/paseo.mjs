// Paseo executor: one agent per request, labelled with the chat thread; concurrency per owner.
import fs from 'node:fs';
import { workerPrompt, investigatePrompt, proceedPrompt, handoffPrompt } from './briefs.mjs';

export class ExecutorError extends Error {}

class Semaphore {
  constructor(n) { this.n = n; this.active = 0; this.queue = []; }
  get waiting() { return this.queue.length; }
  async acquire(onQueued) {
    if (this.active < this.n) { this.active++; return; }
    await new Promise((resolve) => { this.queue.push(resolve); onQueued?.(this.queue.length); });
    this.active++;
  }
  release() { this.active = Math.max(0, this.active - 1); const next = this.queue.shift(); if (next) next(); }
}

export class PaseoExecutor {
  /** @param {object} o owner.executor + { config, log, createClient? } */
  constructor({ paseo_url, provider, cwd, max_concurrent = 2, run_timeout_ms = 45 * 60e3, workspace_label = 'Lekam', workspace_label_color = 'amber', config, log = () => {}, createClient = null, createLabelClient = null }) {
    Object.assign(this, { paseo_url, provider, cwd, run_timeout_ms, workspace_label, workspace_label_color, config, log });
    // Workspace labels live on the low-level daemon client; the SDK facade doesn't expose them.
    this.createLabelClient = createLabelClient ?? (async () => {
      const { DaemonClient } = await import('@getpaseo/client/internal/daemon-client');
      return new DaemonClient({ url: paseo_url, clientId: `lekam-labels-${process.pid}`, clientType: 'cli' });
    });
    this.labelClient = null;
    this.sem = new Semaphore(max_concurrent);
    this.createClient = createClient ?? (async () => { const { createPaseoClient } = await import('@getpaseo/client'); return createPaseoClient({ url: paseo_url }); });
    this.client = null; this.handles = new Map();
  }

  async connect() {
    if (this.client) return this.client;
    this.client = await this.createClient();
    await this.client.connect();
    return this.client;
  }
  async close() {
    try { await this.client?.close(); } catch {} this.client = null;
    try { await this.labelClient?.close(); } catch {} this.labelClient = null;
  }

  /**
   * Put the agent's workspace under the "Lekam" label in Paseo. Reuses an existing label with that name
   * (any case, keeping its colour); otherwise the daemon creates it. Never fails the run.
   */
  async labelWorkspace(handle) {
    if (!this.workspace_label) return;
    try {
      const workspaceId = handle.workspaceId ?? handle.current?.()?.workspaceId ?? (await handle.refresh?.())?.agent?.workspaceId;
      if (!workspaceId) { this.log('warn', `no workspace id for agent ${handle.id}; not labelled`); return; }
      if (!this.labelClient) { this.labelClient = await this.createLabelClient(); await this.labelClient.connect(); }
      const want = this.workspace_label.replace(/\s+/g, ' ').trim();
      const existing = ((await this.labelClient.listWorkspaceLabels())?.labels ?? []).find((l) => l.name.toLowerCase() === want.toLowerCase());
      const label = existing ? { name: existing.name, color: existing.color } : { name: want, color: this.workspace_label_color };
      await this.labelClient.setWorkspaceLabel({ workspaceId, label, assigned: true });
    } catch (e) {
      this.log('warn', `labelling workspace for agent ${handle.id} failed: ${e.message}`);
      try { await this.labelClient?.close(); } catch {} this.labelClient = null; // reconnect next time
    }
  }

  /** Used by `lekam check`: daemon reachable and provider available. */
  async check() {
    await this.connect();
    const avail = await this.client.providers.listAvailable();
    const list = avail?.providers ?? avail ?? [];
    const base = String(this.provider).split('/')[0];
    const p = Array.isArray(list) ? list.find((x) => (x.provider ?? x.id ?? x) === base) : null;
    if (!p) throw new ExecutorError(`provider "${base}" not reported by daemon at ${this.paseo_url}`);
    if (p.available === false) throw new ExecutorError(`provider "${base}" unavailable on daemon: ${p.error ?? 'no reason given'}`);
    if (!String(this.provider).includes('/')) {
      const m = await this.client.providers.listModels(base).catch(() => null);
      const ids = (m?.models ?? []).slice(0, 8).map((x) => `${base}/${x.id}`);
      throw new ExecutorError(`executor.provider must be "provider/model", e.g. ${ids[0] ?? base + '/<model>'}${ids.length ? ' (also: ' + ids.slice(1).join(', ') + ')' : ''}`);
    }
    fs.mkdirSync(this.cwd, { recursive: true });
    return { url: this.paseo_url, provider: this.provider };
  }

  labelsFor(request) { return { lekam: '1', request_id: request.id, channel: request.channel, thread_ts: request.thread_ts, owner: request.owner }; }
  agentLink(agentId) { return agentId ? `paseo://agent/${agentId}` : null; }

  async _create(request, prompt, title) {
    await this.connect();
    fs.mkdirSync(this.cwd, { recursive: true }); // Paseo removes a workspace directory when its last agent is archived
    const h = await this.client.agents.create({ config: { provider: this.provider }, cwd: this.cwd, title: title?.slice(0, 80), labels: this.labelsFor(request), prompt });
    this.handles.set(request.id, h);
    await this.labelWorkspace(h);
    return h;
  }

  async _handle(request) {
    if (this.handles.has(request.id)) return this.handles.get(request.id);
    if (!request.session_id) return null;
    await this.connect();
    const h = this.client.agents.ref(request.session_id);
    const r = await h.refresh().catch(() => null);
    if (!r?.agent || r.agent.archivedAt || r.agent.status === 'closed') return null;
    this.handles.set(request.id, h);
    return h;
  }

  /** Is the request's session alive on the daemon? */
  async alive(request) { return !!(await this._handle(request)); }

  /** Find an agent by thread labels (store-loss recovery). Returns agent id or null. */
  async find({ channel, thread_ts }) {
    await this.connect();
    const r = await this.client.agents.list({ filter: { labels: { lekam: '1', channel, thread_ts } }, sort: [{ key: 'created_at', direction: 'desc' }], page: { limit: 1 } });
    const e = r.entries?.[0];
    return e?.agent?.id ?? e?.id ?? null;
  }

  /** Start the real work. Resolves when the turn finishes with { sessionId, result }. onStarted(sessionId) fires once the agent exists. */
  async start({ request, brief, allowed, permalink, requesterName, channelName = null, thread = [], previousOutcome = null, onQueued, onStarted }) {
    await this.sem.acquire(onQueued);
    try {
      const prompt = previousOutcome
        ? handoffPrompt({ config: this.config, request, brief, allowed, previousOutcome, permalink, requesterName, channelName, thread })
        : workerPrompt({ config: this.config, request, brief, allowed, permalink, requesterName, channelName, thread });
      const h = await this._create(request, prompt, brief.summary);
      await onStarted?.(h.id);
      const result = await h.waitForFinish(this.run_timeout_ms);
      return { sessionId: h.id, result: normalise(result) };
    } finally { this.sem.release(); }
  }

  /** Discuss-first: create the session with the investigate brief; resolves after its first turn. */
  async startInvestigation({ request, brief, permalink, requesterName, channelName = null, thread = [], onStarted }) {
    const prompt = investigatePrompt({ config: this.config, request, brief, allowed: [], permalink, requesterName, channelName, thread });
    const h = await this._create(request, prompt, `Investigate: ${brief.summary}`);
    await onStarted?.(h.id);
    const result = await h.waitForFinish(this.run_timeout_ms);
    return { sessionId: h.id, result: normalise(result) };
  }

  /** Owner has reviewed the plan: send the go brief to the same session (takes a concurrency slot). */
  async proceed({ request, brief, allowed, onQueued }) {
    const h = await this._handle(request);
    if (!h) throw new ExecutorError('session is gone');
    await this.sem.acquire(onQueued);
    try {
      const result = await h.run(proceedPrompt({ brief, allowed, config: this.config, request }), { timeoutMs: this.run_timeout_ms });
      return { sessionId: h.id, result: normalise(result) };
    } finally { this.sem.release(); }
  }

  /** Follow-up text to a live session. Resolves with the turn result. */
  async send({ request, text }) {
    const h = await this._handle(request);
    if (!h) throw new ExecutorError('session is gone');
    const result = await h.run(text, { timeoutMs: this.run_timeout_ms });
    return { sessionId: h.id, result: normalise(result) };
  }

  async archive(request) {
    const h = await this._handle(request);
    if (h) { try { await h.archive(); } catch (e) { this.log('warn', `archive failed: ${e.message}`); } }
    this.handles.delete(request.id);
  }
}

function normalise(r) {
  return { status: r?.status ?? 'error', text: r?.lastMessage ?? '', error: r?.error ?? null };
}
