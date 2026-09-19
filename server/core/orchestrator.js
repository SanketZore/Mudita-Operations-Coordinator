/**
 * orchestrator.js - runs the three agents as a coordinated, resumable pipeline.
 *
 *   transcript --> [Intake] --facts--> [Planning] --plan--> [Review]
 *                                          ^                   |
 *                                          +---- corrections --+   (bounded loop)
 *
 * KEY DESIGN IDEAS (see PROJECT_EXPLANATION.md for the long version)
 *
 * 1. STEPS ARE IDEMPOTENT. Every agent execution is a "step" with a key
 *    (intake, planning:0, review:0, planning:1, ...) and an input hash. Running
 *    the pipeline again re-walks the same path; a step whose stored input hash
 *    matches and which already succeeded is REUSED - no model call. That single
 *    rule gives us: resume after failure, no duplicated work, and minimal
 *    re-execution after a correction (only steps whose input changed re-run).
 *
 * 2. CONTEXT IS VERSIONED. The shared "source facts" live in run.context with a
 *    version number. A user correction bumps the version and marks downstream
 *    steps `stale`. Because the version-dependent data is part of each step's
 *    input hash, a stale step can never be reused: no stale context.
 *
 * 3. HANDOFFS ARE VALIDATED. Each agent's input and output is checked against a
 *    JSON schema, and semantic grounding is verified by deterministic guards.
 *    Failures go back to the agent as validation feedback (bounded repairs).
 *
 * 4. THE REVIEW LOOP IS BOUNDED (REVIEW_MAX_REVISIONS). If it cannot converge the
 *    run ends as `needs_review` and the unresolved findings are surfaced.
 *
 * 5. SESSIONS ARE ISOLATED. Prompts are built only from the run's own data.
 */
import { agents } from '../agents/index.js';
import { validate } from './validate.js';
import { HandoffEnvelope } from './schemas.js';
import * as guards from './guards.js';
import { splitTranscript, parseRules, parseRoster } from './text.js';
import { diffPlans } from './diff.js';
import { hashOf, newId } from './hash.js';
import { isIsoDate, weekday } from './dates.js';
import { LLMError } from '../llm/errors.js';
import { ApiError, HandoffError } from './errors.js';

const nowIso = () => new Date().toISOString();
const clone = (o) => JSON.parse(JSON.stringify(o));
const FAULT_KINDS = ['model_error', 'invalid_output', 'planner_violation'];
const FAULT_AGENTS = ['intake', 'planning', 'review'];
const FACT_EDITABLE = ['statement', 'stated_owner', 'stated_deadline', 'stated_deadline_text'];

