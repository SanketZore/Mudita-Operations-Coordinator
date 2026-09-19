/**
 * text.js - parsing of the three user-supplied text inputs:
 *   transcript -> numbered lines (the "source references" every fact points to)
 *   rules      -> [{id, text}]   (operator-controlled policy)
 *   roster     -> [{name, role}] (who may own tasks)
 */

const SPEAKER_RE = /^\s*([A-Z][A-Za-z0-9 .'’-]{0,40}?)(?:\s*\(([^)]{1,40})\))?\s*:\s+(.*)$/;

/** Number every non-empty transcript line from 1. The numbering is stored once and reused everywhere. */
export function splitTranscript(raw) {
  const out = [];
  let n = 0;
  for (const rawLine of String(raw ?? '').split(/\r?\n/)) {
    const text = rawLine.trim();
    if (!text) continue;
    n += 1;
    const m = SPEAKER_RE.exec(text);
    out.push({ line: n, speaker: m ? m[1].trim() : null, role: m && m[2] ? m[2].trim() : null, text });
  }
  return out;
}

/** Lines starting with "#" are comments. Ids like "R3:" are kept; other lines get the next free R<n>. */
export function parseRules(raw) {
  const lines = String(raw ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const used = new Set();
  const parsed = lines.map((l) => {
    const m = /^(R\d+)\s*[:.)-]\s*(.+)$/i.exec(l);
    if (m) {
      used.add(m[1].toUpperCase());
      return { id: m[1].toUpperCase(), text: m[2].trim() };
    }
    return { id: null, text: l };
  });
  let next = 1;
  for (const r of parsed) {
    if (!r.id) {
      while (used.has(`R${next}`)) next += 1;
      r.id = `R${next}`;
      used.add(r.id);
    }
  }
  return parsed;
}

/** "Name - Role", "Name — Role", "Name, Role" or just "Name". */
export function parseRoster(raw) {
  return String(raw ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const m = /^(.+?)\s+[—–-]\s+(.+)$/.exec(l) || /^(.+?)\s*[,:]\s*(.+)$/.exec(l);
      return m ? { name: m[1].trim(), role: m[2].trim() } : { name: l, role: '' };
    });
}

/** Lower-case, straighten quotes, collapse whitespace. Used for all "is this verbatim?" checks. */
export function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reduce transcript size before sending it to a model while preserving the
 * original line references near the beginning and end of the transcript. This is
 * used as a defensive guardrail when a run is large enough to trigger Gemini
 * output truncation or overlong prompts.
 */
export function truncateTranscriptForModel(lines, maxChars = 6000) {
  const asText = Array.isArray(lines)
    ? lines.map((l) => `[L${l.line}] ${l.text}`).join('\n')
    : String(lines ?? '');
  if (asText.length <= maxChars) return asText;

  const parts = Array.isArray(lines) ? lines : String(lines ?? '').split(/\r?\n/).map((text, index) => ({ line: index + 1, text }));
  const summary = `\n...\n[truncated: transcript was too large for the model; more transcript lines omitted]\n...\n`;
  const budgetForBody = Math.max(summary.length + 80, maxChars - 80);
  const headChars = Math.max(200, Math.floor((budgetForBody * 0.7)));
  const tailChars = Math.max(200, budgetForBody - headChars);

  const head = parts
    .slice(0, Math.max(1, Math.ceil(parts.length * 0.4)))
    .map((l) => `[L${l.line}] ${l.text}`)
    .join('\n');
  const tail = parts
    .slice(-Math.max(1, Math.ceil(parts.length * 0.25)))
    .map((l) => `[L${l.line}] ${l.text}`)
    .join('\n');

  const result = `${head.slice(0, headChars)}${summary}${tail.slice(-tailChars)}`;
  return result.length > maxChars ? result.slice(0, maxChars) : result;
}

/**
 * Is `quote` a verbatim excerpt of `lineText`? Ellipses ("...") split the quote
 * into pieces that must each appear in the line. Case/whitespace-insensitive.
 */
export function quoteInLine(quote, lineText) {
  const parts = String(quote ?? '')
    .split(/\s*(?:\.\.\.|…)\s*/)
    .map((p) => norm(p).replace(/[.,;:!?]+$/, ''))
    .filter((p) => p.length >= 3);
  if (!parts.length) return false;
  const hay = norm(lineText);
  return parts.every((p) => hay.includes(p));
}

const normName = (s) => norm(s).replace(/\(.*?\)/g, '').replace(/[^a-z0-9 ]/g, '').trim();

/** Same person? "Priya" matches "Priya Nair", but "Priya Nair" does not match "Priya Rao". */
export function nameMatches(a, b) {
  if (!a || !b) return false;
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = na.split(' ');
  const tb = nb.split(' ');
  return ta[0] === tb[0] && ta[0].length >= 3 && (ta.length === 1 || tb.length === 1);
}

/** Does a person's name (full or first name) occur in a piece of text? */
export function nameAppearsIn(name, text) {
  const n = normName(name);
  if (!n) return false;
  const hay = ' ' + norm(text).replace(/[^a-z0-9 ]/g, ' ') + ' ';
  if (hay.includes(' ' + n + ' ')) return true;
  const first = n.split(' ')[0];
  return first.length >= 3 && hay.includes(' ' + first + ' ');
}
