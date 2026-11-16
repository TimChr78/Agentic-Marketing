import { redactCredentials, redactErrorDetails } from './diagnostics';

export type ErrorCode = 'invalid_input' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'precondition_failed';

const statusByCode: Record<ErrorCode, number> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
};

/**
 * An expected, user-facing failure. Messages are written for both people and LLM agents:
 * say what went wrong and what to do instead.
 */
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  get status(): number {
    return statusByCode[this.code];
  }

  /**
   * The body a caller sees: message and `details` redacted and bounded (#996). The executor
   * sanitises every error it throws, but an AppError can also be raised before it (authentication,
   * CSRF, a route's own validation), and REST and MCP both serialise through here. Redaction is
   * idempotent, so the second pass changes nothing.
   */
  toJSON() {
    const details = this.details === undefined ? undefined : redactErrorDetails(this.details);
    return {
      error: this.code,
      message: redactCredentials(this.message),
      ...(details === undefined ? {} : { details }),
    };
  }
}