export function createOrchestrator({ store, llm, config }) {
  const running = new Map(); // "sid/rid" -> Promise (in-process mutex + lets tests await completion)
  const promptListeners = new Set();
  const runKey = (run) => `${run.session_id}/${run.id}`;
  const save = (run) => store.saveRun(run);

  // ------------------------------------------------------------- utilities --
  function log(run, level, actor, message) {
    run.events.push({ at: nowIso(), level, actor, message });
    if (run.events.length > 400) run.events.splice(0, run.events.length - 400);
  }

  function addUsage(run, step, usage) {
    const cost = config.provider === 'mock' ? 0 : (usage.input_tokens / 1e6) * config.pricing.inputPerMTok + (usage.output_tokens / 1e6) * config.pricing.outputPerMTok;
    for (const o of [step, run.usage]) {
      o.calls += usage.calls ?? 1;
      o.input_tokens += usage.input_tokens;
      o.output_tokens += usage.output_tokens;
      o.cost_usd = +(o.cost_usd + cost).toFixed(6);
    }
  }

  function handoff(run, { from, to, type, schema, payload, summary, validation, dedupe, context_version }) {
    const dedupe_key = dedupe || `${type}:${from}:${to}:${hashOf(payload)}`;
    if (run.handoffs.some((h) => h.dedupe_key === dedupe_key)) return; // idempotent on resume
    const env = {
      id: newId(4),
      seq: run.handoffs.length + 1,
      dedupe_key,
      from,
      to,
      type,
      schema,
      context_version: context_version ?? run.context?.version ?? 0,
      validation: validation || { ok: true, errors: [] },
      summary,
      payload,
      at: nowIso(),
    };
    const v = validate(HandoffEnvelope, env);
    if (!v.ok) throw new HandoffError(`Internal handoff envelope invalid: ${v.errors.join('; ')}`);
    run.handoffs.push(env);
  }

  function emitPrompt(run, agent, system, user) {
    for (const fn of promptListeners) fn({ session_id: run.session_id, run_id: run.id, agent, system, user });
  }

  function takeFault(run, kind, agent) {
    const f = run.faults.find((x) => !x.consumed && x.kind === kind && (!x.agent || x.agent === agent));
    if (!f) return null;
    f.consumed = true;
    f.consumed_at = nowIso();
    return f;
  }

  function previewInput(input) {
    const c = { ...input };
    if (c.transcript_lines) c.transcript_lines = `[${c.transcript_lines.length} numbered transcript lines - see the Source tab]`;
    return c;
  }

  const leanFact = (f) => ({
    id: f.id,
    type: f.type,
    statement: f.statement,
    source_refs: f.source_refs,
    stated_owner: f.stated_owner,
    stated_deadline: f.stated_deadline,
    stated_deadline_text: f.stated_deadline_text,
    ...(f.user_corrected ? { user_corrected: true } : {}),
    ...(f.origin === 'user_answer' ? { user_provided: true } : {}),
  });
  const leanIssue = (i) => ({ id: i.id, kind: i.kind, status: i.status || 'open', description: i.description, related_fact_ids: i.related_fact_ids, suggested_question: i.suggested_question, ...(i.resolution ? { resolution: i.resolution } : {}) });

  const guardCtx = (run) => ({ facts: run.context.facts, issues: run.context.issues, rules: run.inputs.rules, roster: run.inputs.roster, meeting_date: run.inputs.meeting_date || null });
  const meetingOf = (run) => ({ title: run.title, date: run.inputs.meeting_date || null, weekday: run.inputs.meeting_date ? weekday(run.inputs.meeting_date) : null });
  const annotatePlan = (plan) => ({ ...plan, tasks: plan.tasks.map((t) => ({ ...t, deadline_weekday: t.deadline ? weekday(t.deadline) : null })) });

  function archiveStep(run, step, status) {
    run.step_archive.push({ ...step, status, archived_at: nowIso() });
    if (run.step_archive.length > 80) run.step_archive.splice(0, run.step_archive.length - 80);
  }

  function markDownstreamStale(run) {
    for (const s of Object.values(run.steps)) if (s.agent !== 'intake' && s.status !== 'running') s.status = 'stale';
  }

  function bumpContext(run, reason, changes = []) {
    run.context.version += 1;
    run.context_versions.push({ version: run.context.version, at: nowIso(), reason, changes, facts: clone(run.context.facts), issues: clone(run.context.issues) });
    markDownstreamStale(run);
    log(run, 'info', 'orchestrator', `Shared context is now v${run.context.version}: ${reason}. Planning and Review steps marked stale.`);
  }

  // ------------------------------------------------- one agent invocation --
  /**
   * Validate input -> call model -> validate output (schema + grounding) ->
   * on failure, send validation feedback and retry (bounded) -> finalize.
   */
  async function invokeAgent(run, step, agent, input) {
    if (run.stop_requested) throw new LLMError('Stopped by user request.', { stop_requested: true });
    const inV = validate(agent.inputSchema, input);
    if (!inV.ok) throw new HandoffError(`Input for ${agent.label} failed schema validation: ${inV.errors.join('; ')}`);

    const { system, user } = agent.buildPrompt(input);
    const maxAttempts = 1 + config.llm.maxSchemaRepairs;
    let repairNote = '';
    let data = null;
    let schemaOk = false;
    let remaining = [];

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      // --- SIMULATED FAULT: model provider outage (one-shot, clearly labelled) ---
      if (attempt === 0 && takeFault(run, 'model_error', agent.name)) {
        log(run, 'warn', agent.name, 'SIMULATED FAULT: the model provider is made to fail here (injected by the demo control, not a real outage).');
        save(run);
        throw new LLMError('SIMULATED FAULT: model provider returned HTTP 503 (injected by the demo control)', { simulated: true });
      }
      const finalUser = repairNote ? `${user}\n\n${repairNote}` : user;
      emitPrompt(run, agent.name, system, finalUser);

      let res;
      if (attempt === 0 && takeFault(run, 'invalid_output', agent.name)) {
        log(run, 'warn', agent.name, 'SIMULATED FAULT: the model output is replaced by malformed JSON (demo control) to show validation + repair.');
        res = { data: { simulated: 'malformed output' }, usage: { input_tokens: 0, output_tokens: 0, calls: 0 }, model: 'simulated-fault', simulated: true };
      } else {
        step.status_detail = attempt ? `repair attempt ${attempt}` : 'calling model';
        save(run);
        res = await llm.call({ agent: agent.name, system, user: finalUser, input, schema: agent.outputSchema, toolName: agent.toolName, toolDescription: agent.toolDescription });
        step.latency_ms += res.latency_ms || 0;
      }
      addUsage(run, step, res.usage);
      step.model = res.model;

      const v = validate(agent.outputSchema, res.data);
      schemaOk = v.ok;
      let errors = v.errors;
      if (v.ok) errors = agent.check(input, res.data);
      if (!errors.length) {
        data = res.data;
        remaining = [];
        break;
      }
      data = v.ok ? res.data : null;
      remaining = errors;
      log(run, 'warn', 'guard', `${agent.label}: output rejected (${errors.length} problem${errors.length > 1 ? 's' : ''}): ${errors.slice(0, 3).join(' | ')}`);
      handoff(run, {
        from: 'guard',
        to: agent.name,
        type: 'validation_feedback',
        schema: 'ValidationFeedback@1',
        payload: { attempt, errors },
        summary: `${errors.length} validation problem(s) sent back to ${agent.label}`,
        validation: { ok: false, errors },
        dedupe: `vf:${step.key}:${attempt}:${hashOf(errors)}`,
      });
      if (attempt < maxAttempts - 1) step.repairs += 1;
      repairNote = `VALIDATION FEEDBACK - your previous output was rejected by the automatic checks: ${errors.join('; ')}. Return a COMPLETE corrected output (every field), fixing these problems.`;
    }

    if (!schemaOk || !data) throw new HandoffError(`${agent.label} output failed schema validation after ${maxAttempts} attempt(s): ${remaining.join('; ')}`);
    const { output, meta } = agent.finalize ? agent.finalize(input, data) : { output: data, meta: {} };
    return { output, meta: { ...meta, remaining_validation_errors: remaining } };
  }

  /** Reuse a finished identical step, or execute a new one. Returns {step, fresh}. */
  async function ensureStep(run, agent, round, input) {
    const key = round === null ? agent.name : `${agent.name}:${round}`;
    const input_hash = hashOf({ agent: agent.name, input, epoch: run.epochs[agent.name] ?? 0 });
    const existing = run.steps[key];

    if (existing && existing.status === 'succeeded' && existing.input_hash === input_hash) {
      existing.reuse_count = (existing.reuse_count || 0) + 1;
      log(run, 'info', agent.name, `Step ${key} already completed with identical input - reused, no model call.`);
      save(run);
      return { step: existing, fresh: false };
    }
    if (existing) archiveStep(run, existing, ['succeeded', 'stale'].includes(existing.status) ? 'superseded' : existing.status);

    const step = {
      key,
      agent: agent.name,
      label: agent.label,
      round,
      status: 'running',
      status_detail: 'starting',
      input_hash,
      context_version: run.context ? run.context.version : null,
      input_preview: previewInput(input),
      output: null,
      meta: {},
      error: null,
      model: null,
      calls: 0,
      repairs: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      latency_ms: 0,
      reuse_count: 0,
      simulated_fault: null,
      started_at: nowIso(),
      finished_at: null,
    };
    run.steps[key] = step;
    log(run, 'info', agent.name, `Step ${key} started (context v${step.context_version ?? '-'}).`);
    save(run);

    try {
      const { output, meta } = await invokeAgent(run, step, agent, input);
      step.output = output;
      step.meta = meta;
      step.status = 'succeeded';
      step.status_detail = agent.summarize(output);
      step.finished_at = nowIso();
      log(run, 'info', agent.name, `Step ${key} finished: ${step.status_detail}.`);
      save(run);
      return { step, fresh: true };
    } catch (err) {
      step.status = 'failed';
      step.status_detail = 'failed';
      step.error = { message: err.message, simulated: !!err.simulated, at: nowIso() };
      step.finished_at = nowIso();
      log(run, 'error', agent.name, `Step ${key} FAILED: ${err.message}`);
      save(run);
      err.step = key;
      throw err;
    }
  }

  // ----------------------------------------------------------- the pipeline --
  async function runIntake(run) {
    const input = { meeting: { title: run.title, date: run.inputs.meeting_date || null }, transcript_lines: run.inputs.transcript_lines };
    const { step, fresh } = await ensureStep(run, agents.intake, null, input);
    if (fresh || !run.context) {
      const out = step.output;
      const first = !run.context;
      const version = (run.context?.version ?? 0) + 1;
      run.context = {
        version,
        summary: out.summary,
        facts: out.facts.map((f) => ({ ...f, origin: 'transcript' })),
        issues: out.issues.map((i) => ({ ...i, status: 'open' })),
        dropped_facts: step.meta.dropped_facts || [],
      };
      run.context_versions.push({ version, at: nowIso(), reason: first ? 'Initial extraction by the Intake Agent' : 'Transcript re-extracted by the Intake Agent (earlier user corrections were discarded)', changes: [], facts: clone(run.context.facts), issues: clone(run.context.issues) });
      markDownstreamStale(run);
      step.context_version = version;
      if (run.context.dropped_facts.length) log(run, 'warn', 'guard', `${run.context.dropped_facts.length} extracted fact(s) failed grounding checks (quote/owner/date not found in transcript) and were dropped.`);
      save(run);
    }
    return step;
  }

  async function runReviewLoop(run) {
    const maxRev = config.review.maxRevisions;
    let feedback = null;
    let plan = null;
    let reviewOut = null;
    let lastRound = 0;

    for (let round = 0; round <= maxRev; round += 1) {
      lastRound = round;
      const ctxV = run.context.version;
      const planningInput = {
        context_version: ctxV,
        meeting: meetingOf(run),
        facts: run.context.facts.map(leanFact),
        issues: run.context.issues.map(leanIssue),
        rules: run.inputs.rules,
        roster: run.inputs.roster,
        feedback,
      };
      if (round === 0) {
        handoff(run, { from: 'intake', to: 'planning', type: 'facts_and_issues', schema: 'IntakeOutput@1', payload: { facts: planningInput.facts, issues: planningInput.issues }, summary: `${planningInput.facts.length} facts, ${planningInput.issues.length} issues (context v${ctxV})`, context_version: ctxV });
      }
      const { step: pStep, fresh } = await ensureStep(run, agents.planning, round, planningInput);

      // SIMULATED FAULT: corrupt the first plan so the Review loop has something real to catch.
      if (fresh && round === 0 && takeFault(run, 'planner_violation', null)) {
        const { plan: bad, description } = guards.injectViolation(pStep.output, guardCtx(run));
        pStep.output = bad;
        pStep.simulated_fault = { kind: 'planner_violation', description };
        log(run, 'warn', 'planning', `SIMULATED FAULT: the first plan was deliberately corrupted after the Planning Agent finished (${description}). Watch the Review loop catch it.`);
        save(run);
      }
      plan = pStep.output;
      handoff(run, { from: 'planning', to: 'review', type: 'plan', schema: 'PlanOutput@1', payload: plan, summary: `plan draft ${round}: ${agents.planning.summarize(plan)}`, context_version: ctxV });

      const guardFindings = guards.checkPlan(plan, guardCtx(run), round);
      if (guardFindings.length) log(run, 'info', 'guard', `Deterministic checks found ${guardFindings.length} problem(s) in plan draft ${round} (passed to the Review Agent).`);
      const reviewInput = {
        context_version: ctxV,
        transcript_lines: run.inputs.transcript_lines,
        rules: run.inputs.rules,
        roster: run.inputs.roster,
        facts: planningInput.facts,
        issues: planningInput.issues,
        plan: annotatePlan(plan),
        guard_findings: guardFindings,
        round,
        prior_findings: feedback ? feedback.findings : [],
      };
      const { step: rStep } = await ensureStep(run, agents.review, round, reviewInput);
      reviewOut = rStep.output;
      if (reviewOut.verdict_overridden_by_policy) log(run, 'warn', 'review', `Policy override: the Review Agent said "${reviewOut.llm_verdict}" but blocker/major findings exist, so the verdict is "${reviewOut.verdict}".`);

      if (reviewOut.verdict === 'approve') {
        log(run, 'info', 'review', `Plan draft ${round} approved.`);
        break;
      }
      if (round === maxRev) {
        log(run, 'warn', 'review', `Revision limit (${maxRev}) reached with unresolved findings. Stopping and surfacing them for a human.`);
        break;
      }
      feedback = {
        round: round + 1,
        previous_plan: plan,
        findings: reviewOut.findings.map(({ id, source, severity, category, task_id, description, evidence, required_correction }) => ({ id, source, severity, category, task_id, description, evidence, required_correction })),
      };
      handoff(run, { from: 'review', to: 'planning', type: 'corrections', schema: 'Findings@1', payload: feedback.findings, summary: `${feedback.findings.length} finding(s) returned for revision ${round + 1}`, context_version: ctxV });
    }

    // Archive leftover steps from an earlier, longer run (e.g. before a correction converged sooner).
    for (const [k, s] of Object.entries(run.steps)) {
      if ((s.agent === 'planning' || s.agent === 'review') && s.round > lastRound) {
        archiveStep(run, s, 'superseded');
        delete run.steps[k];
      }
    }

    const approved = reviewOut.verdict === 'approve';
    const rounds = [];
    for (let r = 0; r <= lastRound; r += 1) {
      const p = run.steps[`planning:${r}`];
      const rv = run.steps[`review:${r}`];
      rounds.push({ round: r, plan_summary: p?.status_detail, verdict: rv?.output?.verdict, counts: rv?.output?.counts, finding_ids: (rv?.output?.findings || []).map((f) => f.id) });
    }
    run.result = {
      status: approved ? 'approved' : 'needs_human_review',
      revisions_used: lastRound,
      max_revisions: maxRev,
      rounds,
      final_plan: plan,
      final_review: reviewOut,
      unresolved_findings: reviewOut.findings,
      plan_diff: diffPlans(run.previous_result?.final_plan, plan),
      context_version: run.context.version,
      completed_at: nowIso(),
    };
    handoff(run, { from: 'review', to: 'user', type: 'final_result', schema: 'FinalResult@1', payload: { status: run.result.status, revisions_used: lastRound, unresolved: reviewOut.findings.length }, summary: approved ? `approved after ${lastRound} revision(s)` : `NOT approved after ${lastRound} revision(s): ${reviewOut.findings.length} finding(s) left for a human`, context_version: run.context.version });
  }

  async function execute(run) {
    try {
      run.stop_requested = false;
      if (run.result) {
        run.previous_result = run.result;
        run.result = null;
      }
      run.error = null;
      log(run, 'info', 'orchestrator', 'Run started (completed steps with unchanged input will be reused).');
      save(run);
      await runIntake(run);
      if (run.stop_requested) {
        run.status = 'interrupted';
        run.error = { message: 'Stopped by user request.', simulated: false, at: nowIso() };
        log(run, 'warn', 'orchestrator', 'Run stopped before the Review phase started. Finished steps are saved.');
        return;
      }
      await runReviewLoop(run);
      if (run.stop_requested) {
        run.status = 'interrupted';
        run.error = { message: 'Stopped by user request.', simulated: false, at: nowIso() };
        log(run, 'warn', 'orchestrator', 'Run stopped during the Review loop. Finished steps are saved.');
        return;
      }
      run.status = run.result.status === 'approved' ? 'completed' : 'needs_review';
      log(run, run.status === 'completed' ? 'info' : 'warn', 'orchestrator', run.status === 'completed' ? 'Run completed: plan approved by the Review Agent.' : 'Run ended: plan needs human review (see unresolved findings).');
    } catch (err) {
      if (err.stop_requested || run.stop_requested) {
        run.status = 'interrupted';
        run.error = { message: 'Stopped by user request.', simulated: false, at: nowIso() };
        log(run, 'warn', 'orchestrator', 'Run interrupted by user request. Completed steps are saved; press Resume to continue without repeating them.');
        return;
      }
      run.status = 'failed';
      run.error = { message: err.message, step: err.step || null, simulated: !!err.simulated, at: nowIso() };
      log(run, 'error', 'orchestrator', `Run stopped: ${err.message}. Completed steps are saved; press Resume to continue without repeating them.`);
    } finally {
      save(run);
    }
  }

  // ------------------------------------------------------------ public API --
  function start(run) {
    const key = runKey(run);
    if (running.has(key)) throw new ApiError(409, 'run_busy', 'This run is already executing. Wait for it to finish.');
    run.status = 'running';
    save(run);
    const p = execute(run)
      .catch((e) => console.error('Unexpected orchestrator error:', e))
      .finally(() => running.delete(key));
    running.set(key, p);
    return p;
  }

  const isRunning = (run) => running.has(runKey(run));
  const whenIdle = (run) => running.get(runKey(run)) || Promise.resolve();

  function assertIdle(run) {
    if (isRunning(run)) throw new ApiError(409, 'run_busy', 'This run is executing. Wait until it finishes before changing it.');
  }

  function stop(run) {
    run.stop_requested = true;
    run.status = 'interrupted';
    run.error = { message: 'Stopped by user request.', simulated: false, at: nowIso() };
    log(run, 'warn', 'orchestrator', 'Run stop requested. The current agent will stop once it checks the flag, and completed steps will be saved.');
    save(run);
    return run;
  }
  function assertContext(run) {
    if (!run.context) throw new ApiError(409, 'no_context', 'The Intake Agent has not produced facts yet. Resume the run first.');
  }

  function validateSource(p, { requireAll = true } = {}) {
    const lim = config.limits;
    const out = {};
    if (p.title !== undefined) {
      const t = String(p.title).trim();
      if (!t || t.length > 120) throw new ApiError(400, 'bad_title', 'Title must be 1-120 characters.');
      out.title = t;
    }
    if (p.meeting_date !== undefined) {
      const d = String(p.meeting_date || '').trim();
      if (d && !isIsoDate(d)) throw new ApiError(400, 'bad_date', 'Meeting date must be a real date in YYYY-MM-DD format (or empty).');
      out.meeting_date = d || null;
    }
    if (p.transcript !== undefined || requireAll) {
      const t = String(p.transcript ?? '');
      if (splitTranscript(t).length < 2) throw new ApiError(400, 'bad_transcript', 'The transcript needs at least 2 non-empty lines.');
      if (t.length > lim.maxTranscriptChars) throw new ApiError(400, 'transcript_too_long', `Transcript is longer than ${lim.maxTranscriptChars} characters.`);
      out.transcript = t;
    }
    if (p.rules_text !== undefined || requireAll) {
      const r = String(p.rules_text ?? '');
      if (!parseRules(r).length) throw new ApiError(400, 'bad_rules', 'Add at least one company rule (one per line).');
      if (r.length > lim.maxRulesChars) throw new ApiError(400, 'rules_too_long', `Rules are longer than ${lim.maxRulesChars} characters.`);
      out.rules_text = r;
    }
    if (p.roster_text !== undefined) {
      const r = String(p.roster_text ?? '');
      if (r.length > lim.maxRosterChars) throw new ApiError(400, 'roster_too_long', `Roster is longer than ${lim.maxRosterChars} characters.`);
      out.roster_text = r;
    }
    return out;
  }

  function armFault(run, { kind, agent }) {
    if (!FAULT_KINDS.includes(kind)) throw new ApiError(400, 'bad_fault', `Unknown fault kind. Use one of: ${FAULT_KINDS.join(', ')}.`);
    if (kind !== 'planner_violation' && !FAULT_AGENTS.includes(agent)) throw new ApiError(400, 'bad_fault', 'This fault needs an agent: intake, planning or review.');
    const f = { id: newId(3), kind, agent: kind === 'planner_violation' ? null : agent, consumed: false, armed_at: nowIso(), simulated: true };
    run.faults.push(f);
    log(run, 'warn', 'orchestrator', `SIMULATED FAULT armed: ${kind}${f.agent ? ' at ' + f.agent : ''} (demo control). It fires once on the next matching step.`);
    return f;
  }

  function createRun(sessionId, payload) {
    if (store.listRuns(sessionId).length >= config.limits.maxRunsPerSession) {
      throw new ApiError(429, 'run_limit', `This session already has ${config.limits.maxRunsPerSession} runs. Delete some or reset the session.`);
    }
    const src = validateSource({ ...payload, title: String(payload.title || '').trim() || 'Untitled run' });
    const run = {
      id: store.newRunId(),
      session_id: sessionId,
      title: src.title,
      created_at: nowIso(),
      updated_at: nowIso(),
      status: 'created',
      error: null,
      provider: { name: config.provider, models: { ...config.models }, mock: config.provider === 'mock' },
      inputs: {
        meeting_date: src.meeting_date ?? null,
        transcript_raw: src.transcript,
        transcript_lines: splitTranscript(src.transcript),
        rules_raw: src.rules_text,
        rules: parseRules(src.rules_text),
        roster_raw: src.roster_text || '',
        roster: parseRoster(src.roster_text || ''),
      },
      epochs: { intake: 0, planning: 0, review: 0 },
      faults: [],
      context: null,
      context_versions: [],
      steps: {},
      step_archive: [],
      handoffs: [],
      events: [],
      result: null,
      previous_result: null,
      usage: { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    };
    for (const f of payload.faults || []) armFault(run, f);
    log(run, 'info', 'orchestrator', `Run created with ${run.inputs.transcript_lines.length} transcript lines, ${run.inputs.rules.length} rules, ${run.inputs.roster.length} roster entries.`);
    handoff(run, { from: 'user', to: 'intake', type: 'source_input', schema: 'SourceInput@1', payload: { transcript_lines: run.inputs.transcript_lines.length, rules: run.inputs.rules.length, roster: run.inputs.roster.length, meeting_date: run.inputs.meeting_date }, summary: `transcript (${run.inputs.transcript_lines.length} lines), ${run.inputs.rules.length} rules`, context_version: 0 });
    save(run);
    return run;
  }

  /** Continue a failed/interrupted run. Finished steps are reused, not repeated. */
  function resume(run) {
    assertIdle(run);
    run.stop_requested = false;
    run.error = null;
    log(run, 'info', 'orchestrator', 'Resume requested.');
    return start(run);
  }

  /** User corrects one extracted fact -> new context version -> affected steps re-run. */
  function applyCorrection(run, { fact_id, changes, note }) {
    assertIdle(run);
    assertContext(run);
    const fact = run.context.facts.find((f) => f.id === fact_id);
    if (!fact) throw new ApiError(404, 'no_fact', `Fact ${fact_id} does not exist in the current context.`);
    if (!changes || typeof changes !== 'object') throw new ApiError(400, 'bad_changes', 'Provide the fields to change.');
    const before = {};
    const after = {};
    for (const k of Object.keys(changes)) {
      if (!FACT_EDITABLE.includes(k)) throw new ApiError(400, 'bad_field', `Field "${k}" cannot be edited. Editable: ${FACT_EDITABLE.join(', ')}.`);
      let v = changes[k];
      if (typeof v === 'string') v = v.trim();
      if (v === '') v = null;
      if (k === 'statement' && (!v || v.length > 400)) throw new ApiError(400, 'bad_statement', 'Statement must be 1-400 characters.');
      if (k === 'stated_deadline' && v !== null && !isIsoDate(v)) throw new ApiError(400, 'bad_date', 'Deadline must be a real date (YYYY-MM-DD) or empty.');
      if ((v ?? null) !== (fact[k] ?? null)) {
        before[k] = fact[k] ?? null;
        after[k] = v;
      }
    }
    if (!Object.keys(after).length) throw new ApiError(400, 'no_change', 'Nothing changed.');
    if (after.stated_deadline && !('stated_deadline_text' in after) && !fact.stated_deadline_text) after.stated_deadline_text = `user-corrected: ${after.stated_deadline}`;
    fact.original ||= Object.fromEntries(FACT_EDITABLE.map((k) => [k, fact[k] ?? null]));
    Object.assign(fact, after);
    fact.user_corrected = true;
    fact.corrected_at = nowIso();
    bumpContext(run, `Fact ${fact_id} corrected by the user`, [{ fact_id, before, after, note: note || '' }]);
    handoff(run, { from: 'user', to: 'planning', type: 'fact_correction', schema: 'FactCorrection@1', payload: { fact_id, before, after, note: note || '' }, summary: `${fact_id} corrected: ${Object.keys(after).join(', ')}` });
    return start(run);
  }

  /** User answers an open issue (missing/conflict/ambiguous) by adding a user-provided fact. */
  function applyAnswer(run, p) {
    assertIdle(run);
    assertContext(run);
    const issue = run.context.issues.find((i) => i.id === p.issue_id);
    if (!issue) throw new ApiError(404, 'no_issue', `Issue ${p.issue_id} does not exist.`);
    if (issue.status === 'resolved') throw new ApiError(409, 'already_resolved', 'This issue is already resolved.');
    const statement = String(p.statement || '').trim();
    if (!statement || statement.length > 400) throw new ApiError(400, 'bad_statement', 'Answer must be 1-400 characters.');
    const type = p.type || 'decision';
    if (!['decision', 'requirement', 'constraint'].includes(type)) throw new ApiError(400, 'bad_type', 'Type must be decision, requirement or constraint.');
    const deadline = String(p.stated_deadline || '').trim() || null;
    if (deadline && !isIsoDate(deadline)) throw new ApiError(400, 'bad_date', 'Deadline must be a real date (YYYY-MM-DD) or empty.');
    const owner = String(p.stated_owner || '').trim() || null;
    const nextId = `F${Math.max(0, ...run.context.facts.map((f) => parseInt(f.id.slice(1), 10))) + 1}`;
    const fact = { id: nextId, type, statement, source_refs: [], stated_owner: owner, stated_deadline: deadline, stated_deadline_text: deadline ? `user answer: ${deadline}` : null, origin: 'user_answer', user_corrected: false, created_at: nowIso() };
    run.context.facts.push(fact);
    issue.status = 'resolved';
    issue.resolved_by = nextId;
    issue.resolution = statement;
    bumpContext(run, `Issue ${issue.id} answered by the user (new fact ${nextId})`, [{ issue_id: issue.id, new_fact: nextId, statement }]);
    handoff(run, { from: 'user', to: 'planning', type: 'issue_answer', schema: 'IssueAnswer@1', payload: { issue_id: issue.id, fact }, summary: `${issue.id} answered as ${nextId}` });
    return start(run);
  }

  /** Edit transcript / rules / roster / date. Only steps whose INPUT changed re-run (hash check). */
  function updateSource(run, payload) {
    assertIdle(run);
    const upd = validateSource({ ...payload }, { requireAll: false });
    const changed = [];
    const inp = run.inputs;
    if (upd.meeting_date !== undefined && upd.meeting_date !== inp.meeting_date) {
      inp.meeting_date = upd.meeting_date;
      changed.push('meeting date');
    }
    if (upd.transcript !== undefined && upd.transcript !== inp.transcript_raw) {
      inp.transcript_raw = upd.transcript;
      inp.transcript_lines = splitTranscript(upd.transcript);
      changed.push('transcript');
    }
    if (upd.rules_text !== undefined && upd.rules_text !== inp.rules_raw) {
      inp.rules_raw = upd.rules_text;
      inp.rules = parseRules(upd.rules_text);
      changed.push('rules');
    }
    if (upd.roster_text !== undefined && upd.roster_text !== inp.roster_raw) {
      inp.roster_raw = upd.roster_text;
      inp.roster = parseRoster(upd.roster_text);
      changed.push('roster');
    }
    if (!changed.length) throw new ApiError(400, 'no_change', 'Nothing changed.');
    const reintake = changed.includes('transcript') || changed.includes('meeting date');
    if (reintake && run.steps.intake) run.steps.intake.status = 'stale';
    if (run.context) bumpContext(run, `Source changed: ${changed.join(', ')}`, [{ changed }]);
    else markDownstreamStale(run);
    if (reintake) log(run, 'warn', 'orchestrator', 'Transcript changed: the Intake Agent must re-extract, so earlier fact corrections/answers will be discarded.');
    handoff(run, { from: 'user', to: reintake ? 'intake' : 'planning', type: 'source_update', schema: 'SourceInput@1', payload: { changed }, summary: `source changed: ${changed.join(', ')}` });
    return start(run);
  }

  /** Force a fresh execution from a chosen agent (used by the demo tab, optionally with faults). */
  function rerun(run, { from = 'planning', faults = [] } = {}) {
    assertIdle(run);
    if (!['intake', 'planning'].includes(from)) throw new ApiError(400, 'bad_from', 'from must be intake or planning.');
    if (from === 'intake') {
      run.epochs.intake += 1;
      run.epochs.planning += 1;
      if (run.steps.intake) run.steps.intake.status = 'stale';
      log(run, 'warn', 'orchestrator', 'Re-running from the Intake Agent: corrections/answers will be discarded.');
    } else {
      run.epochs.planning += 1;
    }
    markDownstreamStale(run);
    for (const f of faults) armFault(run, f);
    return start(run);
  }

  /** Test/diagnostic hook: observe every outgoing prompt (used by the isolation self-test). */
  function onPrompt(fn) {
    promptListeners.add(fn);
    return () => promptListeners.delete(fn);
  }

  return { createRun, start, stop, resume, applyCorrection, applyAnswer, updateSource, rerun, armFault, isRunning, whenIdle, onPrompt };
}
