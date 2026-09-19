/**
 * schemas.js - the contracts between agents.
 *
 * Each agent has an INPUT schema (what the orchestrator may hand it) and an
 * OUTPUT schema (what it may hand back). Outputs are strict (no unknown keys)
 * because they are also sent to the model as the forced tool schema.
 * Inputs are lenient about extra keys but strict about required structure.
 *
 * Version tags (e.g. IntakeOutput@1) appear on every persisted handoff message.
 */

const str = { type: 'string' };
const nullableStr = { type: ['string', 'null'] };
const isoDateOrNull = { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const strArray = { type: 'array', items: str };

export const sourceRef = {
  type: 'object',
  additionalProperties: false,
  required: ['line', 'quote'],
  properties: {
    line: { type: 'integer', minimum: 1, description: 'Transcript line number as shown in [L#]' },
    quote: { type: 'string', minLength: 1, maxLength: 300, description: 'Verbatim excerpt copied from that line' },
  },
};

// ---------------------------------------------------------------- Intake ----
export const IntakeOutput = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'facts', 'issues'],
  properties: {
    summary: { type: 'string', maxLength: 600 },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'type', 'statement', 'source_refs', 'stated_owner', 'stated_deadline', 'stated_deadline_text'],
        properties: {
          id: { type: 'string', pattern: '^F\\d+$' },
          type: { enum: ['decision', 'requirement', 'constraint'] },
          statement: { type: 'string', minLength: 3, maxLength: 400 },
          source_refs: { type: 'array', minItems: 1, items: sourceRef },
          stated_owner: { ...nullableStr, description: 'Only if the cited text explicitly assigns/accepts ownership' },
          stated_deadline: { ...isoDateOrNull, description: 'ISO date only if explicit or resolvable from meeting_date' },
          stated_deadline_text: { ...nullableStr, description: 'Raw phrase from the transcript, e.g. "by September 30"' },
        },
      },
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'description', 'source_refs', 'related_fact_ids', 'suggested_question'],
        properties: {
          id: { type: 'string', pattern: '^I\\d+$' },
          kind: { enum: ['missing', 'conflict', 'ambiguous'] },
          description: { type: 'string', minLength: 3, maxLength: 500 },
          source_refs: { type: 'array', items: sourceRef },
          related_fact_ids: { type: 'array', items: { type: 'string', pattern: '^F\\d+$' } },
          suggested_question: { type: 'string', minLength: 3, maxLength: 300 },
        },
      },
    },
  },
};

export const IntakeInput = {
  type: 'object',
  required: ['meeting', 'transcript_lines'],
  properties: {
    meeting: { type: 'object', required: ['title', 'date'], properties: { title: str, date: isoDateOrNull } },
    transcript_lines: {
      type: 'array',
      minItems: 1,
      items: { type: 'object', required: ['line', 'text'], properties: { line: { type: 'integer' }, text: str } },
    },
  },
};

// -------------------------------------------------------------- Planning ----
const basis = { enum: ['stated_in_source', 'recommended_by_rule', 'unassigned'] };

