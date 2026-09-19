/**
 * Pure rendering functions: (run, state) -> HTML string. No network or DOM
 * access here; app.js owns state and events. Every dynamic value is escaped.
 */
import { esc, usd, num, ms, when, niceDate, pretty } from './util.js';

const AGENTS = [
  { id: 'intake', name: 'Intake Agent', role: 'Reads the transcript and extracts decisions, requirements and constraints with line references. Flags what is missing or in conflict.' },
  { id: 'planning', name: 'Planning Agent', role: 'Turns the facts and your company rules into tasks, owners, deadlines and dependencies. Labels each one as stated or recommended.' },
  { id: 'review', name: 'Review Agent', role: 'Audits the plan against the transcript and rules, sends specific corrections back to Planning, then rechecks.' },
];
const ACTOR = { intake: 'Intake Agent', planning: 'Planning Agent', review: 'Review Agent', user: 'You', guard: 'Code checks', orchestrator: 'Orchestrator' };
const STATE_TEXT = { running: 'Working', succeeded: 'Done', failed: 'Failed', stale: 'Out of date', idle: 'Waiting' };

const stepsOf = (run, agent) => Object.values(run?.steps || {}).filter((s) => s.agent === agent).sort((a, b) => (a.round ?? -1) - (b.round ?? -1));
const refs = (list = []) => list.map((r) => `<button class="ref" data-action="show-line" data-line="${esc(r.line)}" title="Show line ${esc(r.line)} in the transcript">L${esc(r.line)}</button>`).join(' ');
const simTag = (text) => `<span class="tag sim-tag" title="This was injected by a demo control, it is not a real failure">SIMULATED ${esc(text || '')}</span>`;

function agentState(steps) {
  if (!steps.length) return 'idle';
  if (steps.some((s) => s.status === 'running')) return 'running';
  if (steps.some((s) => s.status === 'failed')) return 'failed';
  if (steps.some((s) => s.status === 'stale')) return 'stale';
  return 'succeeded';
}

/* ---------------------------------------------------------------- relay -- */
export function relay(run, sel) {
  const cells = AGENTS.map((a) => {
    const steps = stepsOf(run, a.id);
    const st = agentState(steps);
    const last = steps[steps.length - 1];
    const calls = steps.reduce((n, s) => n + s.calls, 0);
    const tokens = steps.reduce((n, s) => n + s.input_tokens + s.output_tokens, 0);
    const reused = steps.reduce((n, s) => n + (s.reuse_count || 0), 0);
    const repairs = steps.reduce((n, s) => n + (s.repairs || 0), 0);
    const sim = steps.some((s) => s.simulated_fault);
    const chips = steps.map((s) => `<button class="chip ${s.status}" aria-pressed="${sel === s.key}" data-action="pick-step" data-key="${esc(s.key)}" title="${esc(s.status)}">${esc(s.round === null ? 'run' : `draft ${s.round}`)}${s.status === 'stale' ? ' (old)' : ''}</button>`).join('');
    const detail = last ? (st === 'failed' ? last.error?.message : last.status_detail) : run ? 'Not started yet' : '';
    return `<section class="station ${a.id} ${st === 'failed' ? 'failed' : ''}" aria-label="${esc(a.name)}">
      <h3>${esc(a.name)}</h3>
      <div class="role">${esc(a.role)}</div>
      ${run ? `<div class="state"><span class="st">${STATE_TEXT[st]}</span>${sim ? simTag('fault') : ''}${reused ? `<span class="tag ok" title="Finished earlier with identical input, so no new model call was made">reused x${reused}</span>` : ''}${repairs ? `<span class="tag warn" title="Output failed validation and was regenerated once">repaired x${repairs}</span>` : ''}</div>
      <div class="small">${esc(detail || '')}</div>
      <div class="chips">${chips}</div>
      <div class="metrics">${calls} model call${calls === 1 ? '' : 's'} - ${num(tokens)} tokens - ${usd(steps.reduce((n, s) => n + s.cost_usd, 0))}${last?.latency_ms ? ` - ${ms(last.latency_ms)}` : ''}</div>` : ''}
    </section>`;
  });
  const hand = (from, to, type) => {
    const list = (run?.handoffs || []).filter((h) => h.from === from && h.to === to && h.type === type);
    return list.length ? `<div class="link" title="${esc(list[list.length - 1].summary)}">&rarr;</div>` : '<div class="link">&rarr;</div>';
  };
  return `<div class="relay">${cells[0]}${hand('intake', 'planning', 'facts_and_issues')}${cells[1]}${hand('planning', 'review', 'plan')}${cells[2]}</div>`;
}

