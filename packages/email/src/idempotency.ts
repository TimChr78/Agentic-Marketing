import { IDEMPOTENCY_KEY_MAX, RESERVED_IDEMPOTENCY_PREFIXES, reservedIdempotencyPrefix } from '@agentic-marketing/core';
import { z } from 'zod';

/**
 * The optional `idempotencyKey` on an input-level send (#926): the repeat-safe key the handler
 * itself uses, so a retry of the same logical send replays instead of sending twice. It keeps the
 * REST surfaces' 1–200 character bound for compatibility, but not one of the platform's own
 * prefixes (#945): those keys are built by broadcasts, journeys, confirmations, alerts and the
 * other internal sends, and a caller who pre-claimed one would block that send with a fingerprint
 * conflict. The prefix list lives in `@agentic-marketing/core`, next to the strict key rule.
 */
export const sendIdempotencyKey = z
  .string()
  .min(1)
  .max(IDEMPOTENCY_KEY_MAX)
  .refine((key) => reservedIdempotencyPrefix(key) === null, {
    error: `An idempotencyKey may not start with a reserved system prefix (${RESERVED_IDEMPOTENCY_PREFIXES.join(', ')}): those belong to the platform's own sends. Use a key of your own.`,
  })
  .optional();
