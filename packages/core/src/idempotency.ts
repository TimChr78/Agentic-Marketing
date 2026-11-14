/**
 * The idempotency key rule shared by the command executor, the REST header, an MCP write tool and
 * the typed client (#906 review round 2): 1 to 200 printable ASCII characters, no spaces. A key
 * that fails it is refused rather than silently treated as "no key".
 */
export const IDEMPOTENCY_KEY_MAX = 200;

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]+$/;

export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && key.length >= 1 && key.length <= IDEMPOTENCY_KEY_MAX && IDEMPOTENCY_KEY_PATTERN.test(key);
}
