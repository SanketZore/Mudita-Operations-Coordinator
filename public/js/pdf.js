/**
 * Plan export. Builds a self-contained, print-optimised HTML document from the
 * reviewed plan and hands it to the browser's print-to-PDF dialog.
 *
 * This module is deliberately standalone (its own escaping and date helpers) so
 * the document can be rendered and asserted on outside the browser.
 */

function escapeHtml(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate(value) {
  if (!value) return 'No date';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Where an owner or a deadline came from, in words a reader outside the app understands. */
function basisLabel(basis, ruleIds = []) {
  if (basis === 'stated_in_source') return 'said in the meeting';
  if (basis === 'recommended_by_rule') return `recommended${ruleIds.length ? ` (${ruleIds.join(', ')})` : ''}`;
  return 'not decided';
}

/** The document title is what most browsers pre-fill as the saved PDF's filename. */
function safeFilename(title) {
  const slug = String(title || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return 'ops-plan';
  return slug.endsWith('plan') ? slug : `${slug}-plan`;
}

export function buildPlanPdfHtml(run) {
  const plan = run?.result?.final_plan;
  if (!plan) {
    return '<html><body><h1>Plan not available</h1></body></html>';
  }

  const tasks = plan.tasks || [];
  const supported = tasks.filter((task) => task.kind === 'supported');
  const recommended = tasks.filter((task) => task.kind !== 'supported');
  const questions = plan.unresolved_questions || [];
  const recommendations = plan.recommendations || [];
  const approved = run.result?.status === 'approved';
  const owners = [...new Set(tasks.map((t) => t.owner).filter(Boolean))];

  const renderTask = (task, index) => `
    <div class="task ${task.kind === 'supported' ? 'supported' : 'recommended'}">
      <div class="task-head">
        <span class="task-no">${index + 1}</span>
        <div>
          <strong>${escapeHtml(task.title)}</strong>
          <span class="task-id">${escapeHtml(task.id)}</span>
        </div>
      </div>
      <div class="task-body">
        ${task.description ? `<p>${escapeHtml(task.description)}</p>` : ''}
        <dl class="task-meta">
          <div><dt>Owner</dt><dd>${escapeHtml(task.owner || 'Unassigned')} <span class="basis">${escapeHtml(basisLabel(task.owner_basis, task.rule_ids))}</span></dd></div>
          <div><dt>Due</dt><dd>${escapeHtml(formatDate(task.deadline))} <span class="basis">${escapeHtml(basisLabel(task.deadline_basis, task.rule_ids))}</span></dd></div>
          ${task.depends_on?.length ? `<div><dt>Waits for</dt><dd>${escapeHtml(task.depends_on.join(', '))}</dd></div>` : ''}
        </dl>
        ${task.rationale ? `<p class="why"><span>Why</span>${escapeHtml(task.rationale)}</p>` : ''}
      </div>
    </div>`;

  const renderRecommendation = (item) => `
    <div class="mini-card">
      <strong>${escapeHtml(item.text || 'Recommendation')}</strong>
      ${item.rationale ? `<p>${escapeHtml(item.rationale)}</p>` : ''}
    </div>`;

  const section = (title, count, body) => `
    <section class="section">
      <h2>${escapeHtml(title)}${count === null ? '' : ` <span class="count">${count}</span>`}</h2>
      ${body}
    </section>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(safeFilename(run.title))}</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #101A24;
        --ink-2: #1B2937;
        --muted: #5A6878;
        --faint: #8695A5;
        --line: #DFE6EF;
        --line-strong: #C6D1DE;
        --soft: #F6F8FC;
        --ok: #1B7A3C;
        --warn: #B36A00;
        --planning: #3355D8;
      }
      * { box-sizing: border-box; }
      html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      body {
        margin: 0;
        font-family: 'Schibsted Grotesk', system-ui, -apple-system, 'Segoe UI', Arial, sans-serif;
        font-size: 10.5pt;
        line-height: 1.5;
        color: var(--ink);
        background: #EEF2F7;
      }
      .page { max-width: 820px; margin: 28px auto; padding: 40px 44px 34px; background: #fff; border-radius: 14px; box-shadow: 0 12px 28px rgba(16, 26, 36, .08); }

      /* masthead */
      .header { border-bottom: 2px solid var(--ink); padding-bottom: 16px; margin-bottom: 20px; }
      .header-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
      .eyebrow { font-size: 8pt; letter-spacing: .14em; text-transform: uppercase; color: var(--planning); font-weight: 700; }
      h1 { margin: 6px 0 10px; font-size: 21pt; letter-spacing: -.02em; line-height: 1.15; }
      .status { flex: none; font-size: 8.5pt; font-weight: 700; padding: 4px 12px; border-radius: 999px; border: 1.5px solid; white-space: nowrap; }
      .status.ok { color: var(--ok); border-color: var(--ok); background: #ECF7F0; }
      .status.review { color: var(--warn); border-color: var(--warn); background: #FBF3E3; }
      .meta { display: flex; flex-wrap: wrap; gap: 6px 22px; color: var(--muted); font-size: 8.5pt; }
      .meta b { color: var(--ink-2); font-weight: 650; }

      /* at-a-glance numbers */
      .stats { display: flex; gap: 10px; margin: 18px 0 22px; }
      .stat { flex: 1; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: var(--soft); }
      .stat .n { font-size: 16pt; font-weight: 700; line-height: 1.1; }
      .stat .l { font-size: 7.5pt; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); font-weight: 700; }

      .summary { margin: 0 0 24px; padding: 14px 16px; background: var(--soft); border-left: 4px solid var(--planning); border-radius: 0 10px 10px 0; }
      .summary p { margin: 6px 0 0; }

      .section { margin-top: 24px; break-inside: auto; }
      .section h2 { font-size: 13pt; margin: 0 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 8px; }
      .count { font-size: 8.5pt; font-weight: 700; color: var(--muted); background: var(--soft); border: 1px solid var(--line); border-radius: 999px; padding: 1px 9px; }

      /* tasks */
      .task { border: 1px solid var(--line); border-left: 4px solid var(--ink); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; break-inside: avoid; }
      .task.recommended { border-left-style: dashed; border-left-color: var(--planning); }
      .task-head { display: flex; gap: 10px; align-items: baseline; }
      .task-no { flex: none; width: 20px; height: 20px; border-radius: 50%; background: var(--ink); color: #fff; font-size: 8pt; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
      .task-head strong { font-size: 11pt; }
      .task-id { font-size: 8pt; color: var(--faint); font-weight: 700; letter-spacing: .05em; margin-left: 8px; }
      .task-body { padding-left: 30px; }
      .task-body p { margin: 6px 0; }
      .task-meta { display: flex; flex-wrap: wrap; gap: 6px 26px; margin: 8px 0 0; }
      .task-meta div { min-width: 150px; }
      .task-meta dt { font-size: 7.5pt; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); font-weight: 700; }
      .task-meta dd { margin: 1px 0 0; font-weight: 600; }
      .basis { font-weight: 500; font-size: 8.5pt; color: var(--muted); }
      .why { font-size: 9pt; color: var(--muted); border-top: 1px dotted var(--line-strong); padding-top: 6px; margin-top: 8px; }
      .why span { font-weight: 700; color: var(--ink-2); margin-right: 6px; text-transform: uppercase; font-size: 7.5pt; letter-spacing: .08em; }

      .mini-card { border: 1px dashed var(--line-strong); border-radius: 10px; background: var(--soft); padding: 11px 13px; margin-bottom: 9px; break-inside: avoid; }
      .mini-card p { margin: 5px 0 0; color: var(--muted); font-size: 9.5pt; }
      .question { border-left: 3px solid var(--warn); background: #FEFAF4; padding: 10px 13px; border-radius: 0 8px 8px 0; margin-bottom: 9px; break-inside: avoid; }
      .question p { margin: 4px 0 0; color: var(--muted); font-size: 9.5pt; }
      .muted { color: var(--muted); }

      .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--faint); font-size: 8pt; display: flex; justify-content: space-between; gap: 12px; }

      @page { size: A4; margin: 16mm; }
      @media print {
        body { background: #fff; }
        .page { margin: 0; padding: 0; max-width: none; box-shadow: none; border-radius: 0; }
        .section h2 { break-after: avoid; }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <header class="header">
        <div class="header-top">
          <div>
            <div class="eyebrow">Ops Coordinator &mdash; reviewed action plan</div>
            <h1>${escapeHtml(run.title || 'Operations plan')}</h1>
          </div>
          <span class="status ${approved ? 'ok' : 'review'}">${approved ? 'Approved by review' : 'Needs human review'}</span>
        </div>
        <div class="meta">
          <span>Generated <b>${escapeHtml(formatDate(run.created_at || new Date().toISOString()))}</b></span>
          <span>Model <b>${escapeHtml(run.provider?.name || 'system')}${run.provider?.mock ? ' (mock)' : ''}</b></span>
          ${run.result?.context_version ? `<span>Facts version <b>v${escapeHtml(run.result.context_version)}</b></span>` : ''}
          ${run.result?.revisions_used !== undefined ? `<span>Revisions used <b>${escapeHtml(run.result.revisions_used)} of ${escapeHtml(run.result.max_revisions)}</b></span>` : ''}
        </div>
      </header>

      <div class="stats">
        <div class="stat"><div class="n">${tasks.length}</div><div class="l">Tasks</div></div>
        <div class="stat"><div class="n">${supported.length}</div><div class="l">Supported</div></div>
        <div class="stat"><div class="n">${owners.length}</div><div class="l">Owners</div></div>
        <div class="stat"><div class="n">${questions.length}</div><div class="l">Open questions</div></div>
      </div>

      <div class="summary">
        <div class="eyebrow">Approved plan</div>
        <p>${escapeHtml(plan.summary || 'No summary provided.')}</p>
      </div>

      ${section('Tasks supported by the meeting', supported.length, supported.map(renderTask).join('') || '<p class="muted">No supported tasks.</p>')}

      ${recommended.length ? section('Tasks the Planning Agent recommends', recommended.length, recommended.map((t, i) => renderTask(t, supported.length + i)).join('')) : ''}

      ${recommendations.length ? section('Recommendations', recommendations.length, recommendations.map(renderRecommendation).join('')) : ''}

      ${section('Open questions', questions.length, questions.map((q) => `
        <div class="question">
          <strong>${escapeHtml(q.question || 'Open question')}</strong>
          ${q.why_it_matters ? `<p>${escapeHtml(q.why_it_matters)}</p>` : ''}
        </div>`).join('') || '<p class="muted">None. Every question raised during intake was resolved.</p>')}

      <footer class="footer">
        <span>Generated by Ops Coordinator from the current reviewed plan.</span>
        <span>${escapeHtml(run.title || 'Operations plan')}</span>
      </footer>
    </div>
  </body>
</html>`;
}

export function downloadPlanPdf(run) {
  const html = buildPlanPdfHtml(run);

  // A hidden same-document iframe is used rather than a popup: window.open with
  // "noopener" always returns null, and popup blockers routinely kill the rest.
  try {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('title', 'Plan export');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      setTimeout(() => frame.remove(), 500);
    };
    frame.addEventListener('load', () => {
      const w = frame.contentWindow;
      // Inserting an iframe fires a load for its initial about:blank document.
      // Only print once the exported plan is actually in there.
      if (!w || !frame.contentDocument?.querySelector('.page')) return;
      try {
        w.focus();
        w.onafterprint = cleanup;
        w.print();
        // Safety net: onafterprint does not fire everywhere.
        setTimeout(cleanup, 60000);
      } catch {
        cleanup();
      }
    });
    // srcdoc is set before insertion so the content load is the one we observe.
    frame.srcdoc = html;
    document.body.appendChild(frame);
    return true;
  } catch {
    // Last resort for anything that refuses srcdoc: a real window we can write to.
    const printWindow = window.open('', '_blank');
    if (!printWindow) return false;
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      try {
        printWindow.print();
      } catch {
        /* the user can still print from the opened window */
      }
    }, 250);
    return true;
  }
}
