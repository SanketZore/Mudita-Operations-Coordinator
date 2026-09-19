# Project explanation

## What problem this solves
After a meeting, someone has to turn a messy conversation into tasks with owners, deadlines and dependencies, without inventing anything and without breaking company rules. A single chatbot does this badly: it blends what was said with what it guesses. This project splits the job into three agents with different responsibilities, connects them through a shared, versioned context, and adds deterministic checks that do not depend on model behaviour.

## Why three agents (and not one chatbot with three labels)
Each agent has its own system prompt, input schema, output schema and model setting (`INTAKE_MODEL`, `PLANNING_MODEL`, `REVIEW_MODEL`), and each can fail, be retried and be reused independently. They only communicate through validated handoff envelopes, never by sharing a prompt. The Review Agent receives the original transcript and rules, not the Planning Agent's reasoning, so it audits rather than agrees.

## The collaboration loop
1. Intake reads numbered transcript lines and returns facts and issues.
2. Code checks drop any fact whose quote, owner or date cannot be found in the cited line.
3. Planning turns facts + rules into a plan, separating supported tasks from recommendations and open questions.
4. Code checks audit the plan (invented owners/dates, off-roster owners, weekend dates, cycles, unmet open issues).
5. Review reads the plan plus those findings and returns its own findings. Code merges both and **recomputes the verdict**: any blocker or major finding forces "revise", whatever the model said.
6. Findings go back to Planning, which must answer each one as fixed or disputed. Review rechecks. After `REVIEW_MAX_REVISIONS` rounds the loop stops and the remaining problems are shown to a human.

## Why the design is reliable
- **Never trust, always verify.** Prompts ask for grounding; code independently verifies it. If they disagree, code wins.
- **Untrusted input.** Transcript, rules and user answers are passed as data, and the agents are told to record embedded instructions as issues. The sample's "SYSTEM OVERRIDE" line demonstrates it.
- **Idempotent, hash-keyed steps.** Resume and partial re-runs need no special code: an unchanged step is simply reused.
- **Versioned context.** A correction creates version N+1 and marks old plans stale, so an old plan can never be shown as current.
- **Failures are visible.** Retryable errors back off and retry; configuration errors stop immediately with an explicit message; simulated faults are hatched and labelled everywhere.

## How the evaluation criteria map to the code
| Criterion | Where |
|---|---|
| Working workflows and real integrations | `server/llm/grok.js` (forced structured tool output), `orchestrator.js` |
| Reliability, grounding, safety | `guards.js`, `review.js` (`finalize`), `store.js` (isolation, crash recovery), `routes.js` (access gate, rate limits, headers) |
| UI clarity and usability | `public/`: relay view, plan with solid/dashed/dotted basis labels, feedback threads, handoff ledger, fact correction, demo cases |
| Code quality and explanation | Comments in every module, 28 tests, this file and `README.md` |

## Editing configuration
Everything is in `.env`. Choose the provider and key, optionally set per-agent models (a stronger model for Review gives sharper audits), adjust the price variables so the cost display matches your model, and set `DEMO_ACCESS_CODE` before sharing a public URL.

## Suggested Loom walkthrough (8-12 minutes)
1. Start the Beacon sample and narrate the relay as it runs (2 min).
2. Open the Plan tab: solid vs dashed vs dotted labels, open questions, the ignored injection line (2 min).
3. Run the simulated rule violation and show the finding, the correction and the recheck (2 min).
4. Correct a fact and show Intake reused, Planning/Review re-run and the plan diff (2 min).
5. Simulated model failure, then Resume (1 min).
6. Isolation test and the private-window check; show `.env`, the tests and the cost figure (2 min).
