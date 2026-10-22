// SQLite store on node:sqlite. Requests, sessions, event dedupe, append-only audit.
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canTransition, IllegalTransition, isTerminal } from '../core/state.mjs';

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS requests (
     id TEXT PRIMARY KEY, kind TEXT NOT NULL, channel TEXT NOT NULL, thread_ts TEXT NOT NULL,
     origin_ts TEXT NOT NULL, requester TEXT NOT NULL, owner TEXT NOT NULL, state TEXT NOT NULL,
     request_text TEXT NOT NULL, classification TEXT, brief TEXT, scope TEXT, approval_mode TEXT,
     card TEXT, session_id TEXT, outcome TEXT, auto_post INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER);
   CREATE INDEX IF NOT EXISTS requests_thread ON requests(channel, thread_ts, created_at);
   CREATE INDEX IF NOT EXISTS requests_state ON requests(state);
   CREATE TABLE IF NOT EXISTS sessions (
     request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
     started_at INTEGER NOT NULL, finished_at INTEGER);
   CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS audit (
     seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL,
     request_id TEXT, actor TEXT, data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS audit_req ON audit(request_id);
   CREATE TABLE IF NOT EXISTS rate (requester TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS rate_req ON rate(requester, at);`,
  `CREATE TABLE IF NOT EXISTS threads (channel TEXT NOT NULL, thread_ts TEXT NOT NULL, last_bot_post_at INTEGER NOT NULL, PRIMARY KEY(channel, thread_ts));`,
];

const J = (v) => (v === null || v === undefined ? null : JSON.stringify(v));
const P = (s) => (s === null || s === undefined ? null : JSON.parse(s));

function rowToRequest(r) {
  if (!r) return null;
  return { ...r, classification: P(r.classification), brief: P(r.brief), scope: P(r.scope), card: P(r.card), outcome: P(r.outcome), auto_post: !!r.auto_post };
}

export class Store {
  constructor(file, { redact = [] } = {}) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.redact = redact.filter((s) => typeof s === 'string' && s.length >= 8);
    this.migrate();
  }

  migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const row = this.db.prepare(`SELECT value FROM meta WHERE key='schema'`).get();
    const v = row ? Number(row.value) : 0;
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.db.exec(MIGRATIONS[i]);
      this.db.prepare(`INSERT OR REPLACE INTO meta(key,value) VALUES('schema',?)`).run(String(i + 1));
    }
  }

  close() { this.db.close(); }

  // ---- requests ----
  createRequest(r) {
    const now = Date.now();
    const id = r.id ?? crypto.randomBytes(5).toString('hex');
    this.db.prepare(`INSERT INTO requests(id,kind,channel,thread_ts,origin_ts,requester,owner,state,request_text,classification,brief,scope,approval_mode,card,session_id,outcome,auto_post,created_at,updated_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, r.kind, r.channel, r.thread_ts, r.origin_ts, r.requester, r.owner, 'NEW', r.request_text, J(r.classification), J(r.brief), null, null, null, null, null, r.auto_post ? 1 : 0, now, now, r.expires_at ?? null);
    this.audit('request_created', id, r.requester, { kind: r.kind, channel: r.channel, thread_ts: r.thread_ts });
    return this.getRequest(id);
  }

  getRequest(id) { return rowToRequest(this.db.prepare(`SELECT * FROM requests WHERE id=?`).get(id)); }

  findByThread(channel, thread_ts) {
    const rows = this.db.prepare(`SELECT * FROM requests WHERE channel=? AND thread_ts=? ORDER BY created_at DESC`).all(channel, thread_ts);
    const live = rows.find((r) => !isTerminal(r.state));
    return rowToRequest(live ?? rows[0] ?? null);
  }

  findByCard(channel, ts) {
    // A card's session thread is anchored on the card itself, or on the owner's own DM message the card replied to.
    return rowToRequest(this.db.prepare(`SELECT * FROM requests WHERE json_extract(card,'$.channel')=? AND (json_extract(card,'$.ts')=? OR json_extract(card,'$.thread')=?) ORDER BY created_at DESC LIMIT 1`).get(channel, ts, ts));
  }

  listByState(...states) {
    const q = states.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM requests WHERE state IN (${q}) ORDER BY created_at ASC`).all(...states).map(rowToRequest);
  }

  countPendingForOwner(owner) {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE owner=? AND state='PENDING_APPROVAL'`).get(owner).n;
  }

  updateRequest(id, fields) {
    const cols = [], vals = [];
    for (const [k, v] of Object.entries(fields)) {
      cols.push(`${k}=?`);
      vals.push(['classification', 'brief', 'scope', 'card', 'outcome'].includes(k) ? J(v) : k === 'auto_post' ? (v ? 1 : 0) : v);
    }
    cols.push('updated_at=?'); vals.push(Date.now()); vals.push(id);
    this.db.prepare(`UPDATE requests SET ${cols.join(',')} WHERE id=?`).run(...vals);
    return this.getRequest(id);
  }

  /** Enforced state transition. Throws IllegalTransition (and audits) when not allowed. */
  transition(id, to, { actor = null, data = {} } = {}) {
    const r = this.getRequest(id);
    if (!r) throw new Error(`no such request ${id}`);
    if (!canTransition(r.state, to)) {
      this.audit('illegal_transition', id, actor, { from: r.state, to });
      throw new IllegalTransition(r.state, to);
    }
    this.db.prepare(`UPDATE requests SET state=?, updated_at=? WHERE id=?`).run(to, Date.now(), id);
    this.audit('transition', id, actor, { from: r.state, to, ...data });
    return this.getRequest(id);
  }

  expired(now = Date.now()) {
    return this.db.prepare(`SELECT * FROM requests WHERE state='PENDING_APPROVAL' AND expires_at IS NOT NULL AND expires_at<=?`).all(now).map(rowToRequest);
  }

  recentOutcomes(n) {
    return this.db.prepare(`SELECT * FROM requests WHERE state IN ('DONE','RELEASED') AND outcome IS NOT NULL ORDER BY updated_at DESC LIMIT ?`).all(n).map(rowToRequest)
      .map((r) => {
        const d = new Date(r.updated_at).toISOString().slice(0, 10);
        const first = String(r.outcome?.summary ?? r.outcome?.text ?? '').split('\n')[0];
        return `${d} ${r.requester}: ${r.brief?.summary ?? r.request_text.slice(0, 60)} -> ${first}`.slice(0, 200);
      });
  }

  // ---- sessions ----
  setSession(request_id, session_id) {
    this.db.prepare(`INSERT OR REPLACE INTO sessions(request_id,session_id,status,started_at,finished_at) VALUES(?,?,?,?,NULL)`).run(request_id, session_id, 'running', Date.now());
    this.updateRequest(request_id, { session_id });
  }
  finishSession(request_id, status = 'finished') {
    this.db.prepare(`UPDATE sessions SET status=?, finished_at=? WHERE request_id=?`).run(status, Date.now(), request_id);
  }
  getSession(request_id) { return this.db.prepare(`SELECT * FROM sessions WHERE request_id=?`).get(request_id) ?? null; }

  // ---- thread engagement (bot has spoken here recently) ----
  touchThread(channel, thread_ts, now = Date.now()) {
    this.db.prepare(`INSERT OR REPLACE INTO threads(channel,thread_ts,last_bot_post_at) VALUES(?,?,?)`).run(channel, thread_ts, now);
  }
  botSpokeRecently(channel, thread_ts, { withinMs = 24 * 36e5, now = Date.now() } = {}) {
    const r = this.db.prepare(`SELECT last_bot_post_at FROM threads WHERE channel=? AND thread_ts=?`).get(channel, thread_ts);
    return !!r && now - r.last_bot_post_at < withinMs;
  }

  // ---- dedupe ----
  seen(event_id, { ttlMs = 24 * 36e5, now = Date.now() } = {}) {
    if (!event_id) return false;
    const row = this.db.prepare(`SELECT seen_at FROM events WHERE id=?`).get(event_id);
    if (row && now - row.seen_at < ttlMs) return true;
    this.db.prepare(`INSERT OR REPLACE INTO events(id,seen_at) VALUES(?,?)`).run(event_id, now);
    return false;
  }
  pruneEvents({ ttlMs = 24 * 36e5, now = Date.now() } = {}) {
    this.db.prepare(`DELETE FROM events WHERE seen_at<?`).run(now - ttlMs);
    this.db.prepare(`DELETE FROM rate WHERE at<?`).run(now - 36e5);
  }

  // ---- rate ----
  /** Record a message and return the count in the last hour. Once over `limit`, refused messages are not recorded, so the window drains. */
  rateHit(requester, { now = Date.now(), limit = Infinity } = {}) {
    const n = this.db.prepare(`SELECT COUNT(*) AS n FROM rate WHERE requester=? AND at>?`).get(requester, now - 36e5).n;
    if (n >= limit) return n + 1;
    this.db.prepare(`INSERT INTO rate(requester,at) VALUES(?,?)`).run(requester, now);
    return n + 1;
  }

  // ---- audit ----
  audit(type, request_id = null, actor = null, data = {}) {
    let s = JSON.stringify(data ?? {});
    for (const sec of this.redact) s = s.split(sec).join('[redacted]');
    this.db.prepare(`INSERT INTO audit(ts,type,request_id,actor,data) VALUES(?,?,?,?,?)`).run(Date.now(), type, request_id, actor, s);
  }
  auditFor(request_id) {
    return this.db.prepare(`SELECT * FROM audit WHERE request_id=? ORDER BY seq`).all(request_id).map((r) => ({ ...r, data: P(r.data) }));
  }
  auditTail(n = 50) {
    return this.db.prepare(`SELECT * FROM audit ORDER BY seq DESC LIMIT ?`).all(n).map((r) => ({ ...r, data: P(r.data) })).reverse();
  }
}
