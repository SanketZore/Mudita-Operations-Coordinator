/**
 * Pipeline tests. They use the deterministic MOCK provider so they run offline and
 * free - the point is to verify ORCHESTRATION (handoffs, resume, staleness,
 * bounded loop, isolation), not the quality of any language model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, runSample, sample } from './helpers.js';
import { runIsolationTest } from '../server/core/isolation.js';
import { ApiError } from '../server/core/errors.js';
import { truncateTranscriptForModel } from '../server/core/text.js';
import { createLLM } from '../server/llm/index.js';
import { callGemini } from '../server/llm/gemini.js';
import { readConfig } from '../server/config.js';
import { normalizeStructuredOutput } from '../server/core/validate.js';

test('0. long transcripts are shortened before the model prompt is built', () => {
  const lines = Array.from({ length: 400 }, (_, i) => ({ line: i + 1, text: `Alice: We need to ship item ${i} and keep this line very long so the model sees a large transcript. ${'more text '.repeat(20)}` }));
  const compact = truncateTranscriptForModel(lines, 2000);
  assert.ok(compact.length < lines.map((l) => `[L${l.line}] ${l.text}`).join('\n').length);
  assert.match(compact, /\.\.\./);
  assert.match(compact, /\[L1\]/);
  assert.ok(compact.includes('more transcript lines omitted'));
});

test('0a. Gemini defaults to a Gemini-safe token limit even when Groq env values are still present', () => {
  const config = readConfig({
    LLM_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'AIza-test',
    GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta',
    GEMINI_MODEL: 'gemini-3.6-flash',
    GROQ_API_KEY: 'gsk_test',
    GROQ_BASE_URL: 'https://api.groq.com/openai/v1',
    GROQ_MODEL: 'qwen/qwen3.8-27b',
  });
  assert.equal(config.llm.maxOutputTokens, 8192);
});

test('0b. Gemini request schema strips unsupported JSON Schema keys so the API accepts it', async () => {
  let requestBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }], usageMetadata: { promptTokenCount: 1, completionTokenCount: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await callGemini({
      gemini: { apiKey: 'gemini-test-key', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
      llm: { temperature: 0.1, maxOutputTokens: 600, timeoutMs: 120000 },
    }, {
      model: 'gemini-2.0-flash',
      system: 's',
      user: 'u',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          note: { type: ['string', 'null'], description: 'optional' },
          nested: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { value: { type: 'string' } } } },
        },
      },
    });
    assert.ok(!('additionalProperties' in requestBody.generationConfig.responseSchema));
    assert.ok(!('additionalProperties' in requestBody.generationConfig.responseSchema.properties.nested.items));
    assert.equal(requestBody.generationConfig.responseSchema.properties.note.type, 'string');
    assert.equal(requestBody.generationConfig.responseSchema.properties.note.nullable, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('0b. Groq quota failure falls back to Gemini automatically', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const bodyText = String(init?.body || '');
    if (String(url).includes('/chat/completions')) {
      return new Response(JSON.stringify({ error: { message: 'Request too large for model `qwen/qwen3.8-27b` ... Limit 1000, Requested 1646.' } }), { status: 429, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).includes(':generateContent')) {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }], usageMetadata: { promptTokenCount: 5, completionTokenCount: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected URL: ${url} body=${bodyText}`);
  };
  try {
    const config = {
      provider: 'grok',
      models: { intake: 'qwen/qwen3.8-27b', planning: 'qwen/qwen3.8-27b', review: 'qwen/qwen3.8-27b' },
      grok: { apiKey: 'gsk_test', baseUrl: 'https://api.groq.com/openai/v1', tokenParam: 'max_tokens', endpointName: 'Groq', reasoningEffort: '' },
      gemini: { apiKey: 'AQ.testkey', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash' },
      llm: { temperature: 0.1, maxOutputTokens: 600, timeoutMs: 120000, maxRetries: 1, retryBaseDelayMs: 200, maxSchemaRepairs: 1, maxConcurrentCalls: 1 },
    };
    const llm = createLLM(config);
    const res = await llm.call({ agent: 'intake', system: 's', user: 'u', input: {}, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, toolName: 'submit_intake_result', toolDescription: 'x' });
    assert.equal(res.data.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('0c. LLM enum drift is normalized before validation so review verdict/category values stay schema-safe', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'findings', 'checks_performed'],
    properties: {
      verdict: { enum: ['approve', 'revise'] },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['severity', 'category', 'task_id', 'description', 'evidence', 'rule_ids', 'fact_ids', 'required_correction'],
          properties: {
            severity: { enum: ['blocker', 'major', 'minor'] },
            category: { enum: ['rule_violation', 'unsupported_claim', 'invented_owner', 'invented_deadline', 'dependency', 'missing_coverage', 'other'] },
            task_id: { type: ['string', 'null'] },
            description: { type: 'string' },
            evidence: { type: 'string' },
            rule_ids: { type: 'array', items: { type: 'string' } },
            fact_ids: { type: 'array', items: { type: 'string' } },
            required_correction: { type: 'string' },
          },
        },
      },
      checks_performed: { type: 'array', items: { type: 'string' } },
    },
  };

  const input = {
    verdict: 'APPROVE',
    findings: [{
      severity: 'BLOCKER',
      category: 'invented-owner',
      task_id: '',
      description: 'Task owner was invented',
      evidence: 'The transcript never names that owner.',
      rule_ids: [],
      fact_ids: [],
      required_correction: 'Set owner to null and ask the user',
    }],
    checks_performed: ['verified the transcript'],
  };

  const normalized = normalizeStructuredOutput(schema, input);
  assert.equal(normalized.verdict, 'approve');
  assert.equal(normalized.findings[0].severity, 'blocker');
  assert.equal(normalized.findings[0].category, 'invented_owner');
  assert.equal(normalized.findings[0].task_id, null);
});

test('1. complete three-agent run: all agents run, handoffs are validated, plan approved', async () => {
  const t = makeApp();
  const { run } = await runSample(t);
  assert.equal(run.status, 'completed', JSON.stringify(run.error));
  assert.equal(run.result.status, 'approved');
  for (const k of ['intake', 'planning:0', 'review:0']) assert.equal(run.steps[k].status, 'succeeded', k);
  assert.equal(t.calls.total, 3);
  const kinds = run.handoffs.map((h) => `${h.from}>${h.to}:${h.type}`);
  for (const k of ['user>intake:source_input', 'intake>planning:facts_and_issues', 'planning>review:plan', 'review>user:final_result']) assert.ok(kinds.includes(k), k);
  assert.ok(run.handoffs.every((h) => h.validation.ok));
  assert.ok(run.context.issues.some((i) => i.kind === 'conflict'), 'conflicting code-freeze dates flagged');
  assert.ok(run.result.final_plan.unresolved_questions.length >= 2);
  t.cleanup();
});

test('2. SIMULATED rule violation is caught, sent back, corrected and re-checked', async () => {
  const t = makeApp();
  const { run } = await runSample(t, { faults: [{ kind: 'planner_violation' }] });
  assert.equal(run.status, 'completed', JSON.stringify(run.error));
  assert.ok(run.steps['planning:0'].simulated_fault, 'first plan flagged as simulated fault');
  assert.equal(run.steps['review:0'].output.verdict, 'revise');
  assert.ok(run.steps['review:0'].output.findings.some((f) => f.category === 'invented_owner' && f.source === 'guard'));
  assert.equal(run.steps['review:1'].output.verdict, 'approve');
  assert.equal(run.result.revisions_used, 1);
  assert.ok(run.handoffs.some((h) => h.type === 'corrections' && h.from === 'review' && h.to === 'planning'));
  assert.ok(run.steps['planning:1'].output.addressed_findings.length > 0);
  t.cleanup();
});

test('3. review loop is bounded and unresolved issues are surfaced', async () => {
  // A stubborn planner that re-introduces the same violation on every draft.
  const t = makeApp({ REVIEW_MAX_REVISIONS: '2' }, async (base, req) => {
    const res = await base.call(req);
    if (req.agent === 'planning') {
      const p = structuredClone(res.data);
      p.tasks[0].owner = 'Jordan Blake';
      p.tasks[0].owner_basis = 'stated_in_source';
      p.tasks[0].fact_ids = [];
      return { ...res, data: p };
    }
    return res;
  });
  const { run } = await runSample(t);
  assert.equal(run.status, 'needs_review');
  assert.equal(run.result.status, 'needs_human_review');
  assert.equal(run.result.revisions_used, 2);
  assert.ok(run.steps['planning:2'] && !run.steps['planning:3']);
  assert.ok(run.result.unresolved_findings.length > 0);
  assert.equal(t.calls.planning, 3);
  t.cleanup();
});

test('4. a corrected source fact propagates: version bump, stale marking, only affected steps re-run, plan diff', async () => {
  const t = makeApp();
  const { run } = await runSample(t);
  const before = { ...t.calls };
  const dana = run.context.facts.find((f) => f.stated_owner === 'Dana Okafor');
  assert.equal(dana.stated_deadline, '2026-09-21');

  const p = t.orchestrator.applyCorrection(run, { fact_id: dana.id, changes: { stated_deadline: '2026-09-24' }, note: 'Dana moved it' });
  // immediately after the correction the old plan/review are stale, never reused
  assert.equal(run.context.version, 2);
  assert.equal(run.steps['planning:0'].status, 'stale');
  await p;

  assert.equal(run.status, 'completed', JSON.stringify(run.error));
  assert.equal(t.calls.intake, before.intake, 'Intake is NOT re-run for a fact correction');
  assert.equal(t.calls.planning, before.planning + 1);
  assert.equal(t.calls.review, before.review + 1);
  assert.equal(run.steps['planning:0'].context_version, 2);
  assert.ok(run.step_archive.some((s) => s.key === 'planning:0' && s.status === 'superseded'));
  const changed = run.result.plan_diff.changed.find((c) => c.changes.some((x) => x.field === 'deadline'));
  assert.ok(changed, 'plan diff shows the deadline change');
  assert.equal(changed.changes.find((x) => x.field === 'deadline').to, '2026-09-24');
  assert.equal(run.context_versions.length, 2);
  t.cleanup();
});

test('5. recovery after a SIMULATED model failure: completed work is reused, not repeated', async () => {
  const t = makeApp();
  const { run } = await runSample(t, { faults: [{ kind: 'model_error', agent: 'planning' }] });
  assert.equal(run.status, 'failed');
  assert.equal(run.error.simulated, true);
  assert.equal(run.error.step, 'planning:0');
  assert.equal(run.steps.intake.status, 'succeeded');
  assert.equal(t.calls.intake, 1);
  assert.equal(t.calls.planning, 0, 'the simulated failure fires before any model call');

  await t.orchestrator.resume(run);
  assert.equal(run.status, 'completed', JSON.stringify(run.error));
  assert.equal(t.calls.intake, 1, 'Intake was not repeated after resume');
  assert.equal(run.steps.intake.reuse_count, 1);
  assert.ok(run.step_archive.some((s) => s.key === 'planning:0' && s.status === 'failed' && s.error.simulated));
  t.cleanup();
});

test('6. malformed model output is rejected by schema validation and repaired (bounded)', async () => {
  const t = makeApp();
  const { run } = await runSample(t, { faults: [{ kind: 'invalid_output', agent: 'intake' }] });
  assert.equal(run.status, 'completed', JSON.stringify(run.error));
  assert.equal(run.steps.intake.repairs, 1);
  assert.ok(run.handoffs.some((h) => h.type === 'validation_feedback' && h.to === 'intake' && !h.validation.ok));
  assert.equal(t.calls.intake, 1, 'one real repair call after the simulated malformed answer');
  t.cleanup();
});

test('7. ungrounded facts (fake quote / invented owner) never reach the Planning Agent', async () => {
  const t = makeApp({}, async (base, req) => {
    const res = await base.call(req);
    if (req.agent !== 'intake') return res;
    const d = structuredClone(res.data);
    d.facts.push({ id: `F${d.facts.length + 1}`, type: 'requirement', statement: 'Zed will ship it', source_refs: [{ line: 2, quote: 'Zed promised to ship everything tomorrow' }], stated_owner: 'Zed Nobody', stated_deadline: null, stated_deadline_text: null });
    return { ...res, data: d };
  });
  const { run } = await runSample(t);
  assert.equal(run.status, 'completed', JSON.stringify(run.error));
  assert.equal(run.context.dropped_facts.length, 1);
  assert.match(run.context.dropped_facts[0].reasons.join(' '), /verbatim|invented/);
  assert.ok(!run.context.facts.some((f) => f.stated_owner === 'Zed Nobody'));
  assert.ok(!JSON.stringify(run.steps['planning:0'].input_preview).includes('Zed'));
  t.cleanup();
});

test('8. rules-only change re-runs Planning/Review but reuses Intake', async () => {
  const t = makeApp();
  const { run } = await runSample(t, { name: 'weekly_sync' });
  const intakeCalls = t.calls.intake;
  await t.orchestrator.updateSource(run, { rules_text: sample('weekly_sync').rules_text + '\nR5: Extra rule added later.' });
  assert.equal(t.calls.intake, intakeCalls);
  assert.equal(run.status, 'completed');
  assert.ok(run.inputs.rules.some((r) => r.id === 'R5'));
  assert.equal(run.context.version, 2);
  t.cleanup();
});

test('9. answering an open issue adds a user fact, resolves the issue and re-plans', async () => {
  const t = makeApp();
  const { run } = await runSample(t, { name: 'weekly_sync' });
  const issue = run.context.issues.find((i) => i.kind === 'missing');
  assert.ok(issue);
  await t.orchestrator.applyAnswer(run, { issue_id: issue.id, statement: 'Chloe Diaz will update the vendor contract', type: 'decision', stated_owner: 'Chloe Diaz', stated_deadline: '2026-09-25' });
  assert.equal(run.status, 'completed', JSON.stringify(run.error));
  assert.equal(run.context.issues.find((i) => i.id === issue.id).status, 'resolved');
  assert.ok(run.context.facts.some((f) => f.origin === 'user_answer' && f.stated_owner === 'Chloe Diaz'));
  assert.ok(!run.result.final_plan.unresolved_questions.some((q) => q.related_issue_ids.includes(issue.id)));
  t.cleanup();
});

test('10. a run cannot be started twice concurrently (no duplicate work)', async () => {
  const t = makeApp();
  const session = t.store.createSession();
  const run = t.orchestrator.createRun(session, sample('weekly_sync'));
  const p = t.orchestrator.start(run);
  assert.throws(() => t.orchestrator.start(run), (e) => e instanceof ApiError && e.status === 409);
  assert.throws(() => t.orchestrator.applyCorrection(run, { fact_id: 'F1', changes: { statement: 'x' } }), (e) => e instanceof ApiError && e.status === 409);
  await p;
  t.cleanup();
});

test('11. resuming a completed run makes no model calls at all', async () => {
  const t = makeApp();
  const { run } = await runSample(t, { name: 'weekly_sync' });
  const total = t.calls.total;
  await t.orchestrator.resume(run);
  assert.equal(t.calls.total, total);
  assert.equal(run.status, 'completed');
  t.cleanup();
});

test('12. user can stop a running run and resume it later', async () => {
  const t = makeApp({}, async (base, req) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return base.call(req);
  });
  const session = t.store.createSession();
  const run = t.orchestrator.createRun(session, sample('weekly_sync'));
  const p = t.orchestrator.start(run);
  await new Promise((resolve) => setTimeout(resolve, 20));
  t.orchestrator.stop(run);
  await p;
  assert.equal(run.status, 'interrupted');
  assert.match(run.error.message, /Stopped by user request|stopped by user|Stop/);
  await t.orchestrator.resume(run);
  assert.equal(run.status, 'completed', JSON.stringify(run.error));
  t.cleanup();
});

test('13. crash recovery: a run left "running" becomes "interrupted" and can be resumed', async () => {
  const t = makeApp();
  const { run, session } = await runSample(t, { name: 'weekly_sync', faults: [{ kind: 'model_error', agent: 'review' }] });
  assert.equal(run.status, 'failed');
  // simulate a hard crash: persisted state says running with a running step
  run.status = 'running';
  run.steps['review:0'].status = 'running';
  t.store.saveRun(run);
  assert.equal(t.store.recoverInterrupted(), 1);
  assert.equal(run.status, 'interrupted');
  await t.orchestrator.resume(run);
  assert.equal(run.status, 'completed', JSON.stringify(run.error));
  assert.equal(t.calls.intake, 1);
  void session;
  t.cleanup();
});

test('14. session isolation self-test passes (prompts, store lookups, persisted data)', async () => {
  const t = makeApp();
  const report = await runIsolationTest({ store: t.store, orchestrator: t.orchestrator });
  assert.ok(report.ok, JSON.stringify(report.checks, null, 2));
  assert.equal(report.checks.length, 4);
  t.cleanup();
});

test('15. validation of inputs: bad dates, empty rules, tiny transcript', async () => {
  const t = makeApp();
  const s = t.store.createSession();
  assert.throws(() => t.orchestrator.createRun(s, { ...sample('weekly_sync'), meeting_date: '2026-13-40' }), (e) => e.code === 'bad_date');
  assert.throws(() => t.orchestrator.createRun(s, { ...sample('weekly_sync'), rules_text: '# only comments' }), (e) => e.code === 'bad_rules');
  assert.throws(() => t.orchestrator.createRun(s, { ...sample('weekly_sync'), transcript: 'one line' }), (e) => e.code === 'bad_transcript');
  t.cleanup();
});
