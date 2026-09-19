/**
 * config.js - the single place where environment variables are read.
 *
 * Everything the app needs to be configured is an env var (see `.env`).
 * `readConfig(env)` is a pure function so tests can build isolated configs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load `.env` from the project root. Real environment variables (e.g. set in
// a hosting dashboard) win over the file because dotenv never overrides.
dotenv.config({ path: path.join(ROOT, '.env') });

const DEFAULT_MODELS = {
  grok: 'grok-2-latest',
  gemini: 'gemini-2.0-flash',
  mock: 'mock-heuristic-v1',
};

function openAICompatibleName(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === 'api.x.ai' || host.endsWith('.x.ai')) return 'xAI Grok';
    if (host === 'api.groq.com' || host.endsWith('.groq.com')) return 'Groq';
    return host;
  } catch {
    return 'configured LLM endpoint';
  }
}

export function readConfig(env = process.env) {
  const str = (k, d = '') => (env[k] !== undefined && String(env[k]).trim() !== '' ? String(env[k]).trim() : d);
  const int = (k, d) => {
    const n = parseInt(env[k], 10);
    return Number.isFinite(n) ? n : d;
  };
  const num = (k, d) => {
    const n = parseFloat(env[k]);
    return Number.isFinite(n) ? n : d;
  };

  const provider = str('LLM_PROVIDER', 'gemini').toLowerCase();
  const baseModel = str('LLM_MODEL', str('GEMINI_MODEL', str('GROQ_MODEL', str('GROK_MODEL', DEFAULT_MODELS[provider] || DEFAULT_MODELS.gemini))));
  const tempRaw = str('LLM_TEMPERATURE', '');

  const geminiApiKey = str('GEMINI_API_KEY', str('GROQ_API_KEY', str('GROK_API_KEY')));
  const geminiBaseUrl = str('GEMINI_BASE_URL', str('GROQ_BASE_URL', str('GROK_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta'))).replace(/\/$/, '');
  const effectiveBaseUrl = provider === 'grok'
    ? str('GROK_BASE_URL', str('GROQ_BASE_URL', 'https://api.x.ai/v1')).replace(/\/$/, '')
    : provider === 'gemini'
      ? geminiBaseUrl
      : geminiBaseUrl;
  const isGroq = /api\.groq\.com/i.test(effectiveBaseUrl);
  const defaultMaxOutputTokens = provider === 'grok' || isGroq ? 1000 : 8192;
  const defaultTokenParam = isGroq ? 'max_tokens' : 'max_completion_tokens';

  return {
    port: int('PORT', 3000),
    root: ROOT,
    dataDir: path.resolve(ROOT, str('DATA_DIR', './data')),
    retentionDays: int('DATA_RETENTION_DAYS', 30),
    production: str('NODE_ENV') === 'production',

    provider,
    grok: {
      apiKey: geminiApiKey,
      baseUrl: geminiBaseUrl,
      endpointName: openAICompatibleName(geminiBaseUrl),
      tokenParam: str('GEMINI_TOKEN_PARAM', str('GROQ_TOKEN_PARAM', str('GROK_TOKEN_PARAM', defaultTokenParam))),
      reasoningEffort: str('GEMINI_REASONING_EFFORT', str('GROQ_REASONING_EFFORT', str('GROK_REASONING_EFFORT', isGroq ? '' : 'low'))),
    },
    gemini: {
      apiKey: geminiApiKey,
      baseUrl: geminiBaseUrl,
      endpointName: openAICompatibleName(geminiBaseUrl),
      model: str('GEMINI_MODEL', baseModel),
    },
    models: {
      intake: str('INTAKE_MODEL', str('GEMINI_MODEL', baseModel)),
      planning: str('PLANNING_MODEL', str('GEMINI_MODEL', baseModel)),
      review: str('REVIEW_MODEL', str('GEMINI_MODEL', baseModel)),
    },
    llm: {
      temperature: tempRaw === '' ? null : parseFloat(tempRaw),
      maxOutputTokens: int('LLM_MAX_OUTPUT_TOKENS', defaultMaxOutputTokens),
      timeoutMs: int('LLM_TIMEOUT_MS', 120000),
      maxRetries: int('LLM_MAX_RETRIES', 2),
      retryBaseDelayMs: int('LLM_RETRY_BASE_DELAY_MS', 800),
      maxSchemaRepairs: int('LLM_MAX_SCHEMA_REPAIRS', 1),
      maxConcurrentCalls: int('LLM_MAX_CONCURRENT_CALLS', 4),
    },
    pricing: {
      inputPerMTok: num('PRICE_INPUT_PER_MTOK', 1.0),
      outputPerMTok: num('PRICE_OUTPUT_PER_MTOK', 5.0),
    },
    review: { maxRevisions: int('REVIEW_MAX_REVISIONS', 2) },
    limits: {
      maxTranscriptChars: int('MAX_TRANSCRIPT_CHARS', 20000),
      maxRulesChars: int('MAX_RULES_CHARS', 8000),
      maxRosterChars: int('MAX_ROSTER_CHARS', 3000),
      maxRunsPerSession: int('MAX_RUNS_PER_SESSION', 20),
      rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 30),
    },
    accessCode: str('DEMO_ACCESS_CODE'),
    sessionSecret: str('SESSION_SECRET', 'dev-secret-change-me'),
  };
}

/** Is the configured provider usable? Returns { ready, reason }. */
export function llmStatus(config) {
  if (config.provider === 'mock') return { ready: true, reason: 'mock provider (not a real LLM)' };
  if (config.provider === 'grok' || config.provider === 'gemini') {
    const { apiKey, baseUrl, endpointName } = config.provider === 'gemini' ? config.gemini : config.grok;
    if (!apiKey) {
      const keyName = config.provider === 'gemini' ? 'GEMINI_API_KEY' : 'GROK_API_KEY';
      return { ready: false, reason: `${keyName} is empty. Add it to the .env file and restart.` };
    }
    const lower = baseUrl.toLowerCase();
    if (lower.includes('generativelanguage.googleapis.com') && !/^(?:AI|AQ)[A-Za-z0-9._-]+$/i.test(apiKey)) {
      return { ready: false, reason: 'GEMINI_BASE_URL points to Google Gemini, but the key does not look like a Gemini API key. Valid Google AI Studio keys usually start with "AI", "AIza", or "AQ".' };
    }
    if (lower.includes('api.x.ai') && apiKey.startsWith('gsk_')) {
      return { ready: false, reason: 'GROK_BASE_URL points to xAI, but GROK_API_KEY looks like a Groq key (gsk_...). Use an xAI key from https://console.x.ai or set GROK_BASE_URL=https://api.groq.com/openai/v1 for Groq.' };
    }
    if (lower.includes('api.groq.com') && apiKey.startsWith('xai-')) {
      return { ready: false, reason: 'GROK_BASE_URL points to Groq, but GROK_API_KEY looks like an xAI key (xai-...). Use a Groq key or set GROK_BASE_URL=https://api.x.ai/v1 for xAI.' };
    }
    return { ready: true, reason: '', endpoint: endpointName };
  }
  return { ready: false, reason: `Unknown LLM_PROVIDER "${config.provider}". Use gemini, grok or mock.` };
}

export const config = readConfig();
