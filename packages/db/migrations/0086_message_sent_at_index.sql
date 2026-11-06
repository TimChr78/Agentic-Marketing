-- am:no-transaction
-- Both caps read one person's contacts in a window: the channel frequency cap and the cross-agent
-- contact pressure (#426). Built CONCURRENTLY so a large install keeps accepting sends while the
-- index is created; the migrator runs this file outside BEGIN/COMMIT (#453, 0.10.1 review).
CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_policy_window ON messages (workspace_id, profile_id, sent_at);

-- The background `sent_at` backfill and `am doctor`'s progress line look only for completed rows
-- that are still NULL. A partial index keeps that lookup cheap on a large message log and shrinks
-- to nothing once the backfill is done; new sends get sent_at in the same UPDATE that completes
-- them, so they never enter it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_sent_at_pending
  ON messages (workspace_id, id)
  WHERE sent_at IS NULL AND status IN ('sent', 'delivered', 'bounced', 'complained');