export function loopBar(run) {
  const rounds = run?.result?.rounds;
  if (!rounds) {
    const n = Object.values(run?.steps || {}).filter((s) => s.agent === 'review' && s.output).length;
    return n ? '' : '';
  }
  const parts = rounds.map((r) => `<span class="tag">draft ${r.round}</span> <span class="tag ${r.verdict === 'approve' ? 'ok' : 'review'}">${r.verdict === 'approve' ? 'approved' : `sent back: ${r.finding_ids.length} finding${r.finding_ids.length === 1 ? '' : 's'}`}</span>`);
  return `<div class="loopbar"><b>Review loop</b> ${parts.join(' &rarr; ')} <span class="muted">(${run.result.revisions_used} of ${run.result.max_revisions} allowed revisions used)</span></div>`;
}

export function guardBar(run) {
  if (!run?.context) return '';
  const dropped = run.context.dropped_facts?.length || 0;
  const guardFindings = Object.values(run.steps).filter((s) => s.agent === 'review' && s.output).reduce((n, s) => n + (s.output.findings || []).filter((f) => f.source === 'guard').length, 0);
  return `<div class="guardbar"><b>Code checks (no model involved):</b> ${dropped} extracted fact${dropped === 1 ? '' : 's'} dropped for failing quote/owner/date verification - ${guardFindings} plan problem${guardFindings === 1 ? '' : 's'} found by rule checks - the final verdict is computed in code, not taken from the model.</div>`;
}

/* ----------------------------------------------------------------- plan -- */
const ownerBasis = (t) => (t.owner_basis === 'stated_in_source' ? '<span class="basis" title="Said in the meeting">said in meeting</span>' : t.owner_basis === 'recommended_by_rule' ? `<span class="basis rule" title="Proposed by the Planning Agent, citing a rule">recommended ${esc((t.rule_ids || []).join(', '))}</span>` : '<span class="basis none">unassigned</span>');
const dueBasis = (t) => (t.deadline_basis === 'stated_in_source' ? '<span class="basis">said in meeting</span>' : t.deadline_basis === 'recommended_by_rule' ? `<span class="basis rule">recommended ${esc((t.rule_ids || []).join(', '))}</span>` : '<span class="basis none">no date</span>');

function factRefs(run, ids = []) {
  const lines = [];
  for (const id of ids) for (const r of run.context?.facts.find((f) => f.id === id)?.source_refs || []) lines.push(r);
  return refs(lines);
}

function taskCard(run, t) {
  return `<article class="task ${t.kind}">
    <div class="id">${esc(t.id)}</div>
    <div><b>${esc(t.title)}</b><div class="small muted">${esc(t.description || '')}</div>${t.depends_on?.length ? `<div class="small">Waits for ${esc(t.depends_on.join(', '))}</div>` : ''}</div>
    <div><span class="lbl">Owner</span>${t.owner ? `<b>${esc(t.owner)}</b> ` : ''}${ownerBasis(t)}</div>
    <div><span class="lbl">Due</span>${t.deadline ? `<b>${esc(niceDate(t.deadline))}</b> ` : ''}${dueBasis(t)}</div>
    <div class="why">${esc(t.rationale)} ${factRefs(run, t.fact_ids)} ${(t.rule_ids || []).map((r) => `<span class="tag">${esc(r)}</span>`).join(' ')}</div>
  </article>`;
}

