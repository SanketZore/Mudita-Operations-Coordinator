/** Error type for model-provider failures. `retryable` drives the backoff loop. */
export class LLMError extends Error {
  constructor(message, { status = null, retryable = false, simulated = false, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.retryable = retryable;
    this.simulated = simulated;
    // How long the provider asked us to wait (rate limits); 0 = no preference.
    this.retryAfterMs = retryAfterMs;
  }
}
