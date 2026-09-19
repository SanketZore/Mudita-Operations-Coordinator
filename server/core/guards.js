/**
 * guards.js - DETERMINISTIC checks that run around the LLM agents.
 *
 * Why they exist: a model can claim "Priya owns this, she said so" when she
 * did not. These checks verify claims against the actual transcript and the
 * structured facts using plain code, so grounding never depends on a model
 * being honest or careful.
 *
 *  checkIntake  - every quote must be verbatim in its transcript line; stated
 *                 owners / deadlines must literally appear in the cited lines.
 *  checkPlan    - owner/deadline claims must trace to facts or rules, owners
 *                 must be on the roster, dependencies must be acyclic and
 *                 date-consistent, open conflicts must be surfaced, etc.
 *  injectViolation - used ONLY by the labelled "simulated fault" demo control.
 */
import { isIsoDate, isWeekend, weekday, addDays } from './dates.js';
import { quoteInLine, nameAppearsIn, nameMatches } from './text.js';

// ------------------------------------------------------------------ Intake --

/**
 * @param {{line:number,text:string}[]} lines numbered transcript
 * @param {object} out IntakeOutput (already schema-valid)
 * @returns {{errors: string[], badFactIds: Set<string>, reasons: Record<string,string[]>}}
 */
export function checkIntake(lines, out) {
  const byLine = new Map(lines.map((l) => [l.line, l.text]));
  const errors = [];
  const badFactIds = new Set();
  const reasons = {};
  const bad = (id, msg) => {
    badFactIds.add(id);
    (reasons[id] ||= []).push(msg);
    errors.push(`Fact ${id}: ${msg}`);
  };

  const seen = new Set();
  for (const f of out.facts) {
    if (seen.has(f.id)) bad(f.id, 'duplicate fact id');
    seen.add(f.id);

    const citedText = [];
    for (const ref of f.source_refs) {
      const text = byLine.get(ref.line);
      if (text === undefined) {
        bad(f.id, `cites line ${ref.line}, which does not exist (transcript has ${lines.length} lines)`);
        continue;
      }
      citedText.push(text);
      if (!quoteInLine(ref.quote, text)) {
        bad(f.id, `quote "${ref.quote}" is not a verbatim excerpt of line ${ref.line}`);
      }
    }
    const cited = citedText.join(' ');
    if (f.stated_owner && !nameAppearsIn(f.stated_owner, cited)) {
      bad(f.id, `stated_owner "${f.stated_owner}" does not appear in the cited lines - owners must never be invented`);
    }
    if (f.stated_deadline_text && !quoteInLine(f.stated_deadline_text, cited)) {
      bad(f.id, `stated_deadline_text "${f.stated_deadline_text}" does not appear in the cited lines - deadlines must never be invented`);
    }
    if (f.stated_deadline && !isIsoDate(f.stated_deadline)) bad(f.id, `stated_deadline "${f.stated_deadline}" is not a real calendar date`);
    if (f.stated_deadline && !f.stated_deadline_text) bad(f.id, 'stated_deadline is set but stated_deadline_text (the raw phrase) is null');
  }

  const issueIds = new Set();
  for (const i of out.issues) {
    if (issueIds.has(i.id)) errors.push(`Issue ${i.id}: duplicate issue id`);
    issueIds.add(i.id);
    for (const ref of i.source_refs) {
      const text = byLine.get(ref.line);
      if (text === undefined || !quoteInLine(ref.quote, text)) errors.push(`Issue ${i.id}: reference to line ${ref.line} is not verbatim`);
    }
    for (const fid of i.related_fact_ids) if (!seen.has(fid)) errors.push(`Issue ${i.id}: related_fact_ids contains unknown fact ${fid}`);
  }
  return { errors, badFactIds, reasons };
}

