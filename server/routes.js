/**
 * routes.js - the HTTP layer (Express). Thin on purpose: all logic is in core/.
 *
 * Security notes
 *  - API keys never leave the server. The browser only ever talks to /api/*.
 *  - Each browser gets a random, unguessable, httpOnly session cookie. Every run
 *    is looked up by (session, run) so one session can never read another's.
 *  - Optional access code (DEMO_ACCESS_CODE) protects a public deployment's budget.
 *  - Simple per-IP rate limiting on endpoints that can trigger paid model calls.
 *  - Strict CSP; the front end builds DOM with textContent (no innerHTML of user data).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { llmStatus } from './config.js';
import { ApiError } from './core/errors.js';
import { runIsolationTest } from './core/isolation.js';
import { newId } from './core/hash.js';

const COOKIE_DAYS = 30;

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createApp({ config, store, orchestrator }) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    next();
  });
  app.use(express.json({ limit: '300kb' }));
  app.use(express.static(path.join(config.root, 'public')));

  const api = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const cookieOpts = () => `Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86400}${config.production ? '; Secure' : ''}`;
  const setCookie = (res, name, value) => res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; ${cookieOpts()}`);

  // ---- optional access gate ------------------------------------------------
  const accessToken = () => crypto.createHmac('sha256', config.sessionSecret).update('access:' + config.accessCode).digest('hex');
  const isAuthorized = (req) => {
    if (!config.accessCode) return true;
    const got = parseCookies(req.headers.cookie).acc || '';
    const want = accessToken();
    return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  };

  api.get('/health', (req, res) => {
    const st = llmStatus(config);
    res.json({
      ok: true,
      provider: config.provider,
      mock: config.provider === 'mock',
      models: config.models,
      llm_ready: st.ready,
      llm_reason: st.reason,
      access_required: !!config.accessCode,
      authorized: isAuthorized(req),
      review_max_revisions: config.review.maxRevisions,
      limits: config.limits,
      pricing: config.pricing,
    });
  });

  api.post('/access', (req, res) => {
    const code = String(req.body?.code || '');
    if (!config.accessCode) return res.json({ ok: true });
    const a = crypto.createHash('sha256').update(code).digest();
    const b = crypto.createHash('sha256').update(config.accessCode).digest();
    if (!crypto.timingSafeEqual(a, b)) throw new ApiError(401, 'bad_code', 'That access code is not correct.');
    setCookie(res, 'acc', accessToken());
    res.json({ ok: true });
  });

  api.use((req, res, next) => {
    if (!isAuthorized(req)) return next(new ApiError(401, 'access_required', 'Enter the demo access code to continue.'));
    next();
  });

  // ---- session (one private workspace per browser) -------------------------
  api.use((req, res, next) => {
    let sid = parseCookies(req.headers.cookie).sid;
    if (!store.sessionExists(sid)) {
      sid = store.createSession();
      setCookie(res, 'sid', sid);
    }
    req.sid = sid;
    next();
  });

  // ---- rate limit (paid endpoints only) -------------------------------------
  const hits = new Map();
  const limited = (req, res, next) => {
    const now = Date.now();
    const list = (hits.get(req.ip) || []).filter((t) => now - t < 60000);
    if (list.length >= config.limits.rateLimitPerMinute) return next(new ApiError(429, 'rate_limited', 'Too many requests. Wait a minute and try again.'));
    list.push(now);
    hits.set(req.ip, list);
    next();
  };

  const requireLLM = () => {
    const st = llmStatus(config);
    if (!st.ready) throw new ApiError(503, 'llm_not_configured', st.reason);
  };
  const getRun = (req) => {
    const run = store.getRun(req.sid, req.params.id);
    if (!run) throw new ApiError(404, 'no_run', 'Run not found in this session.');
    return run;
  };
  const view = (run) => {
    const { session_id, ...rest } = run; // eslint-disable-line no-unused-vars
    return { ...rest, is_running: orchestrator.isRunning(run) };
  };
  const summary = (run) => ({
    id: run.id,
    title: run.title,
    status: run.status,
    created_at: run.created_at,
    updated_at: run.updated_at,
    result_status: run.result?.status || null,
    cost_usd: run.usage.cost_usd,
    provider: run.provider.name,
    is_running: orchestrator.isRunning(run),
  });

  api.get('/session', (req, res) => res.json({ id: req.sid.slice(0, 8), run_count: store.listRuns(req.sid).length }));
  api.post('/session/new', (req, res) => {
    const sid = store.createSession();
    setCookie(res, 'sid', sid);
    res.json({ id: sid.slice(0, 8), run_count: 0 });
  });
  api.post('/reset', (req, res) => {
    if (store.listRuns(req.sid).some((r) => orchestrator.isRunning(r))) throw new ApiError(409, 'run_busy', 'A run is still executing. Wait for it to finish, then reset.');
    res.json({ deleted: store.deleteAllRuns(req.sid) });
  });

  api.get('/samples', (req, res) => {
    const dir = path.join(config.root, 'samples');
    const out = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ id: f.replace('.json', ''), ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
    res.json(out);
  });

  // ---- runs -----------------------------------------------------------------
  api.get('/runs', (req, res) => res.json(store.listRuns(req.sid).map(summary)));

  api.post('/runs', limited, wrap(async (req, res) => {
    requireLLM();
    const run = orchestrator.createRun(req.sid, req.body || {});
    orchestrator.start(run);
    res.status(201).json(view(run));
  }));

  api.get('/runs/:id', (req, res) => res.json(view(getRun(req))));

  api.delete('/runs/:id', (req, res) => {
    const run = getRun(req);
    if (orchestrator.isRunning(run)) throw new ApiError(409, 'run_busy', 'This run is executing. Wait for it to finish before deleting.');
    store.deleteRun(req.sid, run.id);
    res.json({ deleted: true });
  });

  api.post('/runs/:id/stop', limited, (req, res) => {
    const run = getRun(req);
    orchestrator.stop(run);
    res.json(view(run));
  });

  api.post('/runs/:id/resume', limited, (req, res) => {
    requireLLM();
    const run = getRun(req);
    orchestrator.resume(run);
    res.json(view(run));
  });

  api.post('/runs/:id/corrections', limited, (req, res) => {
    requireLLM();
    const run = getRun(req);
    orchestrator.applyCorrection(run, req.body || {});
    res.json(view(run));
  });

  api.post('/runs/:id/answers', limited, (req, res) => {
    requireLLM();
    const run = getRun(req);
    orchestrator.applyAnswer(run, req.body || {});
    res.json(view(run));
  });

  api.post('/runs/:id/source', limited, (req, res) => {
    requireLLM();
    const run = getRun(req);
    orchestrator.updateSource(run, req.body || {});
    res.json(view(run));
  });

  api.post('/runs/:id/rerun', limited, (req, res) => {
    requireLLM();
    const run = getRun(req);
    orchestrator.rerun(run, req.body || {});
    res.json(view(run));
  });

  // ---- isolation self-test (async job, polled by the UI) --------------------
  const jobs = new Map();
  api.post('/selftest/isolation', limited, (req, res) => {
    requireLLM();
    const running = [...jobs.values()].find((j) => j.sid === req.sid && j.status === 'running');
    if (running) return res.status(202).json({ id: running.id, status: 'running' });
    const job = { id: newId(6), sid: req.sid, status: 'running', started_at: new Date().toISOString(), report: null, error: null };
    jobs.set(job.id, job);
    runIsolationTest({ store, orchestrator })
      .then((r) => Object.assign(job, { status: 'done', report: r }))
      .catch((e) => Object.assign(job, { status: 'error', error: e.message }));
    res.status(202).json({ id: job.id, status: 'running' });
  });
  api.get('/selftest/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || job.sid !== req.sid) throw new ApiError(404, 'no_job', 'Test not found.');
    res.json({ id: job.id, status: job.status, report: job.report, error: job.error });
  });

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown API route.' } }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'Request body too large.' } });
    if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: { code: 'bad_json', message: 'Invalid JSON body.' } });
    console.error(err);
    res.status(500).json({ error: { code: 'internal', message: 'Unexpected server error.' } });
  });

  return app;
}
