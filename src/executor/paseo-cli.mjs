// Talks to Paseo agents Lekam didn't start (thread watches) through the `paseo` CLI, on this machine's daemon or
// another host's (`--host ssh://user@host`). The CLI already handles SSH transport, so no port is opened anywhere.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ExecutorError } from './paseo.mjs';

/** Run a command; resolves stdout, rejects with stderr (or stdout) in the message. */
export function runCommand(bin, args, { timeout = 60e3 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || stdout || err.message).replace(/\s+/g, ' ').trim().slice(0, 300);
        return reject(new ExecutorError(err.killed ? `paseo ${args[0]} timed out` : detail || `paseo ${args[0]} failed`));
      }
      resolve(String(stdout));
    });
  });
}

export class PaseoCli {
  /** @param {object} o config.watches + { run? } */
  constructor({ paseo_bin = 'paseo', hosts = {}, run = runCommand, log = () => {} } = {}) {
    Object.assign(this, { bin: paseo_bin, hosts, run, log });
  }

  knows(host) { return Object.prototype.hasOwnProperty.call(this.hosts, host); }
  hostArgs(host) {
    if (!this.knows(host)) throw new ExecutorError(`unknown host "${host}" (add it under watches.hosts)`);
    const t = this.hosts[host];
    return t === 'local' ? [] : ['--host', t];
  }
  agentLink(agentId) { return agentId ? `paseo://agent/${agentId}` : null; }

  /** { status: 'idle'|'running'|'closed'|..., archived, title } or throws when the agent can't be found. */
  async status({ agent_id, host }) {
    const out = await this.run(this.bin, ['inspect', agent_id, '--json', ...this.hostArgs(host)], { timeout: 60e3 });
    let j;
    try { j = JSON.parse(out); } catch { throw new ExecutorError(`unexpected output from paseo inspect: ${out.slice(0, 120)}`); }
    const status = String(j.Status ?? j.status ?? 'unknown').toLowerCase();
    return { status, archived: !!(j.Archived ?? j.archived ?? j.ArchivedAt ?? j.archivedAt), title: j.Name ?? j.name ?? null };
  }

  /** Resolve once the agent is idle (its current turn finished). */
  async waitIdle({ agent_id, host }, timeoutMs) {
    const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
    await this.run(this.bin, ['wait', agent_id, '--timeout', String(secs), ...this.hostArgs(host)], { timeout: timeoutMs + 60e3 });
  }

  /** Start a new turn with `text`; returns without waiting for the turn to finish. */
  async send({ agent_id, host }, text) {
    const file = path.join(os.tmpdir(), `lekam-forward-${crypto.randomBytes(6).toString('hex')}.txt`);
    fs.writeFileSync(file, text, { mode: 0o600 });
    try { await this.run(this.bin, ['send', agent_id, '--prompt-file', file, '--no-wait', ...this.hostArgs(host)], { timeout: 120e3 }); }
    finally { fs.rmSync(file, { force: true }); }
  }
}
