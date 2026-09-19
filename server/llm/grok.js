/**
 * OpenAI-compatible Chat Completions adapter.
 *
 * Historical env names still say GROK_ because the app originally targeted xAI
 * Grok, but the same adapter also works with Groq's OpenAI-compatible endpoint.
 * Structured output = forced function call whose parameters are the agent's
 * output schema. We re-validate the result ourselves (never trust the model).
 */
import { LLMError } from './errors.js';

/**
 * How long the provider wants us to wait before retrying, in ms.
 * Rate-limit replies carry either a `retry-after` header (seconds) or a
 * "try again in 3.3075s" hint in the error message. Free tiers ask for waits
 * longer than our exponential backoff, so we honour whichever is larger.
 */
function retryAfterMs(res, text) {
  const header = parseFloat(res.headers.get('retry-after') || '');
  if (Number.isFinite(header)) return Math.ceil(header * 1000);
  const m = /try again in ([\d.]+)s/i.exec(text);
  if (m) return Math.ceil(parseFloat(m[1]) * 1000);
  return 0;
}

/**
 * A token-budget rejection ("Limit 8000, Requested 11066") means input +
 * max_completion_tokens does not fit the tier's per-minute budget. Returns the
 * largest output budget that would fit, or 0 when this is not such an error.
 */
function shrunkTokenBudget(text, current) {
  const m = /Limit\s+(\d+).*Requested\s+(\d+)/i.exec(text);
  if (m) {
    const limit = Number(m[1]);
    const requested = Number(m[2]);
    const next = Math.max(MIN_OUTPUT_TOKENS, Math.min(current, limit - 128));
    if (requested > limit && next < current) return next;
    const over = requested - limit;
    const fallback = current - over - 256;
    return fallback >= MIN_OUTPUT_TOKENS ? fallback : 0;
  }
  return 0;
}

const MIN_OUTPUT_TOKENS = 1024;

export async function callGrok(config, { model, system, user, schema, toolName, toolDescription }, maxTokens = config.llm.maxOutputTokens) {
  const { apiKey, baseUrl, tokenParam, endpointName = 'LLM provider' } = config.grok;
  const isGroq = /api\.groq\.com/i.test(baseUrl);
  const body = {
    model,
    [tokenParam]: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    tools: [{ type: 'function', function: { name: toolName, description: toolDescription, parameters: schema } }],
    tool_choice: { type: 'function', function: { name: toolName } },
    parallel_tool_calls: false,
  };
  if (config.llm.temperature !== null && !Number.isNaN(config.llm.temperature)) body.temperature = config.llm.temperature;
  // Reasoning models bill their hidden thinking against the output budget, so a
  // low effort keeps a whole run inside a small tokens-per-minute allowance.
  // Groq does not accept the xAI-specific field and may reject structured tool calls
  // when the field is sent to a Groq model.
  if (!isGroq && config.grok.reasoningEffort) body.reasoning_effort = config.grok.reasoningEffort;

  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.llm.timeoutMs),
    });
  } catch (e) {
    throw new LLMError(`Network error calling ${endpointName}: ${e.name === 'TimeoutError' ? 'request timed out' : e.message}`, { retryable: true });
  }
  const text = await res.text();
  if (!res.ok) {
    const next = shrunkTokenBudget(text, maxTokens);
    // Input + output budget too large for the tier's per-minute cap: retry
    // straight away with the largest output budget that does fit.
    if ((res.status === 413 || res.status === 429) && next) {
      return callGrok(config, { model, system, user, schema, toolName, toolDescription }, next);
    }
    // Groq reports a tool call it could not parse (usually a generation cut off
    // by max_tokens) as a 400, not as finish_reason "length". Retry once with a
    // smaller budget before failing to the UI so free-tier Groq runs do not die on
    // the first tool-call cut-off.
    if (res.status === 400 && /tool_use_failed|tool call/i.test(text)) {
      const next = shrunkTokenBudget(text, maxTokens) || Math.max(MIN_OUTPUT_TOKENS, Math.floor(maxTokens * 0.75));
      if (next < maxTokens) return callGrok(config, { model, system, user, schema, toolName, toolDescription }, next);
      throw new LLMError('The model produced an incomplete structured answer (likely cut off). Increase LLM_MAX_OUTPUT_TOKENS or shorten the input.', { status: 400, retryable: true });
    }
    throw new LLMError(`${endpointName} API ${res.status}: ${text.slice(0, 400)}`, {
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
      retryAfterMs: retryAfterMs(res, text),
    });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LLMError('The API returned a non-JSON response', { retryable: true });
  }
  const choice = json.choices?.[0];
  if (choice?.finish_reason === 'length') throw new LLMError('The model output was cut off (length). Increase LLM_MAX_OUTPUT_TOKENS.', { retryable: false });

  let data = null;
  const args = choice?.message?.tool_calls?.[0]?.function?.arguments;
  if (args) {
    try {
      data = JSON.parse(args);
    } catch {
      throw new LLMError('The function-call arguments were not valid JSON. The request will be retried once with validation feedback if retries remain.', { retryable: true });
    }
  } else {
    const content = choice?.message?.content;
    if (typeof content === 'string') {
      const trimmed = content.trim();
      const maybeJson = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      try {
        data = JSON.parse(maybeJson);
      } catch {
        // leave data as null so we can raise a clear error below
      }
    }
  }

  if (!data) {
    throw new LLMError('The model did not return the required structured output. Groq often emits plain text or a partial tool call on this model; try a smaller LLM_MAX_OUTPUT_TOKENS and a more reliable Groq model.', { retryable: true });
  }

  return {
    data,
    usage: { input_tokens: json.usage?.prompt_tokens || 0, output_tokens: json.usage?.completion_tokens || 0 },
    model: json.model || model,
    stop_reason: choice?.finish_reason,
  };
}
