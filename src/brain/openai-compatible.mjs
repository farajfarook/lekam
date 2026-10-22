// The only network call the brain makes. No tools, ever.
import { CLASSIFICATION_SCHEMA, validate, SchemaError } from './schema.mjs';
import { systemPrompt, userTurn, ownerVoicePrompt } from './prompt.mjs';

export class BrainError extends Error {
  constructor(message, { transient = false } = {}) { super(message); this.transient = transient; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Endpoint error bodies are often HTML (Cloudflare 502 pages): keep a short, tag-free excerpt. */
const excerpt = (t) => String(t).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

export class OpenAICompatibleBrain {
  /** @param {object} o config.brain + { fetch?, audit?, log? } */
  constructor({ base_url, api_key, classify_model, brief_model, timeout_ms = 30000, max_tokens = 2500, retry_delays_ms = [1000, 4000], fetch: f = globalThis.fetch, audit = () => {}, log = () => {} }) {
    Object.assign(this, { base_url, api_key, classify_model, brief_model: brief_model ?? classify_model, timeout_ms, max_tokens, retry_delays_ms, fetch: f, audit, log });
  }

  buildBody(model, system, user) {
    // Deliberately no `tools`, `functions`, `tool_choice`.
    return {
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: this.max_tokens, // reasoning models spend tokens before the JSON; keep headroom
      response_format: { type: 'json_schema', json_schema: CLASSIFICATION_SCHEMA },
    };
  }

  async call(model, system, user, { request_id = null } = {}) {
    const body = this.buildBody(model, system, user);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeout_ms);
    let res, json;
    try {
      try {
        res = await this.fetch(`${this.base_url}/chat/completions`, {
          method: 'POST', signal: ctl.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.api_key}` },
          body: JSON.stringify(body),
        });
      } catch (e) { throw new BrainError(`brain endpoint unreachable: ${e.name === 'AbortError' ? `timeout after ${this.timeout_ms}ms` : e.message}`, { transient: true }); }
      const text = await res.text();
      if (!res.ok) throw new BrainError(`brain endpoint ${res.status}: ${excerpt(text)}`, { transient: res.status === 429 || res.status >= 500 });
      json = JSON.parse(text);
    } finally { clearTimeout(timer); }
    const u = json.usage ?? {};
    this.audit('brain_call', request_id, null, { model, prompt_tokens: u.prompt_tokens ?? null, completion_tokens: u.completion_tokens ?? null, cost: json.usage?.cost ?? res.headers?.get?.('x-litellm-response-cost') ?? null });
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new SchemaError('no content in response');
    if (json.choices?.[0]?.finish_reason === 'length') throw new SchemaError(`output truncated at max_tokens=${this.max_tokens} (reasoning_tokens=${u.completion_tokens_details?.reasoning_tokens ?? '?'})`);
    return validate(JSON.parse(stripFences(content)));
  }

  /** Classify a message. Retries once on invalid JSON/schema. */
  async classify(input, { persona, catalogue, outcomes, ownerName, request_id } = {}) {
    const system = systemPrompt({ persona, catalogue, outcomes, ownerName });
    const user = userTurn({ ...input, ownerName });
    let lastErr, badOutput = 0, transient = 0;
    for (;;) {
      try { return await this.call(this.classify_model, system, user, { request_id }); }
      catch (e) {
        lastErr = e;
        if (e instanceof BrainError) {
          // 429/5xx/network: back off and retry a couple of times; other endpoint errors (401, 400) fail fast.
          if (!e.transient || transient >= this.retry_delays_ms.length) break;
          this.log('warn', `${e.message}; retrying in ${this.retry_delays_ms[transient]}ms`);
          await sleep(this.retry_delays_ms[transient++]);
          continue;
        }
        if (++badOutput >= 2) break; // invalid JSON/schema: one retry
        this.log('warn', `brain returned invalid output (attempt ${badOutput}): ${e.message}`);
      }
    }
    throw lastErr instanceof BrainError ? lastErr : new BrainError(`invalid brain output: ${lastErr?.message}`);
  }

  /** Rewrite an agent report as the owner's own friendly Slack reply. Plain text out; caller falls back to the raw report on error. */
  async rewriteAsOwner({ report, request_text, requesterName, ownerName, voice, request_id = null }) {
    const body = {
      model: this.brief_model,
      messages: [
        { role: 'system', content: ownerVoicePrompt({ ownerName, voice }) },
        { role: 'user', content: JSON.stringify({ asked_by: requesterName, question: request_text, report }) },
      ],
      max_tokens: this.max_tokens,
    };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeout_ms);
    try {
      const res = await this.fetch(`${this.base_url}/chat/completions`, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${this.api_key}` }, body: JSON.stringify(body) });
      const text = await res.text();
      if (!res.ok) throw new BrainError(`brain endpoint ${res.status}: ${excerpt(text)}`);
      const json = JSON.parse(text);
      this.audit('brain_call', request_id, null, { model: this.brief_model, purpose: 'owner_voice', prompt_tokens: json.usage?.prompt_tokens ?? null, completion_tokens: json.usage?.completion_tokens ?? null, cost: json.usage?.cost ?? null });
      if (json.choices?.[0]?.finish_reason === 'length') throw new BrainError('rewrite truncated');
      const out = stripFences(String(json.choices?.[0]?.message?.content ?? '')).trim();
      if (!out) throw new BrainError('empty rewrite');
      return out;
    } finally { clearTimeout(timer); }
  }

  /** Optional second pass with the brief model: re-run the same contract and keep only the brief. */
  async refineBrief(input, ctx) {
    if (this.brief_model === this.classify_model) return null;
    const system = systemPrompt({ persona: ctx.persona, catalogue: ctx.catalogue, outcomes: ctx.outcomes, ownerName: ctx.ownerName });
    const user = userTurn({ ...input, ownerName: ctx.ownerName });
    try { const c = await this.call(this.brief_model, system, user, { request_id: ctx.request_id }); return c.brief ?? null; }
    catch (e) { this.log('warn', `brief model failed, keeping classify brief: ${e.message}`); return null; }
  }
}

function stripFences(s) {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(s);
  return m ? m[1] : s;
}
