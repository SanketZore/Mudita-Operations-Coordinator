/**
 * App controller: owns state, talks to the API, re-renders on change.
 * Rendering is done by views.js. While a run is executing we poll it, so the
 * relay updates live (statuses, handoffs, feedback) without a page reload.
 */
import { api, ApiFailure } from './api.js';
import { esc, usd, shiftToWeekday } from './util.js';
import * as V from './views.js';

const $ = (id) => document.getElementById(id);
const state = { health: null, samples: [], sampleId: null, runs: [], runId: null, run: null, tab: 'plan', ui: { step: null, lines: [], editing: null, answering: null, editSource: false, isolation: null } };
let timer = null;
let lastStamp = '';

/* ------------------------------------------------------------- feedback -- */
function toast(msg, err = false) {
  const el = document.createElement('div');
  el.textContent = msg;
  if (err) el.className = 'err';
  $('toast').appendChild(el);
  setTimeout(() => el.remove(), err ? 7000 : 3500);
}
async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiFailure && e.code === 'access_required') return renderGate();
    toast(e.message, true);
    return null;
  }
}

/* --------------------------------------------------------------- render -- */
function renderChrome() {
  const h = state.health;
  $('banner').innerHTML = h?.mock
    ? '<div class="mock"><b>MOCK provider.</b> Deterministic heuristics stand in for the language model, so these results are not real agent output. Set LLM_PROVIDER and an API key in .env for the real agents.</div>'
    : h && !h.llm_ready ? `<div class="warn"><b>Model not configured.</b> ${esc(h.llm_reason)}</div>` : '';
  const r = state.run;
  $('topinfo').innerHTML = h ? `<span>Provider <b>${esc(h.provider)}</b></span><span>Models <b>${esc([...new Set(Object.values(h.models))].join(', '))}</b></span>${r ? `<span>This run <b>${usd(r.usage.cost_usd)}</b></span>` : ''}` : '';
}

function renderRail() {
  const keep = document.querySelector('#rail details[open]') ? [...document.querySelectorAll('#rail details')].map((d) => d.open) : null;
  const scratch = ['f-title', 'f-date', 'f-transcript', 'f-rules', 'f-roster'].map((id) => [id, $(id)?.value]);
  $('rail').innerHTML = V.railNew(state) + V.railRuns(state);
  if (keep) document.querySelectorAll('#rail details').forEach((d, i) => { d.open = !!keep[i]; });
  // keep edits typed by the user across re-renders (only when the sample did not change)
  if (!state.sampleChanged) for (const [id, v] of scratch) if (v !== undefined && $(id)) $(id).value = v;
  state.sampleChanged = false;
}

function renderMain() {
  const run = state.run;
  if (!run) {
    $('main').innerHTML = V.idleRelay();
    return;
  }
  const tabBody = { plan: () => V.planTab(run, state.ui), collab: () => V.collabTab(run, state.ui), facts: () => V.factsTab(run, state.ui), source: () => V.sourceTab(run, state.ui), log: () => V.logTab(run), demo: () => V.demoTab(run, state.ui, state.health) }[state.tab]();
  $('main').innerHTML = V.runHeader(run) + V.relay(run, state.ui.step) + V.loopBar(run) + V.guardBar(run) + V.tabs(state.tab) + `<div id="tabbody">${tabBody}</div>`;
}

function renderGate() {
  $('main').innerHTML = `<div class="panel gate stack"><h2>Enter the access code</h2><p class="muted">This demo is protected so model usage stays under control.</p><label>Access code<input id="gate-code" type="password" autocomplete="off"></label><button class="btn" data-action="gate">Continue</button></div>`;
  $('rail').innerHTML = '';
}

const renderAll = () => { renderChrome(); renderRail(); renderMain(); };

