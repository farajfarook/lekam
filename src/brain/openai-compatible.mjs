// The only network call the brain makes. No tools, ever.
import { CLASSIFICATION_SCHEMA, validate, SchemaError } from './schema.mjs';
import { systemPrompt, userTurn } from './prompt.mjs';

export class BrainError extends Error {}

export class OpenAICompatibleBrain {
  /** @param {object} o config.brain + { fetch?, audit?, log? } */
  constructor({ base_url, api_key, classify_model, brief_model, timeout_ms = 30000, fetch: f = globalThis.fetch, audit = () => {}, log = () => {} }) {
    Object.assign(this, { base_url, api_key, classify_model, brief_model: brief_model ?? classify_model, timeout_ms, fetch: f, audit, log });
  }

  buildBody(model, system, user) {
    // Deliberately no `tools`, `functions`, `tool_choice`.
    return {
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.2,
      max_tokens: 800,
      response_format: { type: 'json_schema', json_schema: CLASSIFICATION_SCHEMA },
    };
  }

  async call(model, system, user, { request_id = null } = {}) {
    const body = this.buildBody(model, system, user);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeout_ms);
    let res, json;
    try {
      res = await this.fetch(`${this.base_url}/chat/completions`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.api_key}` },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) throw new BrainError(`brain endpoint ${res.status}: ${text.slice(0, 300)}`);
      json = JSON.parse(text);
    } finally { clearTimeout(timer); }
    const u = json.usage ?? {};
    this.audit('brain_call', request_id, null, { model, prompt_tokens: u.prompt_tokens ?? null, completion_tokens: u.completion_tokens ?? null, cost: json.usage?.cost ?? res.headers?.get?.('x-litellm-response-cost') ?? null });
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new SchemaError('no content in response');
    return validate(JSON.parse(stripFences(content)));
  }

  /** Classify a message. Retries once on invalid JSON/schema. */
  async classify(input, { persona, catalogue, outcomes, ownerName, request_id } = {}) {
    const system = systemPrompt({ persona, catalogue, outcomes, ownerName });
    const user = userTurn({ ...input, ownerName });
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await this.call(this.classify_model, system, user, { request_id }); }
      catch (e) {
        lastErr = e;
        if (e instanceof BrainError || e.name === 'AbortError') break; // endpoint failure: don't hammer
        this.log('warn', `brain returned invalid output (attempt ${attempt + 1}): ${e.message}`);
      }
    }
    throw lastErr instanceof BrainError ? lastErr : new BrainError(`invalid brain output: ${lastErr?.message}`);
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
