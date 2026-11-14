-- Immutable request identity for input-level message idempotency keys (#926).
--
-- `messages.idempotency_key` dedupes a send per workspace. A direct send's key comes from the
-- client, so two callers presenting the same key used to receive each other's message decision.
-- The row now stores a fingerprint of the request as it was supplied: the caller, the recipient
-- before resolution (so a retry with a since-merged profile id still matches), the template and the
-- template variables. A hit with the same fingerprint replays; a different one answers 409.
--
-- Internal sends (journey steps, broadcasts, test sends, system mail) fingerprint the stable
-- identifiers they already key on instead of the rendered payload, so a worker retry or a
-- redelivery stays a replay. Rows written before this column are null; a null row falls back to
-- comparing the stored recipient and template columns, as documented.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS request_hash text;

COMMENT ON COLUMN messages.request_hash IS
  'Immutable fingerprint of the request behind an input-level idempotency key; null on rows from before the column (#926).';
