/** Errors that map cleanly to HTTP status codes in routes.js. */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}
/** A handoff (agent input/output) failed schema validation. */
export class HandoffError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HandoffError';
  }
}
