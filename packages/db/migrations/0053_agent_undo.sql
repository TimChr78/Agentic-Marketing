-- Wave 4, Phase 19 (#255; ADR-0016 §5.4): undo for agent actions.
--
-- The ledger stores how to reverse what an agent did (republish the version it replaced, cancel a
-- scheduled send, unpublish what it first published) and, once a person ran agents.undo, who did
-- it and what happened. A sent message cannot be recalled: those rows say so instead.
--
-- The ledger stays append-only for the app. `undo` is written once, with the insert; the app may
-- only fill in the three columns that mark the action undone.
ALTER TABLE agent_actions ADD COLUMN undo jsonb;
ALTER TABLE agent_actions ADD COLUMN undone_at timestamptz;
ALTER TABLE agent_actions ADD COLUMN undone_by text;
ALTER TABLE agent_actions ADD COLUMN undo_result text;

-- Column-level: the app can mark an action undone, never rewrite what it did.
GRANT UPDATE (undone_at, undone_by, undo_result) ON agent_actions TO am_app;
