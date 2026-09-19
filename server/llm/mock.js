/**
 * MOCK provider - deterministic heuristics, NOT a language model.
 *
 * Purpose: (1) let the automated tests exercise the orchestration, guards,
 * resume and isolation logic without network access or API cost, and (2) let
 * you click through the UI offline. The UI shows a loud "MOCK" banner and every
 * run records provider "mock". Never present mock output as an LLM result.
 *
 * It receives the structured `input` (not the prompt) and returns output that
 * satisfies the same schema a real model must satisfy.
 */
import { isIsoDate } from '../core/dates.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DATE_RE = new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i');

const speakerName = (speaker) => (speaker || '').replace(/\(.*\)/, '').trim();
const body = (text) => text.replace(/^[^:]{1,60}:\s+/, '');

function mockIntake(input) {
  const year = input.meeting.date && isIsoDate(input.meeting.date) ? input.meeting.date.slice(0, 4) : '2026';
  const facts = [];
  const issues = [];
  for (const l of input.transcript_lines) {
    const speaker = /^([A-Z][A-Za-z .'’-]{0,40}?)(?:\s*\([^)]*\))?:\s/.exec(l.text)?.[1]?.trim() || null;
    const text = body(l.text);
    if (/^ignore all|system override/i.test(text)) {
      issues.push({ id: `I${issues.length + 1}`, kind: 'ambiguous', description: 'A line in the transcript tries to instruct the system; treated as data and ignored.', source_refs: [{ line: l.line, quote: text.slice(0, 80) }], related_fact_ids: [], suggested_question: 'Who wrote this instruction and is it real?' });
      continue;
    }
    // Pure meta-talk carries no extractable fact ("we need to figure out which one is right").
    if (/^thanks everyone|need to figure out which one|not decided yet/i.test(text)) continue;
    let type = null;
    if (/\b(decided|decision|fixed|locked)\b/i.test(text)) type = 'decision';
    else if (/\b(constraint|can't|cannot|capped|limit)\b/i.test(text)) type = 'constraint';
    else if (/\b(requirement|must|need|has to|assigned|should be|thought|i'll|i will|i can)\b/i.test(text)) type = 'requirement';
    if (!type) continue;
    const dm = DATE_RE.exec(text);
    let iso = null;
    if (dm) iso = `${year}-${String(MONTHS.indexOf(dm[1].toLowerCase()) + 1).padStart(2, '0')}-${String(dm[2]).padStart(2, '0')}`;
    const volunteers = /\b(i'll|i will|i can)\b/i.test(text);
    facts.push({
      id: `F${facts.length + 1}`,
      type,
      statement: text.length > 200 ? text.slice(0, 197) + '...' : text,
      source_refs: [{ line: l.line, quote: text.length > 200 ? text.slice(0, 200) : text }],
      stated_owner: volunteers && speaker ? speakerName(speaker) : null,
      stated_deadline: iso && isIsoDate(iso) ? iso : null,
      stated_deadline_text: dm ? dm[0] : null,
    });
    if (/no one has volunteered|no one volunteered|don't have a date|nobody has been assigned/i.test(text)) {
      issues.push({ id: `I${issues.length + 1}`, kind: 'missing', description: `Missing information: ${text.slice(0, 120)}`, source_refs: [{ line: l.line, quote: text.slice(0, 100) }], related_fact_ids: [`F${facts.length}`], suggested_question: 'Who owns this and by when?' });
    }
  }
  // conflict heuristic: two different dates for the same milestone keyword
  const byKey = new Map();
  for (const f of facts) {
    const k = /code freeze/i.test(f.statement) ? 'code freeze' : null;
    if (k && f.stated_deadline) byKey.set(k, [...(byKey.get(k) || []), f]);
  }
  for (const [k, fs] of byKey) {
    if (new Set(fs.map((f) => f.stated_deadline)).size > 1) {
      issues.push({ id: `I${issues.length + 1}`, kind: 'conflict', description: `Conflicting dates for ${k}: ${fs.map((f) => f.stated_deadline).join(' vs ')}`, source_refs: fs.map((f) => f.source_refs[0]), related_fact_ids: fs.map((f) => f.id), suggested_question: `Which date is correct for ${k}?` });
    }
  }
  return { summary: `Mock extraction: ${facts.length} facts, ${issues.length} issues.`, facts, issues };
}

function mockPlan(input) {
  const tasks = [];
  const recs = [];
  const conflictFactIds = new Set(input.issues.filter((i) => i.kind === 'conflict' && i.status !== 'resolved').flatMap((i) => i.related_fact_ids));
  const roster = input.roster || [];
  for (const f of input.facts) {
    if (f.type === 'constraint') {
      recs.push({ id: `REC${recs.length + 1}`, text: `Respect constraint: ${f.statement}`, rationale: 'Stated as a constraint in the source.', fact_ids: [f.id], rule_ids: [] });
      continue;
    }
    const inConflict = conflictFactIds.has(f.id);
    const hasOwner = !!f.stated_owner && (!roster.length || roster.some((p) => p.name.toLowerCase().startsWith(f.stated_owner.toLowerCase().split(' ')[0])));
    const ownerName = hasOwner ? roster.find((p) => p.name.toLowerCase().startsWith(f.stated_owner.toLowerCase().split(' ')[0]))?.name || f.stated_owner : null;
    tasks.push({
      id: `T${tasks.length + 1}`,
      title: f.statement.length > 90 ? f.statement.slice(0, 87) + '...' : f.statement,
      description: f.statement,
      kind: 'supported',
      owner: ownerName,
      owner_basis: hasOwner ? 'stated_in_source' : 'unassigned',
      deadline: !inConflict && f.stated_deadline ? f.stated_deadline : null,
      deadline_basis: !inConflict && f.stated_deadline ? 'stated_in_source' : 'unassigned',
      depends_on: [],
      fact_ids: [f.id],
      rule_ids: [],
      rationale: 'Derived directly from the cited source fact.',
    });
  }
  const questions = input.issues
    .filter((i) => i.status !== 'resolved')
    .map((i, n) => ({ id: `Q${n + 1}`, question: i.suggested_question, why_it_matters: i.description, related_issue_ids: [i.id], related_fact_ids: i.related_fact_ids, blocking_task_ids: [] }));
  return {
    summary: `Mock plan with ${tasks.length} tasks.`,
    supported_facts: input.facts.map((f) => ({ fact_id: f.id, how_used: 'Used as a basis for the plan.' })),
    tasks,
    recommendations: recs,
    unresolved_questions: questions,
    addressed_findings: input.feedback ? input.feedback.findings.map((f) => ({ finding_id: f.id, action: 'fixed', explanation: 'Plan regenerated from the source facts.' })) : [],
  };
}

function mockReview(input) {
  return {
    verdict: input.guard_findings.length ? 'revise' : 'approve',
    findings: [],
    checks_performed: ['Mock: deterministic guard findings only (no LLM reasoning).'],
  };
}

const estimate = (o) => Math.ceil(JSON.stringify(o).length / 4);

export async function callMock(_config, { agent, input }) {
  const data = agent === 'intake' ? mockIntake(input) : agent === 'planning' ? mockPlan(input) : mockReview(input);
  await new Promise((r) => setTimeout(r, 15));
  return { data, usage: { input_tokens: estimate(input), output_tokens: estimate(data) }, model: 'mock-heuristic-v1', stop_reason: 'mock' };
}

