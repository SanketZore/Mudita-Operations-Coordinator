/**
 * LLM facade used by the orchestrator.
 *
 *   const llm = createLLM(config);
 *   const { data, usage, model, latency_ms } = await llm.call({ agent, system, user, input, schema, toolName, toolDescription });
 *
 * It adds: per-agent model selection, a concurrency limit, and exponential
 * backoff retries for transient failures (429/5xx/network). Schema validation
 * and repair prompts are the orchestrator's job (they need run context).
 */
import { callGrok } from './grok.js';
import { callGemini } from './gemini.js';
import { callMock } from './mock.js';
import { LLMError } from './errors.js';
import { llmStatus } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Semaphore {
  constructor(n) {
    this.n = Math.max(1, n);
    this.q = [];
  }
  async acquire() {
    if (this.n > 0) {
      this.n -= 1;
      return;
    }
    await new Promise((r) => this.q.push(r));
  }
  release() {
    const next = this.q.shift();
    if (next) next();
    else this.n += 1;
  }
}

export function createLLM(config) {
  const sem = new Semaphore(config.llm.maxConcurrentCalls);
  const primaryAdapter = config.provider === 'gemini' ? callGemini : config.provider === 'grok' ? callGrok : config.provider === 'mock' ? callMock : null;
  const fallbackAdapter = config.provider === 'grok' ? callGemini : null;

  return {
    provider: config.provider,
    describe() {
      return { provider: config.provider, models: config.models, ...llmStatus(config) };
    },
    async call({ agent, ...req }) {
      const status = llmStatus(config);
      if (!status.ready) throw new LLMError(status.reason, { retryable: false });
      const model = config.models[agent];
      const callWith = async (adapter, providerName, providerConfig, providerModel) => {
        await sem.acquire();
        const started = Date.now();
        try {
          let lastErr;
          for (let attempt = 0; attempt <= config.llm.maxRetries; attempt += 1) {
            try {
              const res = await adapter(providerConfig, { agent, model: providerModel, ...req });
              return { ...res, latency_ms: Date.now() - started, retries: attempt, provider: providerName };
            } catch (e) {
              lastErr = e;
              if (!(e instanceof LLMError) || !e.retryable || attempt === config.llm.maxRetries) throw e;
              const backoff = config.llm.retryBaseDelayMs * 2 ** attempt;
              await sleep(Math.max(backoff, e.retryAfterMs ? e.retryAfterMs + 500 : 0));
            }
          }
          throw lastErr;
        } finally {
          sem.release();
        }
      };

      try {
        return await callWith(primaryAdapter, config.provider, config, model);
      } catch (err) {
        if (config.provider !== 'grok' || !fallbackAdapter) throw err;
        const geminiCfg = {
          ...config,
          provider: 'gemini',
          models: {
            ...config.models,
            intake: config.gemini?.model || config.models.intake,
            planning: config.gemini?.model || config.models.planning,
            review: config.gemini?.model || config.models.review,
          },
        };
        const geminiModel = geminiCfg.gemini?.model || geminiCfg.models[agent];
        return await callWith(fallbackAdapter, 'gemini', geminiCfg, geminiModel);
      }
    },
  };
}
