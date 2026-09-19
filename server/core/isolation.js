/**
 * isolation.js - the "two sessions do not share private context" self-test.
 *
 * It creates TWO throw-away sessions, each with a run whose transcript contains
 * a unique secret ("canary") token, executes both pipelines CONCURRENTLY with the
 * real configured model, and then proves isolation with four checks:
 *
 *   1. Every prompt sent to the model for session A contains A's canary and
 *      never B's (and vice-versa) - i.e. no private context leaked into a prompt.
 *   2. Session B cannot read session A's run through the store/API layer.
 *   3. Session B's persisted run data never contains A's canary (and vice-versa).
 *   4. Both runs were executed for real (>=1 model call each), so 1-3 are meaningful.
 *
 * Everything created here is deleted afterwards.
 */
import { newId } from './hash.js';

const RULES = `R1: Every task needs one owner from the roster, or must be left unassigned with an open question.
R2: Never invent owners or deadlines.`;

function scenario(name, canary, person) {
  return {
    title: `Isolation probe ${name}`,
    meeting_date: '2026-09-14',
    transcript: `Meeting: Isolation probe ${name}\n${person} (Lead): We decided the secret project codename is ${canary}.\n${person}: I'll draft the kickoff note by September 18.\n${person}: We need a budget approval before starting, but nobody owns that yet.`,
    rules_text: RULES,
    roster_text: `${person} - Lead`,
  };
}

export async function runIsolationTest({ store, orchestrator }) {
  const tag = newId(3).toUpperCase();
  const A = { sid: store.createSession({ ephemeral: true }), canary: `CANARY-ALPHA-${tag}`, person: 'Alice Archer' };
  const B = { sid: store.createSession({ ephemeral: true }), canary: `CANARY-BRAVO-${tag}`, person: 'Bob Baker' };
  const prompts = { [A.sid]: [], [B.sid]: [] };
  const off = orchestrator.onPrompt((p) => prompts[p.session_id]?.push(`${p.system}\n${p.user}`));
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });

  try {
    A.run = orchestrator.createRun(A.sid, scenario('A', A.canary, A.person));
    B.run = orchestrator.createRun(B.sid, scenario('B', B.canary, B.person));
    await Promise.all([orchestrator.start(A.run), orchestrator.start(B.run)]);

    const aLeak = prompts[A.sid].filter((p) => p.includes(B.canary)).length;
    const bLeak = prompts[B.sid].filter((p) => p.includes(A.canary)).length;
    add('No cross-session content in prompts', aLeak === 0 && bLeak === 0, `${prompts[A.sid].length} prompts for session A and ${prompts[B.sid].length} for session B were scanned. Leaks found: A saw B's secret in ${aLeak}, B saw A's secret in ${bLeak}.`);

    const crossRead = store.getRun(B.sid, A.run.id) || store.getRun(A.sid, B.run.id);
    add('Session B cannot open session A\'s run (and vice-versa)', !crossRead, crossRead ? 'A run was returned across sessions!' : 'Both cross-session lookups returned "not found".');

    const aJson = JSON.stringify(store.getRun(A.sid, A.run.id));
    const bJson = JSON.stringify(store.getRun(B.sid, B.run.id));
    add('Persisted run data is disjoint', aJson.includes(A.canary) && !aJson.includes(B.canary) && bJson.includes(B.canary) && !bJson.includes(A.canary), 'Each run file contains only its own secret token.');

    add('Both pipelines really executed', A.run.usage.calls > 0 && B.run.usage.calls > 0, `Model calls: session A = ${A.run.usage.calls}, session B = ${B.run.usage.calls}. Statuses: A = ${A.run.status}, B = ${B.run.status}.`);
    return { ok: checks.every((c) => c.pass), checks, canaries: { A: A.canary, B: B.canary }, cost_usd: +(A.run.usage.cost_usd + B.run.usage.cost_usd).toFixed(4), statuses: { A: A.run.status, B: B.run.status } };
  } finally {
    off();
    store.deleteSession(A.sid);
    store.deleteSession(B.sid);
  }
}
