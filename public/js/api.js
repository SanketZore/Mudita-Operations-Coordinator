/**
 * Thin fetch wrapper for the server API. Every failure becomes an ApiFailure
 * carrying the server's error code + message so the UI can show it verbatim
 * (the server never returns vague errors - see server/routes.js).
 */
export class ApiFailure extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiFailure(0, 'network', 'Cannot reach the server. Check that it is still running.');
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    throw new ApiFailure(res.status, json?.error?.code || 'error', json?.error?.message || `Request failed (${res.status}).`);
  }
  return json;
}

export const api = {
  health: () => request('GET', '/api/health'),
  access: (code) => request('POST', '/api/access', { code }),
  samples: () => request('GET', '/api/samples'),
  runs: () => request('GET', '/api/runs'),
  run: (id) => request('GET', `/api/runs/${id}`),
  createRun: (payload) => request('POST', '/api/runs', payload),
  deleteRun: (id) => request('DELETE', `/api/runs/${id}`),
  stop: (id) => request('POST', `/api/runs/${id}/stop`, {}),
  resume: (id) => request('POST', `/api/runs/${id}/resume`, {}),
  correct: (id, body) => request('POST', `/api/runs/${id}/corrections`, body),
  answer: (id, body) => request('POST', `/api/runs/${id}/answers`, body),
  source: (id, body) => request('POST', `/api/runs/${id}/source`, body),
  rerun: (id, body) => request('POST', `/api/runs/${id}/rerun`, body),
  reset: () => request('POST', '/api/reset', {}),
  startIsolation: () => request('POST', '/api/selftest/isolation', {}),
  isolationJob: (id) => request('GET', `/api/selftest/${id}`),
};