/** Remove facts that failed grounding and prune dangling references. Returns cleaned output + dropped list. */
export function dropUngrounded(lines, out) {
  const { badFactIds, reasons } = checkIntake(lines, out);
  const byLine = new Map(lines.map((l) => [l.line, l.text]));
  const dropped = out.facts.filter((f) => badFactIds.has(f.id)).map((f) => ({ fact: f, reasons: reasons[f.id] }));
  const facts = out.facts.filter((f) => !badFactIds.has(f.id));
  const keep = new Set(facts.map((f) => f.id));
  const issues = out.issues.map((i) => ({
    ...i,
    source_refs: i.source_refs.filter((r) => byLine.has(r.line) && quoteInLine(r.quote, byLine.get(r.line))),
    related_fact_ids: i.related_fact_ids.filter((id) => keep.has(id)),
  }));
  return { output: { ...out, facts, issues }, dropped };
}

// -------------------------------------------------------------------- Plan --

/** Detect "no person may own more than N tasks" style rules and return the limit (or null). */
function taskLimitRule(rules) {
  for (const r of rules) {
    const m = /(?:no|not)\s+(?:person|one|owner|individual)[^.]*?more than\s+(\d+)\s+tasks?/i.exec(r.text);
    if (m) return { limit: parseInt(m[1], 10), rule_id: r.id };
  }
  return null;
}

function findCycle(tasks) {
  const deps = new Map(tasks.map((t) => [t.id, t.depends_on || []]));
  const state = new Map(); // 1 = visiting, 2 = done
  const path = [];
  const visit = (id) => {
    if (!deps.has(id)) return null;
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...path.slice(path.indexOf(id)), id];
    state.set(id, 1);
    path.push(id);
    for (const d of deps.get(id)) {
      const c = visit(d);
      if (c) return c;
    }
    path.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of deps.keys()) {
    const c = visit(id);
    if (c) return c;
  }
  return null;
}

/**
 * @param {object} plan PlanOutput
 * @param {{facts:any[], issues:any[], rules:{id:string,text:string}[], roster:{name:string}[], meeting_date:string|null}} ctx
 * @param {number} round review round (used only to build finding ids)
 * @returns {object[]} findings in the same shape as Review Agent findings (+ source:"guard")
 */
