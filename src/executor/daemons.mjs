// Connections to the Paseo daemons that thread watches deal with: this machine's daemon over WebSocket and other
// machines' over SSH (the SDK's own host transport, which runs `ssh` itself; no port is opened anywhere).
// One client per host, created on first use and dropped on failure so the next call reconnects.
import { ExecutorError } from './paseo.mjs';

export const HOST_TARGET = /^(local|wss?:\/\/\S+|ssh:\/\/\S+)$/;

export class Daemons {
  /**
   * @param {object} o
   * @param {Record<string,string>} o.hosts  host name -> "local" | ws(s)://… | ssh://user@host[?daemonPort=N]
   * @param {string} o.localUrl              what "local" means (the owner executor's paseo_url)
   * @param {(url:string, host:string)=>Promise<object>} [o.createClient] returns an unconnected DaemonClient-like object
   */
  constructor({ hosts = {}, localUrl = 'ws://127.0.0.1:6767/ws', createClient = null, log = () => {} } = {}) {
    Object.assign(this, { hosts, localUrl, log });
    this.createClient = createClient ?? (async (url, host) => {
      const { createHostClient } = await import('@getpaseo/client/node');
      return createHostClient(url, { clientId: `lekam-watch-${host}-${process.pid}`, clientType: 'cli' });
    });
    this.clients = new Map(); // host -> Promise<client>
  }

  names() { return Object.keys(this.hosts); }
  knows(host) { return Object.prototype.hasOwnProperty.call(this.hosts, host); }
  target(host) { const t = this.hosts[host]; return t === 'local' ? this.localUrl : t; }
  agentLink(agentId) { return agentId ? `paseo://agent/${agentId}` : null; }

  client(host) {
    if (!this.knows(host)) return Promise.reject(new ExecutorError(`unknown host "${host}" (add it under watches.hosts)`));
    let p = this.clients.get(host);
    if (!p) {
      p = (async () => { const c = await this.createClient(this.target(host), host); await c.connect(); return c; })();
      this.clients.set(host, p);
      p.catch(() => { if (this.clients.get(host) === p) this.clients.delete(host); });
    }
    return p;
  }

  /** Run `fn(client)`; on any failure drop the connection (the next call reconnects) and rethrow with the host name. */
  async call(host, fn) {
    try { return await fn(await this.client(host)); }
    catch (e) {
      const p = this.clients.get(host);
      this.clients.delete(host);
      p?.then((c) => c.close?.()).catch(() => {});
      throw e instanceof ExecutorError ? e : new ExecutorError(`${host}: ${e?.message ?? e}`);
    }
  }

  /** Agents updated at or after `sinceMs`, newest first: [{ id, title, status, labels, archived, updatedAt }]. */
  async listRecentAgents(host, sinceMs, { limit = 30 } = {}) {
    const r = await this.call(host, (c) => c.fetchAgents({ page: { limit }, sort: [{ key: 'updated_at', direction: 'desc' }] }));
    const out = [];
    for (const e of r?.entries ?? []) {
      const a = e.agent ?? e;
      const at = Date.parse(a.updatedAt ?? a.lastActivityAt ?? '') || 0;
      if (at < sinceMs) break;
      out.push({ id: a.id, title: a.title ?? null, status: String(a.status ?? 'unknown').toLowerCase(), labels: a.labels ?? {}, archived: !!a.archivedAt, updatedAt: at });
    }
    return out;
  }

  /** The newest `limit` timeline entries of an agent ({ item, timestamp, … }). */
  async timeline(host, agentId, { limit = 150 } = {}) {
    const r = await this.call(host, (c) => c.fetchAgentTimeline(agentId, { direction: 'tail', limit }));
    return r?.entries ?? [];
  }

  /** { status, archived, title }; throws when the agent can't be found. */
  async status({ agent_id, host }) {
    const r = await this.call(host, (c) => c.fetchAgent(agent_id));
    const a = r?.agent ?? r;
    if (!a?.id) throw new ExecutorError(`agent ${agent_id} not found on ${host}`);
    return { status: String(a.status ?? 'unknown').toLowerCase(), archived: !!a.archivedAt, title: a.title ?? null };
  }

  /** Resolve once the agent's current turn has finished (immediately when idle). */
  async waitIdle({ agent_id, host }, timeoutMs) {
    const r = await this.call(host, (c) => c.waitForFinish(agent_id, timeoutMs));
    if (r?.status === 'running' || r?.status === 'timeout') throw new ExecutorError(`the session is still busy after ${Math.round(timeoutMs / 60e3)} min`);
  }

  /** Start a new turn with `text`. Call after waitIdle; if a turn started in between, the text joins it instead of interrupting it. */
  async send({ agent_id, host }, text) {
    await this.call(host, (c) => c.sendAgentMessage(agent_id, text, { activeTurnBehavior: 'steer' }));
  }

  /** For `lekam check`: reachable and how many agents it reports. */
  async check(host) {
    const r = await this.call(host, (c) => c.fetchAgents({ page: { limit: 1 } }));
    return { ok: true, agents: r?.entries?.length ?? 0 };
  }

  async close() {
    for (const p of this.clients.values()) p.then((c) => c.close?.()).catch(() => {});
    this.clients.clear();
  }
}