export function planTab(run, ui) {
  const res = run.result;
  if (!res) {
    if (run.is_running) {
      return `<div class="empty" role="status" aria-live="polite" style="text-align:left">
        <div class="row" style="gap:.7rem;margin-bottom:.9rem"><span class="loading-spinner" style="width:1.3rem;height:1.3rem"></span><b>${esc(activeLabel(run))}</b></div>
        <div class="skeleton">${[0, 1, 2].map(() => '<div class="sk-card"><div class="sk title"></div><div class="sk line"></div><div class="sk line short"></div></div>').join('')}</div>
        <p class="small muted" style="margin-top:.9rem">The plan appears here as soon as the Review Agent has checked it.</p></div>`;
    }
    return `<div class="empty">${run.status === 'failed' ? 'The run stopped before a plan was produced. Press Resume to continue from the last finished step.' : 'No plan yet.'}</div>`;
  }
  const plan = res.final_plan;
  const ok = res.status === 'approved';
  const supported = plan.tasks.filter((t) => t.kind === 'supported');
  const proposed = plan.tasks.filter((t) => t.kind !== 'supported');
  const d = res.plan_diff;
  const diff = d && (d.added.length || d.removed.length || d.changed.length || d.questions_added.length || d.questions_removed.length)
    ? `<div class="section"><h3>What changed since the previous plan</h3>
      ${d.changed.map((c) => `<div class="qcard"><b>${esc(c.id)} ${esc(c.title)}</b>${c.changes.map((x) => `<div class="small">${esc(x.field)}: <s>${esc(x.from ?? 'none')}</s> &rarr; <b>${esc(x.to ?? 'none')}</b></div>`).join('')}</div>`).join('')}
      ${d.added.map((t) => `<div class="qcard">Added: ${esc(t.title)}</div>`).join('')}${d.removed.map((t) => `<div class="qcard">Removed: ${esc(t.title)}</div>`).join('')}
      ${d.questions_added.map((q) => `<div class="qcard">New open question: ${esc(q)}</div>`).join('')}${d.questions_removed.map((q) => `<div class="qcard">Question closed: ${esc(q)}</div>`).join('')}
      <div class="small muted">Only the affected steps ran again. Unchanged tasks: ${d.unchanged}.</div></div>` : '';
  return `
    <div class="verdict ${ok ? 'ok' : 'bad'}">
      <b>${ok ? 'Approved by the Review Agent' : 'Not approved: needs a human decision'}</b>
      <span>${res.revisions_used} of ${res.max_revisions} revision${res.max_revisions === 1 ? '' : 's'} used - based on facts version ${res.context_version}</span>
      ${res.final_review?.verdict_overridden_by_policy ? '<span class="tag warn">model said approve, code checks disagreed</span>' : ''}
    </div>
    ${ok ? '' : `<div class="section"><h3>Problems left for a human</h3>${res.unresolved_findings.map((f) => finding(f)).join('')}</div>`}
    ${diff}
    <p>${esc(plan.summary)}</p>
    <div class="legend"><span><span class="basis">solid</span> said in the meeting</span><span><span class="basis rule">dashed</span> recommended, cites a rule</span><span><span class="basis none">dotted</span> not known, left open</span></div>
    <div class="section"><h3>Tasks supported by the meeting (${supported.length})</h3><div class="tasks">${supported.map((t) => taskCard(run, t)).join('') || '<div class="muted">None.</div>'}</div></div>
    ${proposed.length ? `<div class="section"><h3>Tasks the Planning Agent recommends (${proposed.length})</h3><div class="tasks">${proposed.map((t) => taskCard(run, t)).join('')}</div></div>` : ''}
    ${plan.recommendations.length ? `<div class="section"><h3>Recommendations</h3>${plan.recommendations.map((r) => `<div class="rec"><b>${esc(r.text)}</b><div class="small muted">${esc(r.rationale)} ${factRefs(run, r.fact_ids)} ${(r.rule_ids || []).map((x) => `<span class="tag">${esc(x)}</span>`).join(' ')}</div></div>`).join('')}</div>` : ''}
    <div class="section"><h3>Open questions (${plan.unresolved_questions.length})</h3>
      ${plan.unresolved_questions.map((q) => {
        const issueId = q.related_issue_ids?.[0];
        const issue = run.context.issues.find((i) => i.id === issueId);
        const open = issue && issue.status !== 'resolved';
        return `<div class="qcard"><b>${esc(q.question)}</b><div class="small muted">${esc(q.why_it_matters)}</div>
          ${open && !run.is_running ? `<div class="row" style="margin-top:.4rem"><button class="btn small ghost" data-action="answer-open" data-issue="${esc(issueId)}">Answer this</button></div>` : ''}
          ${ui.answering === issueId ? answerForm(issueId) : ''}</div>`;
      }).join('') || '<div class="muted">No open questions.</div>'}
    </div>`;
}

function answerForm(issueId) {
  return `<div class="editform" data-form="answer" data-issue="${esc(issueId)}">
    <label class="wide">Your answer (added as a fact you provided, not from the transcript)<input name="statement" maxlength="400" placeholder="e.g. Tomas Reyes will prepare the demo environment"></label>
    <label>Owner (optional)<input name="stated_owner"></label>
    <label>Deadline (optional)<input name="stated_deadline" type="date"></label>
    <div class="wide row"><button class="btn small" data-action="answer-save">Save answer and re-plan</button><button class="btn small ghost" data-action="answer-cancel">Cancel</button></div></div>`;
}

