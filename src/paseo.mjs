// One Paseo agent per DM thread, found again by its labels (so a Lekam restart loses nothing but in-flight replies).

export class Sessions {
  constructor({ url, provider, cwd, createClient = null, log = () => {} }) {
    Object.assign(this, { url, provider, cwd, log });
    this.createClient = createClient ?? (async () => { const { createPaseoClient } = await import('@getpaseo/client'); return createPaseoClient({ url }); });
    this.client = null;
  }

  async connect() {
    if (!this.client) { const c = await this.createClient(); await c.connect(); this.client = c; }
    return this.client;
  }
  async close() { try { await this.client?.close(); } catch {} this.client = null; }

  labels(thread) { return { lekam: 'dm', lekam_thread: thread }; }
  link(id) { return `paseo://agent/${id}`; }

  /** The live session for a DM thread, or null (none yet, archived or closed). */
  async find(thread) {
    const c = await this.connect();
    const r = await c.agents.list({ filter: { labels: this.labels(thread) }, sort: [{ key: 'created_at', direction: 'desc' }], page: { limit: 1 } });
    const e = r.entries?.[0];
    const id = e?.agent?.id ?? e?.id;
    if (!id) return null;
    const h = c.agents.ref(id);
    const s = await h.refresh().catch(() => null);
    if (!s?.agent || s.agent.archivedAt || s.agent.status === 'closed') return null;
    return h;
  }

  /** New session for a DM thread; its first turn starts with `prompt`. */
  async start(thread, { title, prompt }) {
    const c = await this.connect();
    const fs = await import('node:fs');
    fs.mkdirSync(this.cwd, { recursive: true });
    return c.agents.create({ config: { provider: this.provider }, cwd: this.cwd, title, labels: this.labels(thread), prompt });
  }
}