/* -------------------------------------------------------------- loading -- */
async function refreshRuns() {
  state.runs = (await api.runs()) || [];
}
async function loadRun(id, { quiet = false } = {}) {
  const run = await api.run(id);
  const stamp = `${run.updated_at}|${run.is_running}|${run.status}`;
  state.runId = id;
  state.run = run;
  if (!state.ui.step || !run.steps[state.ui.step]) state.ui.step = Object.keys(run.steps).find((k) => run.steps[k].status === 'failed') || Object.keys(run.steps).pop() || null;
  if (stamp !== lastStamp || !quiet) {
    lastStamp = stamp;
    const keepFocus = document.activeElement?.closest?.('#main .editform');
    if (!keepFocus) renderMain();
    renderChrome();
  }
  schedulePoll(run);
  return run;
}
function schedulePoll(run) {
  clearTimeout(timer);
  if (!run?.is_running) {
    refreshRuns().then(renderRail).catch(() => {});
    return;
  }
  timer = setTimeout(() => loadRun(run.id, { quiet: true }).catch((e) => toast(e.message, true)), 700);
}
async function afterMutation(run) {
  state.run = run;
  state.runId = run.id;
  lastStamp = '';
  state.ui.editing = null;
  state.ui.answering = null;
  await refreshRuns();
  renderAll();
  schedulePoll(run);
}

/* --------------------------------------------------------------- actions -- */
function sourceFromForm() {
  return { title: $('f-title').value, meeting_date: $('f-date').value || null, transcript: $('f-transcript').value, rules_text: $('f-rules').value, roster_text: $('f-roster').value };
}
async function startRun(extraFaults = [], extra = {}) {
  const payload = { ...sourceFromForm(), ...extra };
  const faults = [...extraFaults];
  if ($('x-violation')?.checked) faults.push({ kind: 'planner_violation' });
  if ($('x-fail')?.checked) faults.push({ kind: 'model_error', agent: $('x-fail-agent').value });
  const run = await guard(() => api.createRun({ ...payload, faults }));
  if (run) { state.tab = 'plan'; state.ui.step = null; await afterMutation(run); }
}
function selectSample(id) {
  const s = state.samples.find((x) => x.id === id);
  if (!s) return;
  state.sampleId = id;
  state.sampleChanged = true;
  renderRail();
}