export function checkPlan(plan, ctx, round = 0) {
  const out = [];
  const add = (severity, category, task_id, description, required_correction, extra = {}) =>
    out.push({
      severity,
      category,
      task_id: task_id ?? null,
      description,
      evidence: extra.evidence || '',
      rule_ids: extra.rule_ids || [],
      fact_ids: extra.fact_ids || [],
      required_correction,
      source: 'guard',
    });

  const factById = new Map(ctx.facts.map((f) => [f.id, f]));
  const ruleIds = new Set(ctx.rules.map((r) => r.id));
  const tasks = plan.tasks || [];
  const taskById = new Map();
  const weekendRules = ctx.rules.filter((r) => /weekend|saturday|sunday/i.test(r.text)).map((r) => r.id);

  for (const t of tasks) {
    if (taskById.has(t.id)) add('blocker', 'other', t.id, `Duplicate task id ${t.id}.`, 'Give every task a unique id.');
    taskById.set(t.id, t);
  }

  for (const t of tasks) {
    // --- references must exist ---
    for (const d of t.depends_on || []) {
      if (d === t.id) add('major', 'dependency', t.id, `${t.id} depends on itself.`, 'Remove the self-dependency.');
      else if (!taskById.has(d)) add('major', 'dependency', t.id, `${t.id} depends on unknown task ${d}.`, `Remove ${d} from depends_on or add that task.`);
    }
    for (const fid of t.fact_ids || []) {
      if (!factById.has(fid)) add('major', 'unsupported_claim', t.id, `${t.id} cites unknown fact ${fid}.`, 'Cite only fact ids that exist in the Intake output.', { fact_ids: [fid] });
    }
    for (const rid of t.rule_ids || []) {
      if (!ruleIds.has(rid)) add('major', 'unsupported_claim', t.id, `${t.id} cites unknown rule ${rid}.`, 'Cite only rule ids from the company rules.', { rule_ids: [rid] });
    }
    if (t.kind === 'supported' && !(t.fact_ids || []).length) {
      add('major', 'unsupported_claim', t.id, `${t.id} is labelled "supported" but cites no source facts.`, 'Cite the supporting fact ids, or relabel the task as kind "recommended".');
    }

    // --- owner grounding ---
    const citedFacts = (t.fact_ids || []).map((id) => factById.get(id)).filter(Boolean);
    if (t.owner_basis === 'unassigned' && t.owner) add('blocker', 'invented_owner', t.id, `${t.id} has owner "${t.owner}" but owner_basis is "unassigned".`, 'Set owner to null and raise an unresolved question, or give a valid basis.');
    if (t.owner_basis === 'stated_in_source') {
      if (!t.owner) add('major', 'other', t.id, `${t.id} owner_basis is "stated_in_source" but owner is null.`, 'Fix owner/owner_basis.');
      else if (!citedFacts.some((f) => nameMatches(f.stated_owner, t.owner))) {
        add('blocker', 'invented_owner', t.id, `${t.id} claims "${t.owner}" was named as owner in the source, but none of the cited facts (${(t.fact_ids || []).join(', ') || 'none'}) state that owner.`, 'Only use stated_in_source for an owner named in a cited fact. Otherwise set owner to null (and ask a question) or recommend one from the roster citing a rule.', { rule_ids: ctx.rules.some((r) => r.id === 'R1') ? ['R1'] : [] });
      }
    }
    if (t.owner_basis === 'recommended_by_rule' && !(t.rule_ids || []).length) {
      add('major', 'invented_owner', t.id, `${t.id} owner is "recommended_by_rule" but no rule is cited.`, 'Cite the rule that justifies the recommendation, or leave the owner unassigned.');
    }
    if (t.owner && ctx.roster.length && !ctx.roster.some((p) => nameMatches(p.name, t.owner))) {
      add('blocker', 'invented_owner', t.id, `${t.id} is assigned to "${t.owner}", who is not on the team roster.`, 'Assign only people on the roster, or leave the task unassigned with an open question.', { evidence: 'Roster: ' + ctx.roster.map((p) => p.name).join(', ') });
    }

    // --- deadline grounding ---
    if (t.deadline_basis === 'unassigned' && t.deadline) add('blocker', 'invented_deadline', t.id, `${t.id} has deadline ${t.deadline} but deadline_basis is "unassigned".`, 'Set deadline to null or give a valid basis.');
    if (t.deadline_basis === 'stated_in_source') {
      if (!t.deadline) add('major', 'other', t.id, `${t.id} deadline_basis is "stated_in_source" but deadline is null.`, 'Fix deadline/deadline_basis.');
      else if (!citedFacts.some((f) => f.stated_deadline === t.deadline)) {
        add('blocker', 'invented_deadline', t.id, `${t.id} claims deadline ${t.deadline} was stated in the source, but none of the cited facts state that date.`, 'Only use stated_in_source for a date present in a cited fact. Otherwise recommend a date (recommended_by_rule) or leave it null.');
      }
    }
    if (t.deadline_basis === 'recommended_by_rule' && !(t.rule_ids || []).length) {
      add('major', 'invented_deadline', t.id, `${t.id} deadline is "recommended_by_rule" but no rule is cited.`, 'Cite the rule behind the recommended date or set the deadline to null.');
    }
    if (t.deadline) {
      if (!isIsoDate(t.deadline)) add('major', 'other', t.id, `${t.id} deadline "${t.deadline}" is not a valid ISO date.`, 'Use YYYY-MM-DD.');
      else {
        if (ctx.meeting_date && t.deadline < ctx.meeting_date) add('major', 'rule_violation', t.id, `${t.id} deadline ${t.deadline} is before the meeting date ${ctx.meeting_date}.`, 'Move the deadline on/after the meeting date.', { rule_ids: weekendRules });
        if (weekendRules.length && isWeekend(t.deadline)) add('major', 'rule_violation', t.id, `${t.id} deadline ${t.deadline} falls on a ${weekday(t.deadline)}, which the rules forbid.`, `Move it to a working day (e.g. ${addDays(t.deadline, weekday(t.deadline) === 'Saturday' ? -1 : 1)}).`, { rule_ids: weekendRules });
      }
    }
  }

  // --- dependency graph ---
  const cycle = findCycle(tasks);
  if (cycle) add('blocker', 'dependency', cycle[0], `Dependency cycle: ${cycle.join(' -> ')}.`, 'Break the cycle so the tasks can be ordered.');
  for (const t of tasks) {
    for (const d of t.depends_on || []) {
      const dep = taskById.get(d);
      if (dep && t.deadline && dep.deadline && isIsoDate(t.deadline) && isIsoDate(dep.deadline) && t.deadline < dep.deadline) {
        add('major', 'dependency', t.id, `${t.id} is due ${t.deadline}, before its dependency ${d} (${dep.deadline}).`, `Move ${t.id} to on/after ${dep.deadline} or fix the dependency.`);
      }
    }
  }

  // --- owner workload rule (only if a rule states a numeric limit) ---
  const lim = taskLimitRule(ctx.rules);
  if (lim) {
    const counts = new Map();
    for (const t of tasks) if (t.owner) counts.set(t.owner, (counts.get(t.owner) || 0) + 1);
    for (const [name, n] of counts) {
      if (n > lim.limit) add('major', 'rule_violation', null, `${name} owns ${n} tasks; ${lim.rule_id} allows at most ${lim.limit}.`, `Reassign or leave unassigned until ${name} owns at most ${lim.limit}.`, { rule_ids: [lim.rule_id] });
    }
  }

  // --- open issues must be surfaced, conflicts must not be silently settled ---
  const openIssues = ctx.issues.filter((i) => i.status !== 'resolved');
  const surfaced = new Set((plan.unresolved_questions || []).flatMap((q) => q.related_issue_ids || []));
  for (const i of openIssues) {
    if (!surfaced.has(i.id)) {
      const sev = i.kind === 'ambiguous' ? 'minor' : 'major';
      add(sev, 'missing_coverage', null, `Open ${i.kind} issue ${i.id} ("${i.description.slice(0, 120)}") is not listed in unresolved_questions.`, `Add an unresolved question with related_issue_ids ["${i.id}"] instead of silently resolving it.`, { fact_ids: i.related_fact_ids });
    }
    if (i.kind === 'conflict') {
      for (const t of tasks) {
        const overlap = (t.fact_ids || []).filter((f) => i.related_fact_ids.includes(f));
        if (overlap.length && t.deadline_basis === 'stated_in_source') {
          add('major', 'unsupported_claim', t.id, `${t.id} presents a date as settled although facts ${overlap.join(', ')} are in an open conflict (${i.id}).`, 'Do not treat a conflicting fact as settled: leave the date unassigned or mark it as a recommendation, and raise the conflict as an unresolved question.', { fact_ids: overlap });
        }
      }
    }
  }

  return out.map((f, idx) => ({ id: `G${round}.${idx + 1}`, ...f }));
}

