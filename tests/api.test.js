/** HTTP-level tests: sessions, isolation between browsers, access gate, validation errors. */
import net from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { findAvailablePort } from '../server/index.js';
import { makeApp, sample } from './helpers.js';

async function serve(t) {
  const server = await new Promise((resolve) => {
    const s = t.app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

/** Minimal cookie-jar client so each "browser" gets its own session. */
function client(base) {
  let cookies = {};
  return async (path, opts = {}) => {
    const res = await fetch(base + path, {
      ...opts,
      headers: { 'content-type': 'application/json', cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return { status: res.status, json: await res.json().catch(() => null) };
  };
}

async function waitDone(api, id) {
  for (let i = 0; i < 200; i += 1) {
    const r = await api(`/api/runs/${id}`);
    if (!r.json.is_running && r.json.status !== 'created') return r.json;
    await new Promise((r2) => setTimeout(r2, 25));
  }
  throw new Error('timeout');
}

test('busy ports automatically fall back to the next free port', async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const port = blocker.address().port;

  const next = await findAvailablePort(port);

  assert.ok(next > port, 'fallback port should be higher than the occupied port');
  await new Promise((resolve) => blocker.close(resolve));
});

test('two browsers (sessions) cannot see or touch each other\'s runs', async () => {
  const t = makeApp();
  const srv = await serve(t);
  const a = client(srv.base);
  const b = client(srv.base);

  const created = await a('/api/runs', { method: 'POST', body: sample('weekly_sync') });
  assert.equal(created.status, 201);
  const id = created.json.id;
  assert.equal(created.json.session_id, undefined, 'session id is never sent to the browser');
  await waitDone(a, id);

  assert.equal((await a(`/api/runs/${id}`)).status, 200);
  assert.equal((await b(`/api/runs/${id}`)).status, 404, 'other session gets not-found');
  assert.equal((await b(`/api/runs/${id}/resume`, { method: 'POST' })).status, 404);
  assert.equal((await b(`/api/runs/${id}`, { method: 'DELETE' })).status, 404);
  assert.deepEqual((await b('/api/runs')).json, []);
  assert.equal((await a('/api/runs')).json.length, 1);

  // reset only clears the caller's workspace
  const bRun = await b('/api/runs', { method: 'POST', body: sample('weekly_sync') });
  await waitDone(b, bRun.json.id);
  await b('/api/reset', { method: 'POST' });
  assert.equal((await a('/api/runs')).json.length, 1);
  await srv.close();
  t.cleanup();
});

test('API validation errors are clear 4xx responses', async () => {
  const t = makeApp();
  const srv = await serve(t);
  const a = client(srv.base);
  const bad = await a('/api/runs', { method: 'POST', body: { ...sample('weekly_sync'), meeting_date: 'tomorrow' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'bad_date');
  assert.equal((await a('/api/runs/not-an-id')).status, 404);
  assert.equal((await a('/api/nope')).status, 404);
  await srv.close();
  t.cleanup();
});

test('demo access code gates the API until entered', async () => {
  const t = makeApp({ DEMO_ACCESS_CODE: 'open-sesame', SESSION_SECRET: 'x' });
  const srv = await serve(t);
  const a = client(srv.base);
  assert.equal((await a('/api/runs')).status, 401);
  assert.equal((await a('/api/health')).json.authorized, false);
  assert.equal((await a('/api/access', { method: 'POST', body: { code: 'wrong' } })).status, 401);
  assert.equal((await a('/api/access', { method: 'POST', body: { code: 'open-sesame' } })).status, 200);
  assert.equal((await a('/api/runs')).status, 200);
  await srv.close();
  t.cleanup();
});

test('missing LLM API key returns a clear 503 instead of failing silently', async () => {
  const t = makeApp({ LLM_PROVIDER: 'grok', GROK_API_KEY: '' });
  const srv = await serve(t);
  const a = client(srv.base);
  const r = await a('/api/runs', { method: 'POST', body: sample('weekly_sync') });
  assert.equal(r.status, 503);
  assert.match(r.json.error.message, /GROK_API_KEY/);
  assert.equal((await a('/api/health')).json.llm_ready, false);
  await srv.close();
  t.cleanup();
});

test('obvious endpoint/key mismatch fails before making a model call', async () => {
  const t = makeApp({ LLM_PROVIDER: 'grok', GROK_API_KEY: 'gsk_example', GROK_BASE_URL: 'https://api.x.ai/v1' });
  const srv = await serve(t);
  const a = client(srv.base);
  const r = await a('/api/runs', { method: 'POST', body: sample('weekly_sync') });
  assert.equal(r.status, 503);
  assert.match(r.json.error.message, /looks like a Groq key/);
  assert.equal(t.calls.total, 0);
  await srv.close();
  t.cleanup();
});