/* -------------------------------------------------------- collaboration -- */
function finding(f, response) {
  return `<div class="finding ${f.source === 'guard' ? 'guard' : ''} ${esc(f.severity)}">
    <div class="row"><b>${esc(f.id)}</b><span class="tag ${f.severity === 'minor' ? '' : 'bad'}">${esc(f.severity)}</span><span class="tag">${esc(String(f.category).replace(/_/g, ' '))}</span>${f.task_id ? `<span class="tag">${esc(f.task_id)}</span>` : ''}<span class="tag ${f.source === 'guard' ? 'guard' : 'review'}">${f.source === 'guard' ? 'found by code checks' : 'found by Review Agent'}</span></div>
    <div>${esc(f.description)}</div>
    ${f.evidence ? `<div class="quote">${esc(f.evidence)}</div>` : ''}
    <div class="small"><b>Correction required:</b> ${esc(f.required_correction)}</div>
    ${response ? `<div class="fix small"><b>Planning Agent ${esc(response.action)}:</b> ${esc(response.explanation)}</div>` : ''}
  </div>`;
}

function rounds(run) {
  const out = [];
  for (let r = 0; r < 10; r += 1) {
    const rv = run.steps[`review:${r}`];
    if (!rv?.output) break;
    const next = run.steps[`planning:${r + 1}`];
    const responses = new Map((next?.output?.addressed_findings || []).map((a) => [a.finding_id, a]));
    out.push(`<div class="section"><h3>Draft ${r}: ${rv.output.verdict === 'approve' ? 'approved' : `sent back with ${rv.output.findings.length} finding${rv.output.findings.length === 1 ? '' : 's'}`} ${run.steps[`planning:${r}`]?.simulated_fault ? simTag('rule violation injected') : ''}</h3>
      ${run.steps[`planning:${r}`]?.simulated_fault ? `<div class="sim small" style="margin-bottom:.5rem">Demo control: after the Planning Agent finished, the plan was deliberately corrupted (${esc(run.steps[`planning:${r}`].simulated_fault.description)}). The checks below are real.</div>` : ''}
      ${rv.output.findings.map((f) => finding(f, responses.get(f.id))).join('') || '<div class="muted">No findings.</div>'}
      <details class="fold"><summary>What the Review Agent checked</summary><ul>${(rv.output.checks_performed || []).map((c) => `<li>${esc(c)}</li>`).join('')}</ul></details></div>`);
  }
  return out.join('');
}

function ledger(run) {
  return `<ol class="ledger">${[...run.handoffs].reverse().map((h) => `<li class="ho"><details><summary>
      <span class="small muted">#${h.seq}</span><span class="who ${esc(h.from)}">${esc(ACTOR[h.from] || h.from)}</span> &rarr; <span class="who ${esc(h.to)}">${esc(ACTOR[h.to] || h.to)}</span>
      <span class="tag">${esc(h.type.replace(/_/g, ' '))}</span><span>${esc(h.summary)}</span>
      <span class="tag ${h.validation.ok ? 'ok' : 'bad'}">${h.validation.ok ? 'schema valid' : 'rejected'}</span><span class="tag">context v${esc(h.context_version)}</span><span class="small muted">${esc(when(h.at))}</span></summary>
      ${h.validation.ok ? '' : `<div class="small">${esc(h.validation.errors.join('; '))}</div>`}<pre>${esc(pretty(h.payload))}</pre></details></li>`).join('')}</ol>`;
}

function inspector(run, key) {
  const s = run.steps[key];
  if (!s) return '<div class="muted">Select a step chip above (for example "draft 0" under Planning) to see exactly what that agent received and produced.</div>';
  return `<div class="row"><b>${esc(s.label)} - ${esc(s.key)}</b><span class="tag">${esc(s.status)}</span><span class="tag">${esc(s.model || run.provider.name)}</span><span class="tag">context v${esc(s.context_version ?? '-')}</span>${s.simulated_fault ? simTag(s.simulated_fault.kind) : ''}</div>
    ${s.error ? `<div class="finding"><b>${s.error.simulated ? 'SIMULATED failure: ' : 'Failure: '}</b>${esc(s.error.message)}</div>` : ''}
    <div class="io"><div><h4>Received</h4><pre>${esc(pretty(s.input_preview))}</pre></div><div><h4>Produced</h4><pre>${esc(s.output ? pretty(s.output) : 'nothing (step did not finish)')}</pre></div></div>`;
}

