// Scripted executor for tests. `script` maps phase -> result text or function.
export class FakeExecutor {
  constructor({ script = {}, delayMs = 0 } = {}) { this.script = script; this.delayMs = delayMs; this.calls = []; this.sessions = new Map(); this.n = 0; }
  async connect() {} async close() {} async check() { return { url: 'fake', provider: 'fake' }; }
  agentLink(id) { return id ? `fake://agent/${id}` : null; }
  async alive(request) { const s = this.sessions.get(request.id); return !!s && !s.archived; }
  async find() { return null; }
  _result(phase, args) { const v = this.script[phase] ?? `done ${phase}`; return typeof v === 'function' ? v(args) : { status: 'idle', text: v, error: null }; }
  async _wait() { if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs)); }
  async start(args) { this.calls.push(['start', args]); const id = `agent${++this.n}`; this.sessions.set(args.request.id, { id }); await args.onStarted?.(id); await this._wait(); return { sessionId: id, result: this._result('start', args) }; }
  async startInvestigation(args) { this.calls.push(['investigate', args]); const id = `agent${++this.n}`; this.sessions.set(args.request.id, { id }); await args.onStarted?.(id); await this._wait(); return { sessionId: id, result: this._result('investigate', args) }; }
  async proceed(args) { this.calls.push(['proceed', args]); await this._wait(); return { sessionId: this.sessions.get(args.request.id)?.id, result: this._result('proceed', args) }; }
  async send(args) { this.calls.push(['send', args]); await this._wait(); return { sessionId: this.sessions.get(args.request.id)?.id, result: this._result('send', args) }; }
  async archive(request) { const s = this.sessions.get(request.id); if (s) s.archived = true; }
}

// Scripted stand-in for Daemons (thread watches). `agents` maps agent id -> { host, status, archived, title, labels,
// updatedAt }, `timelines` maps agent id -> timeline entries, `down` lists unreachable hosts.
export class FakeDaemons {
  constructor({ agents = {}, timelines = {}, hosts = { local: 'local' }, down = [] } = {}) {
    Object.assign(this, { agents, timelines, hosts, down: new Set(down) }); this.calls = [];
  }
  names() { return Object.keys(this.hosts); }
  knows(host) { return host in this.hosts; }
  agentLink(id) { return id ? `fake://agent/${id}` : null; }
  _up(host) { if (this.down.has(host)) throw new Error(`${host}: connect ECONNREFUSED`); }
  async listRecentAgents(host, sinceMs) {
    this.calls.push(['list', host]); this._up(host);
    return Object.entries(this.agents).filter(([, a]) => (a.host ?? 'local') === host && (a.updatedAt ?? Date.now()) >= sinceMs)
      .sort(([, a], [, b]) => (b.updatedAt ?? Date.now()) - (a.updatedAt ?? Date.now()))
      .map(([id, a]) => ({ id, title: a.title ?? null, status: a.status ?? 'idle', labels: a.labels ?? {}, archived: !!a.archived, updatedAt: a.updatedAt ?? Date.now() }));
  }
  async timeline(host, agentId) { this.calls.push(['timeline', host, agentId]); this._up(host); const t = this.timelines[agentId]; return (typeof t === 'function' ? t() : t) ?? []; }
  async status({ agent_id, host }) { this.calls.push(['status', agent_id, host]); this._up(host); const a = this.agents[agent_id]; if (!a) throw new Error(`agent ${agent_id} not found`); return { status: a.status ?? 'idle', archived: !!a.archived, title: a.title ?? null }; }
  async waitIdle({ agent_id, host }, timeoutMs) { this.calls.push(['wait', agent_id, host, timeoutMs]); const a = this.agents[agent_id]; if (a?.waitError) throw new Error(a.waitError); if (a) a.status = 'idle'; }
  async send({ agent_id, host }, text) { this.calls.push(['send', agent_id, host, text]); const a = this.agents[agent_id]; if (a?.sendError) throw new Error(a.sendError); }
  async check(host) { this._up(host); return { ok: true, agents: Object.keys(this.agents).length }; }
  async close() {}
}
