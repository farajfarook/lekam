// One Paseo agent per DM thread, found again by its labels (so a Lekam restart loses nothing but in-flight replies).

export class Sessions {
  constructor({ url, provider, cwd, label = 'Lekam', labelColor = 'amber', createClient = null, createLabelClient = null, log = () => {} }) {
    Object.assign(this, { url, provider, cwd, label, labelColor, log });
    this.createClient = createClient ?? (async () => { const { createPaseoClient } = await import('@getpaseo/client'); return createPaseoClient({ url }); });
    // Workspace labels are only on the low-level daemon client.
    this.createLabelClient = createLabelClient ?? (async () => {
      const { DaemonClient } = await import('@getpaseo/client/internal/daemon-client');
      return new DaemonClient({ url, clientId: `lekam-labels-${process.pid}`, clientType: 'cli' });
    });
    this.client = null; this.labelClient = null;
  }

  async connect() {
    if (!this.client) { const c = await this.createClient(); await c.connect(); this.client = c; }
    return this.client;
  }
  async close() {
    try { await this.client?.close(); } catch {} this.client = null;
    try { await this.labelClient?.close(); } catch {} this.labelClient = null;
  }

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

  /** New session for a DM thread, in its own workspace titled `title` and labelled Lekam; its first turn starts with `prompt`. */
  async start(thread, { title, prompt }) {
    const c = await this.connect();
    const fs = await import('node:fs');
    fs.mkdirSync(this.cwd, { recursive: true });
    // A user-set workspace title stops Paseo naming the workspace after the first lines of the prompt.
    const ws = await c.workspaces.create({ source: { kind: 'directory', path: this.cwd }, title });
    const h = await ws.agents.create({ config: { provider: this.provider }, title, labels: this.labels(thread), prompt });
    await this.labelWorkspace(ws.id);
    return h;
  }

  /** Put the workspace under the Lekam sidebar label; the daemon creates the label if it doesn't exist. Never fails the turn. */
  async labelWorkspace(workspaceId) {
    if (!this.label) return;
    try {
      if (!this.labelClient) { const lc = await this.createLabelClient(); await lc.connect(); this.labelClient = lc; }
      const existing = ((await this.labelClient.listWorkspaceLabels())?.labels ?? []).find((l) => l.name.toLowerCase() === this.label.toLowerCase());
      await this.labelClient.setWorkspaceLabel({ workspaceId, label: existing ? { name: existing.name, color: existing.color } : { name: this.label, color: this.labelColor }, assigned: true });
    } catch (e) {
      this.log('warn', `labelling workspace ${workspaceId} failed: ${e.message}`);
      try { await this.labelClient?.close(); } catch {} this.labelClient = null;
    }
  }
}