export function collabTab(run, ui) {
  return `<div class="section"><h3>Step inspector</h3>${inspector(run, ui.step)}</div>
    <div class="section"><h3>Feedback between Planning and Review</h3>${rounds(run) || '<div class="muted">No review has finished yet.</div>'}</div>
    <div class="section"><h3>Handoff ledger</h3><p class="small muted">Every message between agents is validated against a schema before the next agent sees it. Newest first.</p>${ledger(run)}</div>`;
}

/* --------------------------------------------------------- facts + source -- */
function factCard(run, f, ui, canEdit) {
  const editing = ui.editing === f.id;
  return `<article class="fact">
    <div class="row between"><div><b>${esc(f.id)}</b> <span class="tag">${esc(f.type)}</span> ${f.origin === 'user_answer' ? '<span class="tag ok">provided by you</span>' : ''}${f.user_corrected ? '<span class="tag warn">corrected by you</span>' : ''}</div>
      ${canEdit ? `<button class="btn small ghost" data-action="edit-fact" data-fact="${esc(f.id)}">Correct</button>` : ''}</div>
    <div>${esc(f.statement)}</div>
    <div class="meta small">${f.stated_owner ? `<span class="tag">owner: ${esc(f.stated_owner)}</span>` : ''}${f.stated_deadline ? `<span class="tag">due: ${esc(niceDate(f.stated_deadline))}</span>` : ''} ${refs(f.source_refs)}</div>
    ${f.original ? `<div class="small muted">Original: owner ${esc(f.original.stated_owner ?? 'none')}, due ${esc(f.original.stated_deadline ?? 'none')}</div>` : ''}
    ${editing ? `<div class="editform" data-form="fact" data-fact="${esc(f.id)}">
      <label class="wide">Statement<input name="statement" value="${esc(f.statement)}" maxlength="400"></label>
      <label>Owner<input name="stated_owner" value="${esc(f.stated_owner ?? '')}"></label>
      <label>Deadline<input name="stated_deadline" type="date" value="${esc(f.stated_deadline ?? '')}"></label>
      <label class="wide">Why (optional note)<input name="note" placeholder="e.g. Dana confirmed the new date in chat"></label>
      <div class="wide row"><button class="btn small" data-action="save-fact">Save and re-run affected steps</button><button class="btn small ghost" data-action="cancel-edit">Cancel</button></div></div>` : ''}
  </article>`;
}

export function factsTab(run, ui) {
  if (!run.context) return '<div class="empty">The Intake Agent has not produced facts yet.</div>';
  const canEdit = !run.is_running;
  const c = run.context;
  return `<p class="small muted">This is the shared context both later agents read. Version ${c.version}. Correcting a fact creates a new version, marks the old plan out of date, and re-runs only the steps whose input changed.</p>
    <div class="section"><h3>Facts (${c.facts.length})</h3>${c.facts.map((f) => factCard(run, f, ui, canEdit)).join('')}</div>
    <div class="section"><h3>Issues the Intake Agent flagged (${c.issues.length})</h3>${c.issues.map((i) => `<div class="qcard"><div class="row"><b>${esc(i.id)}</b><span class="tag ${i.kind === 'conflict' ? 'bad' : 'warn'}">${esc(i.kind)}</span><span class="tag ${i.status === 'resolved' ? 'ok' : ''}">${esc(i.status || 'open')}</span></div>
      <div>${esc(i.description)}</div>${i.resolution ? `<div class="small">Resolved by you: ${esc(i.resolution)}</div>` : ''}<div class="small">${refs(i.source_refs)}</div>
      ${i.status !== 'resolved' && canEdit ? `<button class="btn small ghost" data-action="answer-open" data-issue="${esc(i.id)}">Answer this</button>` : ''}${ui.answering === i.id ? answerForm(i.id) : ''}</div>`).join('') || '<div class="muted">None.</div>'}</div>
    ${c.dropped_facts.length ? `<div class="section"><h3>Dropped by code checks (${c.dropped_facts.length})</h3><p class="small muted">These never reached the Planning Agent because they could not be verified against the transcript.</p>${c.dropped_facts.map((d) => `<div class="fact dropped"><div>${esc(d.fact?.statement || d.fact?.id)}</div><div class="small" style="color:var(--bad)">${esc((d.reasons || []).join('; '))}</div></div>`).join('')}</div>` : ''}
    <div class="section"><h3>Context history</h3>${run.context_versions.map((v) => `<div class="small"><b>v${v.version}</b> ${esc(when(v.at))} - ${esc(v.reason)}</div>`).join('')}</div>`;
}