const actions = {
  async start() { await startRun(); },
  'open-run': async (el) => { state.ui = { ...state.ui, step: null, lines: [], editing: null, answering: null, editSource: false }; await guard(async () => { await loadRun(el.dataset.id); renderAll(); }); },
  tab: (el) => { state.tab = el.dataset.tab; state.ui.editSource = false; renderMain(); },
  'pick-step': (el) => { state.ui.step = el.dataset.key; state.tab = 'collab'; renderMain(); },
  'show-line': (el) => {
    state.ui.lines = [Number(el.dataset.line)];
    state.tab = 'source';
    renderMain();
    document.getElementById(`line-${el.dataset.line}`)?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  },
  'stop-run': async () => { const r = await guard(() => api.stop(state.runId)); if (r) afterMutation(r); },
  resume: async () => { const r = await guard(() => api.resume(state.runId)); if (r) afterMutation(r); },
  'delete-run': async () => {
    if (!confirm('Delete this run and everything it produced?')) return;
    if (await guard(() => api.deleteRun(state.runId))) { state.run = null; state.runId = null; await refreshRuns(); renderAll(); }
  },
  reset: async () => {
    if (!confirm('Delete ALL runs in this workspace? This cannot be undone.')) return;
    if (await guard(() => api.reset())) { state.run = null; state.runId = null; await refreshRuns(); renderAll(); toast('Workspace cleared.'); }
  },
  'edit-fact': (el) => { state.ui.editing = el.dataset.fact; renderMain(); },
  'cancel-edit': () => { state.ui.editing = null; renderMain(); },
  'save-fact': async (el) => {
    const f = el.closest('[data-form]');
    const q = (n) => f.querySelector(`[name=${n}]`).value;
    const changes = { statement: q('statement'), stated_owner: q('stated_owner'), stated_deadline: q('stated_deadline') };
    const r = await guard(() => api.correct(state.runId, { fact_id: f.dataset.fact, changes, note: q('note') }));
    if (r) { state.tab = 'collab'; afterMutation(r); toast('Fact corrected. Only the affected steps are re-running.'); }
  },
  'answer-open': (el) => { state.ui.answering = el.dataset.issue; renderMain(); },
  'answer-cancel': () => { state.ui.answering = null; renderMain(); },
  'answer-save': async (el) => {
    const f = el.closest('[data-form]');
    const q = (n) => f.querySelector(`[name=${n}]`).value;
    const r = await guard(() => api.answer(state.runId, { issue_id: f.dataset.issue, statement: q('statement'), stated_owner: q('stated_owner'), stated_deadline: q('stated_deadline') }));
    if (r) { state.tab = 'collab'; afterMutation(r); }
  },
  'edit-source': () => { state.ui.editSource = true; renderMain(); },
  'cancel-source': () => { state.ui.editSource = false; renderMain(); },
  'save-source': async (el) => {
    const f = el.closest('[data-form]');
    const q = (n) => f.querySelector(`[name=${n}]`).value;
    const r = await guard(() => api.source(state.runId, { meeting_date: q('meeting_date') || null, transcript: q('transcript'), rules_text: q('rules_text'), roster_text: q('roster_text') }));
    if (r) { state.ui.editSource = false; state.tab = 'collab'; afterMutation(r); }
  },
  gate: async () => { if (await guard(() => api.access($('gate-code').value))) init(); },

  /* ---- demo cases ---- */
  'demo-complete': async () => { selectBeacon(); await startRun([], {}); },
  'demo-violation': async () => { selectBeacon(); await startRun([{ kind: 'planner_violation' }], {}); },
  'demo-failure': async () => { selectBeacon(); await startRun([{ kind: 'model_error', agent: 'planning' }], {}); },
  'demo-change': async () => {
    const f = state.run.context.facts.find((x) => x.stated_deadline && x.stated_owner) || state.run.context.facts.find((x) => x.stated_deadline);
    if (!f) return toast('No fact with a deadline to change.', true);
    const to = shiftToWeekday(f.stated_deadline, 3);
    const r = await guard(() => api.correct(state.runId, { fact_id: f.id, changes: { stated_deadline: to }, note: 'Demo: deadline moved' }));
    if (r) { state.tab = 'collab'; afterMutation(r); toast(`${f.id} moved to ${to}. Watch which steps re-run.`); }
  },
  'demo-rerun': async () => {
    const kind = $('rr-kind').value;
    const fault = kind === 'planner_violation' ? { kind } : { kind, agent: $('rr-agent').value };
    const r = await guard(() => api.rerun(state.runId, { from: $('rr-from').value, faults: [fault] }));
    if (r) { state.tab = 'collab'; afterMutation(r); }
  },
  'demo-isolation': async () => {
    state.ui.isolation = { status: 'running' };
    renderMain();
    const job = await guard(() => api.startIsolation());
    if (!job) { state.ui.isolation = null; return renderMain(); }
    const poll = async () => {
      const j = await guard(() => api.isolationJob(job.id));
      if (!j) return;
      if (j.status === 'running') return setTimeout(poll, 800);
      state.ui.isolation = { status: j.status, report: j.report, error: j.error };
      if (state.tab === 'demo') renderMain();
    };
    poll();
  },
};

function selectBeacon() {
  const b = state.samples.find((s) => s.id === 'beacon_launch') || state.samples[0];
  if (b && state.sampleId !== b.id) { state.sampleId = b.id; state.sampleChanged = true; renderRail(); }
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el && actions[el.dataset.action]) actions[el.dataset.action](el);
});
document.addEventListener('change', (e) => { if (e.target.name === 'sample') selectSample(e.target.value); });

/* ----------------------------------------------------------------- init -- */
async function init() {
  try {
    state.health = await api.health();
    if (state.health.access_required && !state.health.authorized) { renderChrome(); return renderGate(); }
    state.samples = (await api.samples()) || [];
    state.sampleId ||= state.samples[0]?.id;
    await refreshRuns();
    state.sampleChanged = true;
    renderAll();
    // reopen a run that is still executing (e.g. after a page refresh)
    const live = state.runs.find((r) => r.is_running) || state.runs[0];
    if (live) { await loadRun(live.id); renderAll(); }
  } catch (e) {
    $('main').innerHTML = `<div class="panel"><h3>Cannot load the app</h3><p>${esc(e.message)}</p></div>`;
  }
}
init();
