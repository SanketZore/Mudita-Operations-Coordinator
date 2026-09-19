/** JSON-schema validation (Ajv). Every agent handoff goes through `validate`. */
import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });
const cache = new WeakMap();

function normalizeEnumValue(value, allowed) {
  if (typeof value !== 'string') return value;
  const raw = value.trim();
  if (!raw) return value;
  const variants = new Set([
    raw,
    raw.toLowerCase(),
    raw.toLowerCase().replace(/[-\s]+/g, '_'),
    raw.toLowerCase().replace(/_/g, '-'),
    raw.toLowerCase().replace(/_/g, ' '),
  ]);
  for (const allowedValue of allowed) {
    const candidate = String(allowedValue).trim();
    const candidateVariants = new Set([
      candidate,
      candidate.toLowerCase(),
      candidate.toLowerCase().replace(/[-\s]+/g, '_'),
      candidate.toLowerCase().replace(/_/g, '-'),
      candidate.toLowerCase().replace(/_/g, ' '),
    ]);
    if ([...variants].some((v) => candidateVariants.has(v))) return candidate;
  }
  return value;
}

export function normalizeStructuredOutput(schema, data) {
  if (data === null || data === undefined) return data;

  if (Array.isArray(schema?.enum) && typeof data === 'string') {
    return normalizeEnumValue(data, schema.enum);
  }

  if (Array.isArray(data)) {
    return data.map((item) => normalizeStructuredOutput(schema?.items || schema, item));
  }

  if (typeof data === 'string') {
    const nullable = Array.isArray(schema?.type) ? schema.type : [schema?.type];
    if (nullable.includes('null') && data.trim() === '') return null;
    return data;
  }

  if (typeof data !== 'object') return data;

  const out = { ...data };
  for (const [key, childSchema] of Object.entries(schema?.properties || {})) {
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] = normalizeStructuredOutput(childSchema, out[key]);
    }
  }

  if (schema?.items && Array.isArray(out)) {
    return out.map((item) => normalizeStructuredOutput(schema.items, item));
  }

  return out;
}

/** @returns {{ok: boolean, errors: string[]}} human-readable error list for prompts and UI */
export function validate(schema, data) {
  const safeData = normalizeStructuredOutput(schema, data);
  let fn = cache.get(schema);
  if (!fn) {
    fn = ajv.compile(schema);
    cache.set(schema, fn);
  }
  const ok = fn(safeData);
  if (ok) return { ok: true, errors: [] };
  const errors = (fn.errors || []).slice(0, 12).map((e) => {
    const where = e.instancePath || '(root)';
    const extra = e.params && e.params.additionalProperty ? ` "${e.params.additionalProperty}"` : '';
    return `${where} ${e.message}${extra}`;
  });
  return { ok: false, errors };
}