export const PlanOutput = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'supported_facts', 'tasks', 'recommendations', 'unresolved_questions', 'addressed_findings'],
  properties: {
    summary: { type: 'string', maxLength: 600 },
    supported_facts: {
      type: 'array',
      description: 'Source facts the plan relies on (established by the meeting, not opinions).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fact_id', 'how_used'],
        properties: { fact_id: { type: 'string' }, how_used: { type: 'string', maxLength: 300 } },
      },
    },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'description', 'kind', 'owner', 'owner_basis', 'deadline', 'deadline_basis', 'depends_on', 'fact_ids', 'rule_ids', 'rationale'],
        properties: {
          id: { type: 'string', pattern: '^T\\d+$' },
          title: { type: 'string', minLength: 3, maxLength: 140 },
          description: { type: 'string', maxLength: 500 },
          kind: { enum: ['supported', 'recommended'], description: 'supported = directly grounded in source facts; recommended = proposed by the planner' },
          owner: nullableStr,
          owner_basis: basis,
          deadline: isoDateOrNull,
          deadline_basis: basis,
          depends_on: { type: 'array', items: { type: 'string', pattern: '^T\\d+$' } },
          fact_ids: { type: 'array', items: { type: 'string' } },
          rule_ids: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string', maxLength: 400 },
        },
      },
    },
    recommendations: {
      type: 'array',
      description: 'Advice that is NOT a task and NOT a source fact.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text', 'rationale', 'fact_ids', 'rule_ids'],
        properties: {
          id: { type: 'string' },
          text: { type: 'string', maxLength: 400 },
          rationale: { type: 'string', maxLength: 400 },
          fact_ids: { type: 'array', items: { type: 'string' } },
          rule_ids: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    unresolved_questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'question', 'why_it_matters', 'related_issue_ids', 'related_fact_ids', 'blocking_task_ids'],
        properties: {
          id: { type: 'string' },
          question: { type: 'string', maxLength: 300 },
          why_it_matters: { type: 'string', maxLength: 300 },
          related_issue_ids: { type: 'array', items: { type: 'string' } },
          related_fact_ids: { type: 'array', items: { type: 'string' } },
          blocking_task_ids: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    addressed_findings: {
      type: 'array',
      description: 'On a revision: one entry per finding received from the Review Agent. Empty on the first draft.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['finding_id', 'action', 'explanation'],
        properties: {
          finding_id: { type: 'string' },
          action: { enum: ['fixed', 'disputed'] },
          explanation: { type: 'string', maxLength: 300 },
        },
      },
    },
  },
};

export const PlanningInput = {
  type: 'object',
  required: ['context_version', 'meeting', 'facts', 'issues', 'rules', 'roster', 'feedback'],
  properties: {
    context_version: { type: 'integer' },
    meeting: { type: 'object' },
    facts: { type: 'array' },
    issues: { type: 'array' },
    rules: { type: 'array', minItems: 1 },
    roster: { type: 'array' },
    feedback: { type: ['object', 'null'] },
  },
};

// ---------------------------------------------------------------- Review ----
export const ReviewOutput = {
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
          task_id: nullableStr,
          description: { type: 'string', minLength: 3, maxLength: 500 },
          evidence: { type: 'string', maxLength: 400, description: 'Quote or rule id that proves the problem' },
          rule_ids: { type: 'array', items: { type: 'string' } },
          fact_ids: { type: 'array', items: { type: 'string' } },
          required_correction: { type: 'string', minLength: 3, maxLength: 400 },
        },
      },
    },
    checks_performed: { type: 'array', items: { type: 'string', maxLength: 200 } },
  },
};

export const ReviewInput = {
  type: 'object',
  required: ['context_version', 'transcript_lines', 'rules', 'roster', 'facts', 'issues', 'plan', 'guard_findings', 'round', 'prior_findings'],
  properties: {
    context_version: { type: 'integer' },
    transcript_lines: { type: 'array', minItems: 1 },
    rules: { type: 'array', minItems: 1 },
    roster: { type: 'array' },
    facts: { type: 'array' },
    issues: { type: 'array' },
    plan: { type: 'object', required: ['tasks'] },
    guard_findings: { type: 'array' },
    round: { type: 'integer' },
    prior_findings: { type: 'array' },
  },
};

/** Normalised finding shape used in feedback messages (Review -> Planning). */
export const Finding = {
  type: 'object',
  required: ['id', 'source', 'severity', 'category', 'description', 'required_correction'],
  properties: {
    id: str,
    source: { enum: ['review_agent', 'guard'] },
    severity: { enum: ['blocker', 'major', 'minor'] },
    category: str,
    task_id: nullableStr,
    description: str,
    required_correction: str,
  },
};

/** Envelope stored for every handoff message between agents (and the deterministic guard). */
export const HandoffEnvelope = {
  type: 'object',
  required: ['id', 'seq', 'from', 'to', 'type', 'schema', 'context_version', 'validation', 'summary', 'payload'],
  properties: {
    id: str,
    seq: { type: 'integer' },
    from: { enum: ['user', 'intake', 'planning', 'review', 'guard', 'orchestrator'] },
    to: { enum: ['user', 'intake', 'planning', 'review', 'guard', 'orchestrator'] },
    type: str,
    schema: str,
    context_version: { type: 'integer' },
    validation: { type: 'object', required: ['ok', 'errors'] },
    summary: str,
    payload: {},
  },
};
