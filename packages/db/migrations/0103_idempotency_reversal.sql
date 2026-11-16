-- #950: an idempotent replay returned the stored response forever, even after agents.undo had
-- reversed the action it described. The row now names the agent ledger entry it answered and when
-- that action was undone; the executor refuses a replay of a reversed key with 409.
ALTER TABLE idempotency_keys ADD COLUMN agent_action_id bigint;
ALTER TABLE idempotency_keys ADD COLUMN reversed_at timestamptz;

-- Undo looks a key up by the action it reverses.
CREATE INDEX idempotency_keys_agent_action ON idempotency_keys (agent_action_id) WHERE agent_action_id IS NOT NULL;
