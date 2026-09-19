import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlanPdfHtml } from '../public/js/pdf.js';

test('buildPlanPdfHtml includes the approved plan details in a print-friendly layout', () => {
  const run = {
    title: 'Beacon launch plan',
    created_at: '2026-09-19T09:00:00Z',
    provider: { name: 'mock', mock: true },
    result: {
      status: 'approved',
      final_plan: {
        summary: 'Ship the launch checklist and prepare a handoff.',
        tasks: [
          { id: 'T-1', title: 'Prepare launch checklist', owner: 'Dana', deadline: '2026-09-21', description: 'Create the final launch checklist', rationale: 'Needed before launch', kind: 'supported', fact_ids: ['F-1'], rule_ids: ['R-1'] },
          { id: 'T-2', title: 'Confirm ownership', owner: 'Maya', deadline: null, description: 'Confirm the owner', rationale: 'Required for clarity', kind: 'recommended', fact_ids: [], rule_ids: ['R-2'] },
        ],
        unresolved_questions: [{ question: 'Who owns QA signoff?', why_it_matters: 'Needed for handoff.' }],
        recommendations: [{ text: 'Escalate risk early', rationale: 'This reduces surprises', fact_ids: [], rule_ids: [] }],
      },
    },
  };

  const html = buildPlanPdfHtml(run);
  assert.match(html, /Beacon launch plan/);
  assert.match(html, /Ship the launch checklist and prepare a handoff\./);
  assert.match(html, /Prepare launch checklist/);
  assert.match(html, /Who owns QA signoff\?/);
  assert.match(html, /Approved plan/);
  assert.match(html, /<html/);
});
