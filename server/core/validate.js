/** JSON-schema validation (Ajv). Every agent handoff goes through `validate`. */
import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });
const cache = new WeakMap();

const ENUM_ALIASES = {
  approve: new Set(['approve', 'approved', 'accept', 'accepted', 'pass', 'passed', 'ok']),
  revise: new Set(['revise', 'revised', 'revision', 'needs_revision', 'needs_revise', 'reject', 'rejected', 'fix', 'fixes', 'change_requested']),
};

function buildEnumVariants(value) {
  const text = String(value).trim();
  if (!text) return new Set();
  const lower = text.toLowerCase();
  return new Set([
    text,
    lower,
    lower.replace(/[-\s]+/g, '_'),
    lower.replace(/_/g, '-'),
    lower.replace(/_/g, ' '),
    lower.replace(/\s+/g, ''),
    lower.replace(/[_-]+/g, ''),
  ]);
}

function normalizeEnumValue(value, allowed) {
  if (typeof value !== 'string') return value;
  const raw = value.trim();
  if (!raw) return value;
  const rawVariants = buildEnumVariants(raw);

  const aliasMap = new Map();
  for (const [canonical, aliases] of Object.entries(ENUM_ALIASES)) {
    const canonicalVariants = buildEnumVariants(canonical);
    for (const alias of aliases) {
      for (const variant of buildEnumVariants(alias)) aliasMap.set(variant, canonical);
      for (const variant of canonicalVariants) aliasMap.set(variant, canonical);
    }
  }

  for (const variant of rawVariants) {
    if (aliasMap.has(variant)) return aliasMap.get(variant);
  }

  for (const allowedValue of allowed) {
    const candidate = String(allowedValue).trim();
    if (!candidate) continue;
    const candidateVariants = buildEnumVariants(candidate);
    if ([...rawVariants].some((v) => candidateVariants.has(v))) return candidate;
  }
  return value;
}

function getEnumSchemaValues(schema) {
  const enums = [];
  if (Array.isArray(schema?.enum)) enums.push(...schema.enum);
  for (const unionKey of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema?.[unionKey])) {
      for (const child of schema[unionKey]) {
        if (Array.isArray(child?.enum)) enums.push(...child.enum);
      }
    }
  }
  return enums;
}

export function normalizeStructuredOutput(schema, data) {
  if (data === null || data === undefined) return data;

  const enumValues = getEnumSchemaValues(schema);
  if (enumValues.length && typeof data === 'string') {
    return normalizeEnumValue(data, enumValues);
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
