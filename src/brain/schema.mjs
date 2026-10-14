// Classification JSON schema and a small local validator (no dependencies).
export const INTENTS = ['task_request', 'question', 'fyi', 'chitchat', 'needs_clarification'];
export const FOLLOWUPS = ['in_scope', 'scope_change', 'not_for_agent'];

export const CLASSIFICATION_SCHEMA = {
  name: 'lekam_classification',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['intent', 'actionable', 'confidence', 'urgent', 'reply_to_user', 'brief', 'followup', 'clarifying_question'],
    properties: {
      intent: { type: 'string', enum: INTENTS },
      actionable: { type: 'boolean', description: 'true when an agent with tools could usefully act on this' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      urgent: { type: 'boolean' },
      reply_to_user: { type: ['string', 'null'], description: 'short reply in persona, or null to stay silent' },
      brief: {
        type: ['object', 'null'],
        additionalProperties: false,
        required: ['summary', 'skill', 'repo', 'outward_actions', 'notes'],
        properties: {
          summary: { type: 'string' },
          skill: { type: ['string', 'null'] },
          repo: { type: ['string', 'null'] },
          outward_actions: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' },
        },
      },
      followup: { type: ['string', 'null'], enum: [...FOLLOWUPS, null] },
      clarifying_question: { type: ['string', 'null'] },
    },
  },
};

export class SchemaError extends Error {}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** Validate an object against the subset of JSON Schema used above. Throws SchemaError. */
export function validate(value, schema = CLASSIFICATION_SCHEMA.schema, path = '$') {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const t = typeOf(value);
  if (!types.includes(t)) throw new SchemaError(`${path}: expected ${types.join('|')}, got ${t}`);
  if (schema.enum && !schema.enum.includes(value)) throw new SchemaError(`${path}: ${JSON.stringify(value)} not in enum`);
  if (t === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) throw new SchemaError(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new SchemaError(`${path}: above maximum`);
  }
  if (t === 'object') {
    for (const k of schema.required ?? []) if (!(k in value)) throw new SchemaError(`${path}.${k}: missing`);
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (!sub) { if (schema.additionalProperties === false) throw new SchemaError(`${path}.${k}: unexpected`); continue; }
      validate(v, sub, `${path}.${k}`);
    }
  }
  if (t === 'array' && schema.items) value.forEach((v, i) => validate(v, schema.items, `${path}[${i}]`));
  return value;
}
