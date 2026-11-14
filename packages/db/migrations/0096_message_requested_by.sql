-- Caller binding for input-level message idempotency keys (#926).
--
-- `messages.idempotency_key` dedupes a send per workspace. A direct send's key comes from the
-- client, so two callers presenting the same key used to receive each other's message decision.
-- The row now records the caller the key belongs to: a hash of the principal for a direct send, or
-- 'system' for journeys, forms and test sends. Rows written before this column are null; a null row
-- matches a key on its input alone (the documented fallback for pre-existing data).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS requested_by text;

COMMENT ON COLUMN messages.requested_by IS
  'The caller an input-level idempotency key is bound to: a principal hash or system (#926). Null on rows from before the column.';
