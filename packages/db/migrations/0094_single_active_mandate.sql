-- The single-active-mandate repair (#911). Before 0.14.17 two concurrent mandate publishes could
-- leave two published, unarchived mandates for one agent. Which one applies is decided by the
-- runtime: `activeMandates` (packages/artifacts/src/mandates.ts) skips a mandate whose content fails
-- the full `agent_mandate` schema, so an older valid mandate beats a newer one with, for example,
-- an empty purpose. SQL cannot run that schema, so this migration does no data change: the repair
-- is code (`repairActiveMandates`), runs at start (and again when an earlier pass had to leave a
-- workspace alone), takes the artifact rows and then the same `am.agent-mandate` lock the publish
-- validator takes, keeps exactly what the runtime picks, archives the rest the way 0092 archives a
-- duplicate singleton, and records the workspace here so it does not scan it again.
--
-- `data_repairs` is admin-only by design, like `schema_migrations` and `server_versions`: it is
-- written and read through the admin pool, has no grant for the app role, no RLS policy and no
-- Drizzle mapping. Nothing in a request path touches it.
CREATE TABLE IF NOT EXISTS data_repairs (
  name text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  ran_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (name, workspace_id)
);
