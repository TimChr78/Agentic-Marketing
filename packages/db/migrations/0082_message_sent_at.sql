-- Caps age a completed contact from when the provider accepted it, not from when it was queued
-- (#453): a message that waited for quiet hours, a paused stream or a retry must consume the
-- recent-contact window from its real send time. Queued and in-flight reservations still age
-- from created_at; the policy reads sent_at only for sent, delivered, bounced and complained.
--
-- Existing completed rows are backfilled from updated_at, the moment the send last changed them
-- (the provider acceptance or the latest delivery callback). A row that never completed keeps
-- sent_at null and is never counted as a contact.
ALTER TABLE messages ADD COLUMN sent_at timestamptz;

UPDATE messages
   SET sent_at = updated_at
 WHERE status IN ('sent', 'delivered', 'bounced', 'complained');

-- Both caps read one person's contacts in a window: the channel frequency cap and the cross-agent
-- contact pressure (#426). Without this the count falls back to the partial agent index or a scan.
CREATE INDEX messages_policy_window ON messages (workspace_id, profile_id, sent_at);

COMMENT ON COLUMN messages.sent_at IS
  'When the provider accepted the message (#453), the start of every delivery cap window; null while queued, sending, suppressed or failed.';
