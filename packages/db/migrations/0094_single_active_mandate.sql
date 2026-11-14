-- The single-active-mandate repair (#911). Before 0.14.17 two concurrent mandate publishes could
-- leave two published, unarchived mandates for one agent. Which one applies is decided by the
-- runtime: `activeMandates` (packages/artifacts/src/mandates.ts) skips a mandate whose content fails
-- the full `agent_mandate` schema, so an older valid mandate beats a newer one with, for example,
-- an empty purpose. SQL cannot run that schema, so this migration does no data change: the repair
-- is code (`repairActiveMandates`), runs once at start under the same `am.agent-mandate` lock the
-- publish validator takes, keeps exactly what the runtime picks, archives the rest the way 0092
-- archives a duplicate singleton, and records the workspace here so it does not scan it again.
CREATE TABLE IF NOT EXISTS data_repairs (
  name text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  ran_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (name, workspace_id)
);
