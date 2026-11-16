/**
 * The strict idempotency key rule for the new surfaces — an MCP write tool's argument and a
 * caller-supplied typed-client key (#906): 1 to 200 printable ASCII characters, no spaces. The
 * REST header keeps accepting every non-empty value it accepted before 0.14.21 (spaces, non-ASCII,
 * longer values) for compatibility; only an empty header is new-invalid there.
 */
export const IDEMPOTENCY_KEY_MAX = 200;

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]+$/;

export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && key.length >= 1 && key.length <= IDEMPOTENCY_KEY_MAX && IDEMPOTENCY_KEY_PATTERN.test(key);
}

/**
 * The key namespaces the platform's own sends and deliveries build (#945). They are deterministic,
 * so a caller who could pre-claim one would wedge the platform's send with a fingerprint conflict
 * (a broadcast's `bct:<broadcast>:<profile>` is predictable from ids the caller can read). A
 * caller-supplied send key may therefore not start with one of these, on any surface, and the list
 * here is the one the validator, the internal builders and their drift test share.
 */
export const RESERVED_IDEMPOTENCY_PREFIXES = [
  'adc:',
  'agent-digest:',
  'agent-event:',
  'agent-expiry:',
  'alert:',
  'bct:',
  'bctc:',
  'doi:',
  'experience-rollout:',
  'guardian:',
  'hosted-run:',
  'jrn:',
  'password-reset:',
  'test:',
  'wh:',
] as const;

/** The reserved prefix a caller-supplied key starts with, or null when the key is theirs. */
export function reservedIdempotencyPrefix(key: string): (typeof RESERVED_IDEMPOTENCY_PREFIXES)[number] | null {
  return RESERVED_IDEMPOTENCY_PREFIXES.find((prefix) => key.startsWith(prefix)) ?? null;
}
