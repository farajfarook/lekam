// One Paseo agent per DM thread, on one of several hosts (this machine's daemon, others over SSH).
// Sessions are found again by their labels on any host, so a Lekam restart loses nothing but in-flight replies.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

/** Pure: "banana=ws://127.0.0.1:6767/ws,orange=ssh://root@orange.internal" -> [{ name, target }]. */
export function parseHosts(spec) {
  const hosts = String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.indexOf('=');
    if (i < 1) throw new Error(`LEKAM_HOSTS entry "${s}" must be name=target`);
    return { name: s.slice(0, i).trim(), target: s.slice(i + 1).trim() };
  });
  if (!hosts.length) throw new Error('LEKAM_HOSTS has no hosts');
  return hosts;
}

/** Pure: the host named in a note ("run it on orange"), or null. */
export function hostInNote(note, names) {
  for (const n of names) if (new RegExp(`\\bon\\s+${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(note ?? '')) return n;
  return null;
}

const sshDest = (target) => { const u = new URL(target); return `${u.username ? `${u.username}@` : ''}${u.hostname}`; };

export class Sessions {
  /**
   * @param {object} o
   * @param {{name:string,target:string}[]} o.hosts  first one is the fallback
   * @param {() => Promise<string|null>} [o.pickHost]  free-capacity choice when the note names no host
   */
  constructor({ hosts, provider, cwd, label = 'Lekam', labelColor = 'amber', pickHost = async () => null, connect = null, mkdir = null, log = () => {} }) {
    Object.assign(this, { hosts, provider, cwd, label, labelColor, pickHost, log });
    this.connectHost = connect ?? (async ({ name, target }) => {
      const { createHostClient } = await import('@getpaseo/client/node');
      const { createPaseoApi } = await import('@getpaseo/client');
      const daemon = createHostClient(target, { clientId: `lekam-${name}-${process.pid}`, clientType: 'cli' });
      await daemon.connect();
      return { daemon, api: createPaseoApi(daemon) };
    });
    this.mkdir = mkdir ?? ((host) => (host.target.startsWith('ssh://')
      ? new Promise((resolve, reject) => execFile('ssh', ['-o', 'BatchMode=yes', sshDest(host.target), 'mkdir', '-p', this.cwd], { timeout: 30e3 }, (e) => (e ? reject(e) : resolve())))
      : fs.promises.mkdir(this.cwd, { recursive: true })));
    this.conns = new Map(); // host name -> Promise<{ daemon, api }>
  }

  names() { return this.hosts.map((h) => h.name); }
  host(name) { const h = this.hosts.find((x) => x.name === name); if (!h) throw new Error(`unknown host ${name}`); return h; }
  labels(thread) { return { lekam: 'dm', lekam_thread: thread }; }
  link(id) { return `paseo://agent/${id}`; }

  /** The host's connection; dropped on failure so the next call reconnects. */
  async conn(name) {
    let p = this.conns.get(name);
    if (!p) {
      p = this.connectHost(this.host(name));
      this.conns.set(name, p);
      p.catch(() => { if (this.conns.get(name) === p) this.conns.delete(name); });
    }
    return p;
  }
  async drop(name) { const p = this.conns.get(name); this.conns.delete(name); try { (await p)?.daemon?.close?.(); } catch {} }
  async close() { for (const n of [...this.conns.keys()]) await this.drop(n); }

  /** Where a new session goes: a host named in the note wins, else the one with the most free capacity, else the first. */
  async chooseHost(note) {
    const named = hostInNote(note, this.names());
    if (named) return named;
    const best = await this.pickHost().catch((e) => { this.log('warn', `capacity check failed: ${e.message}`); return null; });
    return this.names().includes(best) ? best : this.hosts[0].name;
  }

  /** The live session for a DM thread on any host: { handle, host } or null. Unreachable hosts are skipped. */
  async find(thread) {
    const found = await Promise.all(this.names().map(async (name) => {
      try {
        const { api } = await this.conn(name);
        const r = await api.agents.list({ filter: { labels: this.labels(thread) }, sort: [{ key: 'created_at', direction: 'desc' }], page: { limit: 1 } });
        const e = r.entries?.[0];
        const id = e?.agent?.id ?? e?.id;
        if (!id) return null;
        const handle = api.agents.ref(id);
        const s = await handle.refresh().catch(() => null);
        if (!s?.agent || s.agent.archivedAt || s.agent.status === 'closed') return null;
        return { handle, host: name };
      } catch (e) { this.log('warn', `${name}: ${e.message}`); await this.drop(name); return null; }
    }));
    return found.find(Boolean) ?? null;
  }

  /** New session on `host`, in its own workspace titled `title` and labelled Lekam; its first turn starts with `prompt`. */
  async start(thread, { title, prompt, host }) {
    const h = this.host(host);
    await this.mkdir(h);
    try {
      const { api, daemon } = await this.conn(host);
      // A user-set workspace title stops Paseo naming the workspace after the first lines of the prompt.
      const ws = await api.workspaces.create({ source: { kind: 'directory', path: this.cwd }, title });
      const handle = await ws.agents.create({ config: { provider: this.provider }, title, labels: this.labels(thread), prompt });
      await this.labelWorkspace(daemon, ws.id);
      return { handle, host };
    } catch (e) { await this.drop(host); throw new Error(`${host}: ${e.message}`); }
  }

  /** Put the workspace under the Lekam sidebar label; the daemon creates the label if it doesn't exist. Never fails the turn. */
  async labelWorkspace(daemon, workspaceId) {
    if (!this.label) return;
    try {
      const existing = ((await daemon.listWorkspaceLabels())?.labels ?? []).find((l) => l.name.toLowerCase() === this.label.toLowerCase());
      await daemon.setWorkspaceLabel({ workspaceId, label: existing ? { name: existing.name, color: existing.color } : { name: this.label, color: this.labelColor }, assigned: true });
    } catch (e) { this.log('warn', `labelling workspace ${workspaceId} failed: ${e.message}`); }
  }
}
