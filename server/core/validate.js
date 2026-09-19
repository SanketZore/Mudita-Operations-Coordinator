/** JSON-schema validation (Ajv). Every agent handoff goes through `validate`. */
import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });
const cache = new WeakMap();

/** @returns {{ok: boolean, errors: string[]}} human-readable error list for prompts and UI */
export function validate(schema, data) {
  let fn = cache.get(schema);
  if (!fn) {
    fn = ajv.compile(schema);
    cache.set(schema, fn);
  }
  const ok = fn(data);
  if (ok) return { ok: true, errors: [] };
  const errors = (fn.errors || []).slice(0, 12).map((e) => {
    const where = e.instancePath || '(root)';
    const extra = e.params && e.params.additionalProperty ? ` "${e.params.additionalProperty}"` : '';
    return `${where} ${e.message}${extra}`;
  });
  return { ok: false, errors };
}
