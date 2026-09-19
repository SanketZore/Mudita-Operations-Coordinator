/** Stable hashing helpers. Used for idempotent step reuse (same input => same hash). */
import crypto from 'node:crypto';

/** JSON.stringify with sorted keys so equal objects always serialise identically. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.filter((k) => value[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hashOf = (value) => sha256(stableStringify(value));
export const newId = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');
