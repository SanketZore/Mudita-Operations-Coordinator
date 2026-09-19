/**
 * Google Gemini REST adapter.
 *
 * Gemini is not OpenAI-compatible; it uses a different chat endpoint and JSON
 * shape. This adapter keeps the orchestrator contract unchanged by returning
 * the same { data, usage, model } structure the rest of the app expects.
 */
import { LLMError } from './errors.js';

const GEMINI_MAX_TOKENS_REASON = 'MAX_TOKENS';
const GEMINI_INTERNAL_RETRY_LIMIT = 1;

function retryAfterMs(res, text) {
  const header = parseFloat(res.headers.get('retry-after') || '');
  if (Number.isFinite(header)) return Math.ceil(header * 1000);
  const m = /try again in ([\d.]+)s/i.exec(text);
  if (m) return Math.ceil(parseFloat(m[1]) * 1000);
  return 0;
}

function nextTokenBudget(config, maxTokens) {
  const configured = config.llm.maxOutputTokens || maxTokens;
  const doubled = Math.max(maxTokens + 1024, Math.ceil(maxTokens * 2));
  return Math.max(configured, doubled);
}

function maxTokensError(maxTokens) {
  return new LLMError(`Gemini cut off the structured JSON output at ${maxTokens} tokens. Increase LLM_MAX_OUTPUT_TOKENS or shorten the transcript/rules input.`, { retryable: false });
}

function normalizeSchemaForGemini(value) {
  if (Array.isArray(value)) return value.map(normalizeSchemaForGemini);
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (key === 'additionalProperties') continue;
    if (key === 'type' && Array.isArray(val)) {
      const nonNull = val.filter((item) => item !== 'null');
      if (nonNull.length > 0) {
        out.type = nonNull[0];
      }
      if (val.includes('null')) out.nullable = true;
      continue;
    }
    if (key === 'items' || key === 'properties' || key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      out[key] = normalizeSchemaForGemini(val);
      continue;
    }
    if (key === 'required' && Array.isArray(val)) {
      out.required = val;
      continue;
    }
    if (key === 'enum' || key === 'description' || key === 'format' || key === 'minimum' || key === 'maximum' || key === 'minLength' || key === 'maxLength' || key === 'minItems' || key === 'maxItems' || key === 'pattern' || key === 'default') {
      out[key] = val;
      continue;
    }
    if (key === 'properties' && val && typeof val === 'object') {
      out.properties = Object.fromEntries(Object.entries(val).map(([propName, propSchema]) => [propName, normalizeSchemaForGemini(propSchema)]));
      continue;
    }
    if (typeof val === 'object') {
      out[key] = normalizeSchemaForGemini(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

export async function callGemini(config, { model, system, user, schema, toolName, toolDescription }, maxTokens = config.llm.maxOutputTokens ?? 8192, internalRetries = 0) {
  const { apiKey, baseUrl = 'https://generativelanguage.googleapis.com/v1beta' } = config.gemini || config.grok;
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const normalizedSchema = normalizeSchemaForGemini(schema);

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature: config.llm.temperature ?? 0.1,
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
      responseSchema: normalizedSchema,
    },
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.llm.timeoutMs),
    });
  } catch (e) {
    throw new LLMError(`Network error calling Gemini: ${e.name === 'TimeoutError' ? 'request timed out' : e.message}`, { retryable: true });
  }

  const text = await res.text();
  if (!res.ok) {
    const err = new LLMError(`Gemini API ${res.status}: ${text.slice(0, 400)}`, {
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
      retryAfterMs: retryAfterMs(res, text),
    });
    throw err;
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LLMError('Gemini returned a non-JSON response.', { retryable: true });
  }

  const candidate = json.candidates?.[0];
  const finishReason = candidate?.finishReason;
  const retryWithMoreTokens = () => {
    if (internalRetries >= GEMINI_INTERNAL_RETRY_LIMIT) throw maxTokensError(maxTokens);
    return callGemini(config, { model, system, user, schema, toolName, toolDescription }, nextTokenBudget(config, maxTokens), internalRetries + 1);
  };

  const part = candidate?.content?.parts?.find((p) => typeof p.text === 'string') || candidate?.content?.parts?.[0];
  const payload = part?.text || candidate?.content?.parts?.map((p) => p.text || '').join('');

  if (finishReason === GEMINI_MAX_TOKENS_REASON && !payload) {
    return retryWithMoreTokens();
  }

  if (!payload) {
    throw new LLMError(`Gemini returned no content${finishReason ? ` (finishReason: ${finishReason})` : ''}.`, { retryable: true });
  }

  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    const cleaned = payload.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const maybeJson = cleaned.match(/\{[\s\S]*\}/)?.[0] || cleaned;
    try {
      data = JSON.parse(maybeJson);
    } catch {
      if (finishReason === GEMINI_MAX_TOKENS_REASON) return retryWithMoreTokens();
      throw new LLMError('Gemini returned unparseable JSON for the structured output; the prompt was likely too large or the response was cut off.', { retryable: true });
    }
  }

  return {
    data,
    usage: {
      input_tokens: json.usageMetadata?.promptTokenCount || 0,
      output_tokens: json.usageMetadata?.completionTokenCount || 0,
    },
    model: model,
    stop_reason: finishReason,
  };
}
