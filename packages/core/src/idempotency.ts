/**
 * The strict idempotency key rule for the new surfaces — an MCP write tool's argument and a
 * caller-supplied typed-client key (#906): 1 to 200 printable ASCII characters, no spaces. The
 * REST header keeps accepting every non-empty value it accepted before 0.14.24 (spaces, non-ASCII,
 * longer values) for compatibility; only an empty header is new-invalid there.
 */
export const IDEMPOTENCY_KEY_MAX = 200;

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]+$/;

export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && key.length >= 1 && key.length <= IDEMPOTENCY_KEY_MAX && IDEMPOTENCY_KEY_PATTERN.test(key);
}