export function sourceTab(run, ui) {
  const hit = new Set(ui.lines || []);
  const inp = run.inputs;
  if (ui.editSource) {
    return `<div class="editform" data-form="source" style="grid-template-columns:1fr">
      <p class="small">Changing the transcript makes the Intake Agent extract again (your fact corrections are discarded). Changing only rules or roster reuses Intake.</p>
      <label>Meeting date<input name="meeting_date" type="date" value="${esc(inp.meeting_date ?? '')}"></label>
      <label>Transcript<textarea name="transcript" rows="12">${esc(inp.transcript_raw)}</textarea></label>
      <label>Company rules (one per line)<textarea name="rules_text" rows="8">${esc(inp.rules_raw)}</textarea></label>
      <label>Roster (Name - Role)<textarea name="roster_text" rows="5">${esc(inp.roster_raw)}</textarea></label>
      <div class="row"><button class="btn" data-action="save-source">Save and re-run affected steps</button><button class="btn ghost" data-action="cancel-source">Cancel</button></div></div>`;
  }
  return `<div class="row between" style="margin-bottom:.6rem"><p class="muted small" style="margin:0">Numbered lines are what agents cite. Click an L-number anywhere to highlight its line here.</p>${run.is_running ? '' : '<button class="btn small ghost" data-action="edit-source">Edit source</button>'}</div>
    <div class="transcript">${inp.transcript_lines.map((l) => `<div class="tl ${hit.has(l.line) ? 'hit' : ''}" id="line-${l.line}"><b>${l.line}</b><span>${esc(l.text)}</span></div>`).join('')}</div>
    <div class="section" style="margin-top:1.2rem"><h3>Company rules</h3><ul class="rules">${inp.rules.map((r) => `<li><b>${esc(r.id)}</b> ${esc(r.text)}</li>`).join('')}</ul></div>
    <div class="section"><h3>Roster</h3><ul class="rules">${inp.roster.map((p) => `<li><b>${esc(p.name)}</b> ${esc(p.role)}</li>`).join('') || '<li class="muted">No roster given.</li>'}</ul></div>`;
}

export function logTab(run) {
  return `<ul class="log">${[...run.events].reverse().map((e) => `<li class="${esc(e.level)}"><span class="muted">${esc(when(e.at))}</span><span>${esc(ACTOR[e.actor] || e.actor)}</span><span>${esc(e.message)}</span></li>`).join('')}</ul>`;
}

/* ------------------------------------------------------------ demo tab -- */
export function demoTab(run, ui, health) {
  const idle = run && !run.is_running;
  const iso = ui.isolation;
  return `<p class="muted">One-click versions of the five cases the brief asks for. Anything injected is labelled SIMULATED wherever it appears.</p>
  <div class="demo">
    <div class="case"><div><h4>1. Complete three-agent run</h4><p>Runs the Beacon 2.0 sample end to end: Intake, Planning, Review. It contains a conflicting date, a missing owner and a planted "ignore the rules" line the agents must not obey.</p></div><button class="btn" data-action="demo-complete">Run it</button></div>
    <div class="case"><div><h4>2. Rule violation sent back for correction ${simTag()}</h4><p>Starts a run where the first plan is deliberately corrupted (invented owner, weekend deadline). Watch the Review loop find it, send it back, and recheck the revision.</p></div><button class="btn" data-action="demo-violation">Run it</button></div>
    <div class="case"><div><h4>3. A changed fact flows through the plan</h4><p>Moves the first dated fact a few days later. Intake is reused, Planning and Review re-run, and the Plan tab shows what changed.</p></div><button class="btn" data-action="demo-change" ${idle && run?.context ? '' : 'disabled'}>${idle && run?.context ? 'Change a fact' : 'Finish a run first'}</button></div>
    <div class="case"><div><h4>4. Recovery after a model failure ${simTag()}</h4><p>Starts a run where the Planning Agent's call fails. Intake's finished work is kept. Press Resume: only Planning and Review run.</p></div><button class="btn" data-action="demo-failure">Run it</button></div>
    <div class="case"><div><h4>5. Two sessions never share private context</h4><p>Runs two throwaway sessions at the same time, each with a secret marker, and inspects every prompt, lookup and stored file for leaks. Uses model calls (about two small runs). You can also open this page in a private window: it shows an empty workspace.</p>
      ${iso ? `<div class="checks">${iso.status === 'running' ? '<span class="muted">Running both sessions...</span>' : iso.error ? `<span class="bad">${esc(iso.error)}</span>` : `<span class="tag ${iso.report.ok ? 'ok' : 'bad'}">${iso.report.ok ? 'All checks passed' : 'A check failed'}</span>${iso.report.checks.map((c) => `<div class="small"><span class="tag ${c.pass ? 'ok' : 'bad'}">${c.pass ? 'pass' : 'fail'}</span> ${esc(c.name)} - ${esc(c.detail || '')}</div>`).join('')}`}</div>` : ''}</div>
      <button class="btn" data-action="demo-isolation" ${iso?.status === 'running' ? 'disabled' : ''}>Run the test</button></div>
    <div class="case sim"><div><h4>Re-run this run with a simulated fault ${simTag()}</h4>
      <div class="row"><label>Restart from<select id="rr-from"><option value="planning">Planning Agent</option><option value="intake">Intake Agent</option></select></label>
      <label>Fault<select id="rr-kind"><option value="model_error">Model call fails</option><option value="invalid_output">Model returns malformed output</option><option value="planner_violation">First plan breaks a rule</option></select></label>
      <label>At agent<select id="rr-agent"><option value="planning">Planning</option><option value="review">Review</option><option value="intake">Intake</option></select></label></div></div>
      <button class="btn" data-action="demo-rerun" ${idle ? '' : 'disabled'}>Re-run with fault</button></div>
  </div>`;
}

