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
  // Thread watches: an agent session Lekam didn't start is waiting on replies in a thread (or a DM).
  `CREATE TABLE IF NOT EXISTS watches (
     id TEXT PRIMARY KEY, channel TEXT NOT NULL, thread_ts TEXT NOT NULL, is_dm INTEGER NOT NULL DEFAULT 0,
     owner TEXT NOT NULL, agent_id TEXT NOT NULL, host TEXT NOT NULL, title TEXT, state TEXT NOT NULL,
     last_seen_ts TEXT NOT NULL, checked_at INTEGER, card TEXT, pending_card TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS watches_conv ON watches(channel, thread_ts, state);
   CREATE TABLE IF NOT EXISTS watch_replies (
     id TEXT PRIMARY KEY, watch_id TEXT NOT NULL, ts TEXT NOT NULL, user TEXT NOT NULL, text TEXT NOT NULL,
     state TEXT NOT NULL, batch TEXT, created_at INTEGER NOT NULL, UNIQUE(watch_id, ts));`,
];

const rowToWatch = (r) => (r ? { ...r, is_dm: !!r.is_dm, card: P(r.card), pending_card: P(r.pending_card) } : null);
/** Slack timestamps compare as numbers ("1792991756.332749"). */
const tsMax = (a, b) => (!a ? b : !b ? a : Number(b) > Number(a) ? b : a);

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
    // busy_timeout: `lekam watch` (another process) writes to the same database while the service runs.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
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

  // ---- thread watches ----
  /**
   * Register (or renew) a watch. One active watch per conversation: the same agent renews it (keeping last_seen_ts,
   * so catch-up never skips a reply missed live); another agent supersedes it. `renewOnly` renews an existing watch
   * for this conversation and agent and otherwise does nothing. Returns { action, watch }.
   */
  registerWatch({ channel, thread_ts, agent_id, host, owner, title = null, message_ts = null, ttlMs, renewOnly = false, now = Date.now() }) {
    const is_dm = String(channel).startsWith('D');
    const current = this.activeWatchFor(channel, thread_ts, { now });
    const expires_at = now + ttlMs;
    if (current && current.agent_id === agent_id) {
      this.db.prepare(`UPDATE watches SET expires_at=?, updated_at=?, title=COALESCE(?, title), host=? WHERE id=?`).run(expires_at, now, title, host, current.id);
      this.audit('watch_renewed', null, owner, { watch: current.id, agent: agent_id, host });
      return { action: 'renewed', watch: this.getWatch(current.id) };
    }
    if (renewOnly) return { action: 'noop', watch: null };
    if (current) {
      this.db.prepare(`UPDATE watches SET state='superseded', updated_at=? WHERE id=?`).run(now, current.id);
      this.audit('watch_superseded', null, owner, { watch: current.id, by_agent: agent_id });
    }
    const id = 'w' + crypto.randomBytes(5).toString('hex');
    this.db.prepare(`INSERT INTO watches(id,channel,thread_ts,is_dm,owner,agent_id,host,title,state,last_seen_ts,checked_at,card,pending_card,created_at,updated_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,'active',?,NULL,NULL,NULL,?,?,?)`).run(id, channel, thread_ts, is_dm ? 1 : 0, owner, agent_id, host, title, tsMax(thread_ts, message_ts), now, now, expires_at);
    this.audit('watch_registered', null, owner, { watch: id, channel, thread_ts, agent: agent_id, host, replaced: current?.id ?? null });
    return { action: current ? 'replaced' : 'created', watch: this.getWatch(id) };
  }
  /** The Lekam request whose agent session this is, if any. */
  requestBySession(session_id) { return rowToRequest(this.db.prepare(`SELECT * FROM requests WHERE session_id=? ORDER BY created_at DESC LIMIT 1`).get(session_id)); }
  getWatch(id) { return rowToWatch(this.db.prepare(`SELECT * FROM watches WHERE id=?`).get(id)); }
  /** The active watch for a channel thread, or for a DM conversation (DM replies are rarely threaded: any thread matches). */
  activeWatchFor(channel, thread_ts, { now = Date.now() } = {}) {
    return rowToWatch(this.db.prepare(`SELECT * FROM watches WHERE state='active' AND expires_at>? AND channel=? AND (is_dm=1 OR thread_ts=?) ORDER BY updated_at DESC LIMIT 1`).get(now, channel, thread_ts));
  }
  listWatches({ states = ['active'] } = {}) {
    const q = states.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM watches WHERE state IN (${q}) ORDER BY updated_at DESC`).all(...states).map(rowToWatch);
  }
  updateWatch(id, fields) {
    const cols = [], vals = [];
    for (const [k, v] of Object.entries(fields)) { cols.push(`${k}=?`); vals.push(['card', 'pending_card'].includes(k) ? J(v) : k === 'is_dm' ? (v ? 1 : 0) : v); }
    cols.push('updated_at=?'); vals.push(Date.now()); vals.push(id);
    this.db.prepare(`UPDATE watches SET ${cols.join(',')} WHERE id=?`).run(...vals);
    return this.getWatch(id);
  }
  /** Remember the newest message seen in a watched conversation (catch-up reads after it). Does not touch updated_at. */
  watchSeen(id, ts) {
    const w = this.getWatch(id); if (!w) return;
    const next = tsMax(w.last_seen_ts, ts);
    if (next !== w.last_seen_ts) this.db.prepare(`UPDATE watches SET last_seen_ts=? WHERE id=?`).run(next, id);
  }
  /** End watches: by conversation (and optionally agent). Returns how many. */
  stopWatches({ channel, thread_ts, agent_id = null, state = 'stopped', now = Date.now() }) {
    const rows = this.db.prepare(`SELECT id FROM watches WHERE state='active' AND channel=? AND (is_dm=1 OR thread_ts=?)${agent_id ? ' AND agent_id=?' : ''}`).all(...[channel, thread_ts, ...(agent_id ? [agent_id] : [])]);
    for (const r of rows) this.db.prepare(`UPDATE watches SET state=?, updated_at=? WHERE id=?`).run(state, now, r.id);
    return rows.length;
  }
  expireWatches(now = Date.now()) {
    const rows = this.db.prepare(`SELECT * FROM watches WHERE state='active' AND expires_at<=?`).all(now).map(rowToWatch);
    for (const w of rows) { this.db.prepare(`UPDATE watches SET state='expired', updated_at=? WHERE id=?`).run(now, w.id); this.audit('watch_expired', null, w.owner, { watch: w.id }); }
    return rows;
  }
  /** Insert a reply once: returns null when this message was already recorded (live delivery vs catch-up). */
  addWatchReply(watch_id, { ts, user, text, state = 'new', now = Date.now() }) {
    const id = 'r' + crypto.randomBytes(5).toString('hex');
    const r = this.db.prepare(`INSERT OR IGNORE INTO watch_replies(id,watch_id,ts,user,text,state,batch,created_at) VALUES(?,?,?,?,?,?,NULL,?)`).run(id, watch_id, ts, user, text, state, now);
    return r.changes ? this.getWatchReply(id) : null;
  }
  getWatchReply(id) { return this.db.prepare(`SELECT * FROM watch_replies WHERE id=?`).get(id) ?? null; }
  updateWatchReply(id, fields) {
    const cols = Object.keys(fields).map((k) => `${k}=?`);
    this.db.prepare(`UPDATE watch_replies SET ${cols.join(',')} WHERE id=?`).run(...Object.values(fields), id);
    return this.getWatchReply(id);
  }
  repliesInBatch(watch_id, batch, { state = null } = {}) {
    return this.db.prepare(`SELECT * FROM watch_replies WHERE watch_id=? AND batch=?${state ? ' AND state=?' : ''} ORDER BY CAST(ts AS REAL)`).all(...[watch_id, batch, ...(state ? [state] : [])]);
  }
  setBatchState(watch_id, batch, from, to) {
    return this.db.prepare(`UPDATE watch_replies SET state=? WHERE watch_id=? AND batch=? AND state=?`).run(to, watch_id, batch, from).changes;
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
