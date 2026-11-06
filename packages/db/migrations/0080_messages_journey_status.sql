-- Current delivery state per broadcast (#437, #442 review): `broadcasts.status` counts a broadcast's
-- messages by their current status, so the list can say Delivering, Sent or Failed truthfully. The
-- event statistics count every event a message ever had (a delivered message still counts as
-- queued), so they cannot. One index makes the per-broadcast count cheap.
CREATE INDEX IF NOT EXISTS messages_journey_status ON messages (workspace_id, journey_id, status) WHERE journey_id IS NOT NULL;