/** Wording for the current stage of a running run. Read-only; drives no logic. */
const WORKING = {
  intake: 'Intake Agent is reading the transcript and extracting facts…',
  planning: 'Planning Agent is turning facts and rules into tasks…',
  review: 'Review Agent is auditing the plan against the source…',
};
function activeLabel(run) {
  const live = Object.values(run?.steps || {}).find((s) => s.status === 'running');
  return live ? WORKING[live.agent] || 'Agents are working…' : 'Agents are working through the review loop…';
}

/* -------------------------------------------------------------- shell -- */
export function runHeader(run) {
  const st = run.is_running ? 'running' : run.status;
  const label = { running: 'Running', completed: 'Completed', failed: 'Stopped by an error', interrupted: 'Interrupted by a server restart', needs_review: 'Needs human review', created: 'Ready' }[st] || st;
  const canStop = run.is_running;
  const canResume = ['failed', 'interrupted', 'created'].includes(run.status) && !run.is_running;
  const steps = Object.values(run.steps || {});
  const done = steps.filter((s) => ['succeeded', 'failed', 'stale'].includes(s.status)).length;
  const progress = run.is_running ? Math.min(96, Math.max(14, Math.round((done / Math.max(steps.length || 1, 3)) * 100))) : 100;
  const statusMessage = run.is_running ? activeLabel(run) : run.result?.status === 'approved' ? 'Plan approved and ready to export as a PDF.' : 'Review finished and ready for inspection.';
  return `<div class="runhead"><div><h2>${esc(run.title)}</h2><div class="row"><span class="tag"><i class="dot ${esc(st)}"></i>${esc(label)}</span><span class="small muted">${esc(run.provider.name)}${run.provider.mock ? ' (mock)' : ''} - ${run.usage.calls} model calls - ${num(run.usage.input_tokens + run.usage.output_tokens)} tokens - about ${usd(run.usage.cost_usd)}</span></div>
    <div class="run-progress-wrap" aria-live="polite">
      <div class="run-progress-track"><span class="run-progress-bar" style="width:${progress}%"></span></div>
      <div class="small muted">${esc(statusMessage)}</div>
    </div>
    ${run.error ? `<div class="finding" style="margin-top:.6rem"><b>${run.error.simulated ? 'SIMULATED failure' : 'Error'}${run.error.step ? ` in ${esc(run.error.step)}` : ''}:</b> ${esc(run.error.message)}<div class="small">Finished steps are saved. Resume continues without repeating them.</div></div>` : ''}</div>
    <div class="row">${canStop ? '<button class="btn ghost" data-action="stop-run">Stop run</button>' : ''}${canResume ? '<button class="btn" data-action="resume">Resume</button>' : ''}<button class="btn ghost" data-action="delete-run" ${run.is_running ? 'disabled' : ''}>Delete run</button><button class="btn ghost" data-action="download-plan-pdf" ${run.result?.final_plan ? '' : 'disabled'}>Download PDF</button></div></div>`;
}

export function tabs(active) {
  const t = [['plan', 'Plan'], ['collab', 'How the agents worked'], ['facts', 'Facts and issues'], ['source', 'Source'], ['log', 'Activity'], ['demo', 'Demo cases']];
  return `<div class="tabs" role="tablist">${t.map(([id, label]) => `<button role="tab" aria-selected="${active === id}" data-action="tab" data-tab="${id}">${label}</button>`).join('')}</div>`;
}

