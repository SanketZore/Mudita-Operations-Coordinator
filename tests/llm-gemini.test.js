import test from 'node:test';
import assert from 'node:assert/strict';
import { callGemini } from '../server/llm/gemini.js';

const baseConfig = {
  gemini: { apiKey: 'AIza-test', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  llm: { temperature: null, maxOutputTokens: 1400, timeoutMs: 1000 },
};

const req = {
  model: 'gemini-test',
  system: 'system',
  user: 'user',
  schema: {
    type: 'object',
    required: ['ok'],
    properties: { ok: { type: 'boolean' } },
  },
  toolName: 'submit',
  toolDescription: 'Submit JSON',
};

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('Gemini MAX_TOKENS with truncated JSON retries once with a larger budget', async () => {
  const originalFetch = globalThis.fetch;
  const budgets = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    budgets.push(body.generationConfig.maxOutputTokens);
    if (budgets.length === 1) {
      return jsonResponse({
        candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"ok":' }] } }],
        usageMetadata: { promptTokenCount: 7, completionTokenCount: 1400 },
      });
    }
    return jsonResponse({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"ok":true}' }] } }],
      usageMetadata: { promptTokenCount: 7, completionTokenCount: 4 },
    });
  };

  try {
    const res = await callGemini(baseConfig, req);
    assert.deepEqual(res.data, { ok: true });
    assert.deepEqual(budgets, [1400, 2800]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gemini repeated MAX_TOKENS returns a clear non-retryable token error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse({
      candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"ok":' }] } }],
      usageMetadata: { promptTokenCount: 7, completionTokenCount: 1400 },
    });

  try {
    await assert.rejects(
      () => callGemini(baseConfig, req),
      (err) => {
        assert.match(err.message, /Gemini cut off the structured JSON output/);
        assert.equal(err.retryable, false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
