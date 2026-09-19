import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteInLine, nameMatches, nameAppearsIn, parseRules, splitTranscript } from '../server/core/text.js';
import { checkIntake, dropUngrounded, checkPlan } from '../server/core/guards.js';
import { isIsoDate, weekday } from '../server/core/dates.js';
import { validate } from '../server/core/validate.js';
import { IntakeOutput } from '../server/core/schemas.js';

const lines = splitTranscript('Priya Nair (Product): We decided to launch on October 12.\nMarcus Lee: I\'ll own the rebuild by September 30.');

test('quoteInLine: verbatim, case/space tolerant, ellipsis pieces, rejects paraphrase', () => {
  assert.ok(quoteInLine('we decided to launch on October 12', lines[0].text));
  assert.ok(quoteInLine('We decided ... October 12.', lines[0].text));
  assert.ok(!quoteInLine('We agreed to ship on October 12', lines[0].text));
});

test('nameMatches: first-name vs full name, but not two different full names', () => {
  assert.ok(nameMatches('Priya', 'Priya Nair'));
  assert.ok(nameMatches('priya nair', 'Priya Nair'));
  assert.ok(!nameMatches('Priya Nair', 'Priya Rao'));
  assert.ok(nameAppearsIn('Marcus Lee', lines[1].text));
});

test('dates: real calendar dates and weekdays', () => {
  assert.ok(isIsoDate('2026-09-14'));
  assert.ok(!isIsoDate('2026-02-30'));
  assert.equal(weekday('2026-09-14'), 'Monday');
});

test('parseRules keeps explicit ids and numbers the rest without clashes', () => {
  const r = parseRules('# comment\nR2: two\nplain rule\nR1: one');
  assert.deepEqual(r.map((x) => x.id), ['R2', 'R3', 'R1']);
});

const goodFact = { id: 'F1', type: 'decision', statement: 'Launch Oct 12', source_refs: [{ line: 2, quote: 'We decided to launch on October 12' }], stated_owner: null, stated_deadline: '2026-10-12', stated_deadline_text: 'October 12' };

test('checkIntake accepts grounded facts and rejects fake quotes / invented owners / invented dates', () => {
  assert.equal(checkIntake(lines, { summary: '', facts: [{ ...goodFact, source_refs: [{ line: 1, quote: 'We decided to launch on October 12' }] }], issues: [] }).errors.length, 0);
  const bad = {
    summary: '',
    facts: [
      { ...goodFact, id: 'F1', source_refs: [{ line: 1, quote: 'We decided to launch on October 12' }] },
      { ...goodFact, id: 'F2', source_refs: [{ line: 1, quote: 'Totally made up sentence' }] },
      { ...goodFact, id: 'F3', source_refs: [{ line: 1, quote: 'We decided to launch on October 12' }], stated_owner: 'Zed Nobody' },
      { ...goodFact, id: 'F4', source_refs: [{ line: 1, quote: 'We decided to launch on October 12' }], stated_deadline_text: 'by next Tuesday' },
      { ...goodFact, id: 'F5', source_refs: [{ line: 99, quote: 'x y z' }] },
    ],
    issues: [],
  };
  const res = checkIntake(lines, bad);
  assert.deepEqual([...res.badFactIds].sort(), ['F2', 'F3', 'F4', 'F5']);
  const { output, dropped } = dropUngrounded(lines, bad);
  assert.deepEqual(output.facts.map((f) => f.id), ['F1']);
  assert.equal(dropped.length, 4);
});

test('IntakeOutput schema rejects unknown keys and bad enums', () => {
  assert.ok(!validate(IntakeOutput, { summary: '', facts: [], issues: [], extra: 1 }).ok);
  assert.ok(!validate(IntakeOutput, { summary: '', facts: [{ ...goodFact, type: 'opinion' }], issues: [] }).ok);
});

// ---------------------------------------------------------------- plan guard
const facts = [
  { id: 'F1', type: 'requirement', statement: 'Dana delivers screens', stated_owner: 'Dana Okafor', stated_deadline: '2026-09-21', source_refs: [] },
  { id: 'F2', type: 'decision', statement: 'Freeze Oct 2', stated_owner: null, stated_deadline: '2026-10-02', source_refs: [] },
  { id: 'F3', type: 'decision', statement: 'Freeze Oct 5', stated_owner: null, stated_deadline: '2026-10-05', source_refs: [] },
];
const ctx = {
  facts,
  issues: [{ id: 'I1', kind: 'conflict', status: 'open', description: 'freeze conflict', related_fact_ids: ['F2', 'F3'] }],
  rules: [{ id: 'R1', text: 'Owners from roster' }, { id: 'R6', text: 'No person may be the owner of more than 1 tasks.' }, { id: 'R7', text: 'No weekend deadlines.' }],
  roster: [{ name: 'Dana Okafor' }, { name: 'Marcus Lee' }],
  meeting_date: '2026-09-14',
};
const task = (o) => ({ id: 'T1', title: 't', description: '', kind: 'supported', owner: null, owner_basis: 'unassigned', deadline: null, deadline_basis: 'unassigned', depends_on: [], fact_ids: ['F1'], rule_ids: [], rationale: '', ...o });
const plan = (tasks, qs = [{ id: 'Q1', question: 'q', why_it_matters: '', related_issue_ids: ['I1'], related_fact_ids: [], blocking_task_ids: [] }]) => ({ tasks, unresolved_questions: qs });
const cats = (f) => f.map((x) => x.category);

test('checkPlan: a clean grounded plan has no findings', () => {
  const f = checkPlan(plan([task({ owner: 'Dana Okafor', owner_basis: 'stated_in_source', deadline: '2026-09-21', deadline_basis: 'stated_in_source' })]), ctx);
  assert.deepEqual(f, []);
});

test('checkPlan: invented owner, not-on-roster owner and ungrounded deadline are blockers', () => {
  const f = checkPlan(plan([task({ owner: 'Jordan Blake', owner_basis: 'stated_in_source', deadline: '2026-09-22', deadline_basis: 'stated_in_source' })]), ctx);
  assert.ok(cats(f).includes('invented_owner'));
  assert.ok(cats(f).includes('invented_deadline'));
  assert.ok(f.every((x) => x.id.startsWith('G0.')));
  assert.ok(f.some((x) => x.severity === 'blocker'));
});

test('checkPlan: weekend deadline, deadline before meeting, cycle, ordering, workload limit', () => {
  const f = checkPlan(
    plan([
      task({ id: 'T1', owner: 'Dana Okafor', owner_basis: 'stated_in_source', deadline: '2026-09-19', deadline_basis: 'recommended_by_rule', rule_ids: ['R7'], depends_on: ['T2'] }),
      task({ id: 'T2', owner: 'Dana Okafor', owner_basis: 'stated_in_source', deadline: '2026-09-10', deadline_basis: 'recommended_by_rule', rule_ids: ['R7'], depends_on: ['T1'] }),
    ]),
    ctx,
  );
  const text = f.map((x) => x.description).join(' | ');
  assert.match(text, /Saturday/);
  assert.match(text, /before the meeting date/);
  assert.match(text, /cycle/i);
  assert.match(text, /owns 2 tasks/);
});

test('checkPlan: open conflict must be surfaced and must not be presented as settled', () => {
  const settled = checkPlan(plan([task({ fact_ids: ['F2'], deadline: '2026-10-02', deadline_basis: 'stated_in_source' })], []), ctx);
  assert.ok(settled.some((x) => x.category === 'missing_coverage'));
  assert.ok(settled.some((x) => x.category === 'unsupported_claim' && /conflict/.test(x.description)));
});