export function idleRelay() {
  return `<div class="hero panel"><div><p class="eyebrow">AI operations review</p><h2>Turn a meeting into a reviewed plan</h2><p class="muted">Three agents pass work through a validated review loop. Pick a sample on the left and start a run to see the plan emerge live.</p></div><div class="hero-actions"><button class="btn" data-action="demo-complete">Try a full run</button></div></div>${relay(null, null)}
    <div class="guardbar"><b>Code checks (no model involved)</b> verify every quote exists in the transcript, every owner is on the roster, dates fall on weekdays and dependencies have no cycles. The approve/revise verdict is decided in code.</div>`;
}

/** A placeholder shaped like the real relay, so nothing jumps when content arrives. */
function skeletonRelay() {
  return `<div class="sk-relay" aria-hidden="true">${AGENTS.map(() => `<div class="sk-card">
      <div class="sk title"></div><div class="sk line"></div><div class="sk line short"></div>
      <div class="chips"><span class="sk chip"></span><span class="sk chip"></span></div>
    </div>`).join('')}</div>`;
}

export function loadingShell({ title, description }) {
  return `<div class="loading-shell panel" role="status" aria-live="polite"><div class="loading-spinner" aria-hidden="true"></div>
    <div><h2>${esc(title)}</h2><p class="muted">${esc(description)}</p><div class="mini-progress" aria-hidden="true"><span></span></div></div></div>
    ${skeletonRelay()}
    <div class="sk-card" aria-hidden="true"><div class="sk title"></div><div class="sk line"></div><div class="sk line"></div><div class="sk line short"></div></div>`;
}

export function railNew(state) {
  const s = state.samples.find((x) => x.id === state.sampleId) || state.samples[0];
  const ready = state.health?.llm_ready;
  return `<div class="panel"><h3>New run</h3><div class="stack">
    <div class="samples" role="radiogroup" aria-label="Sample">${state.samples.map((x) => `<label><input type="radio" name="sample" value="${esc(x.id)}" ${x.id === s?.id ? 'checked' : ''}><span><b>${esc(x.name)}</b><br><span class="small muted">${esc(x.description || '')}</span></span></label>`).join('')}</div>
    <details class="fold"><summary>Edit the input before running</summary><div class="stack">
      <label>Title<input id="f-title" value="${esc(s?.title ?? '')}"></label>
      <label>Meeting date<input id="f-date" type="date" value="${esc(s?.meeting_date ?? '')}"></label>
      <label>Transcript<textarea id="f-transcript" rows="8">${esc(s?.transcript ?? '')}</textarea></label>
      <label>Company rules<textarea id="f-rules" rows="6">${esc(s?.rules_text ?? '')}</textarea></label>
      <label>Roster (Name - Role)<textarea id="f-roster" rows="4">${esc(s?.roster_text ?? '')}</textarea></label></div></details>
    <div class="sim"><details class="fold"><summary>Simulate a fault (demo) ${simTag()}</summary><div class="stack">
      <label class="row" style="font-weight:400"><input type="checkbox" id="x-violation" style="width:auto"> First plan breaks a rule</label>
      <label class="row" style="font-weight:400"><input type="checkbox" id="x-fail" style="width:auto"> Model call fails at
        <select id="x-fail-agent" style="width:auto"><option value="planning">Planning</option><option value="review">Review</option><option value="intake">Intake</option></select></label></div></details></div>
    <button class="btn" id="start" data-action="start" ${ready ? '' : 'disabled'}>Start run</button>
    ${ready ? '' : `<div class="small bad">${esc(state.health?.llm_reason || 'The model is not configured.')}</div>`}
  </div></div>`;
}

export function railRuns(state) {
  return `<div class="panel"><h3>Your runs</h3>${state.runs.length ? `<ul class="runs">${state.runs.map((r) => `<li><button data-action="open-run" data-id="${esc(r.id)}" aria-current="${r.id === state.runId}"><span><i class="dot ${esc(r.is_running ? 'running' : r.status)}"></i><b>${esc(r.title)}</b></span><span class="small muted">${esc(r.is_running ? 'running' : r.result_status === 'approved' ? 'approved' : r.status.replace('_', ' '))} - ${usd(r.cost_usd)}</span></button></li>`).join('')}</ul>` : '<div class="small muted">No runs yet. They are private to this browser.</div>'}
    <div class="row" style="margin-top:.7rem"><button class="btn small danger" data-action="reset">Reset workspace</button></div></div>`;
}