// ---------------------------------------------------- simulated fault demo --

/**
 * SIMULATED FAULT ("planner_violation"): deliberately corrupt a finished plan
 * so the audience can watch the Review Agent catch the problem and send it
 * back. The UI and the event log label this clearly as simulated.
 */
export function injectViolation(plan, ctx) {
  const p = structuredClone(plan);
  const notes = [];
  if (p.tasks.length) {
    const t = p.tasks[0];
    t.owner = 'Jordan Blake';
    t.owner_basis = 'stated_in_source';
    t.kind = 'supported';
    t.fact_ids = [];
    notes.push(`${t.id}: owner replaced by "Jordan Blake" (not on the roster, claimed as stated in the source, no supporting fact)`);
  }
  if (p.tasks.length > 1 && ctx.meeting_date) {
    const t = p.tasks[p.tasks.length - 1];
    let d = addDays(ctx.meeting_date, 10);
    while (!isWeekend(d)) d = addDays(d, 1);
    t.deadline = d;
    t.deadline_basis = 'recommended_by_rule';
    t.rule_ids = ctx.rules.length ? [ctx.rules[0].id] : [];
    notes.push(`${t.id}: deadline moved to ${d} (${weekday(d)})`);
  }
  return { plan: p, description: notes.join('; ') || 'no tasks to corrupt' };
}
