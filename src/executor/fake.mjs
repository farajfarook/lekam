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
