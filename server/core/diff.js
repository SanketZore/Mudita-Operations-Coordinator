/** Compare two plans so the UI can show how a corrected source fact propagated. */
const key = (t) => String(t.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const FIELDS = ['owner', 'owner_basis', 'deadline', 'deadline_basis', 'kind'];

export function diffPlans(prev, next) {
  if (!prev || !next) return null;
  const pm = new Map(prev.tasks.map((t) => [key(t), t]));
  const nm = new Map(next.tasks.map((t) => [key(t), t]));
  const added = [];
  const changed = [];
  let unchanged = 0;
  for (const [k, t] of nm) {
    const old = pm.get(k);
    if (!old) {
      added.push({ id: t.id, title: t.title });
      continue;
    }
    const changes = FIELDS.filter((f) => (old[f] ?? null) !== (t[f] ?? null)).map((f) => ({ field: f, from: old[f] ?? null, to: t[f] ?? null }));
    if (changes.length) changed.push({ id: t.id, title: t.title, changes });
    else unchanged += 1;
  }
  const removed = [...pm].filter(([k]) => !nm.has(k)).map(([, t]) => ({ id: t.id, title: t.title }));
  const qk = (q) => q.question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const pq = new Set(prev.unresolved_questions.map(qk));
  const nq = new Set(next.unresolved_questions.map(qk));
  const questions_added = next.unresolved_questions.filter((q) => !pq.has(qk(q))).map((q) => q.question);
  const questions_removed = prev.unresolved_questions.filter((q) => !nq.has(qk(q))).map((q) => q.question);
  return { added, removed, changed, unchanged, questions_added, questions_removed };
}
