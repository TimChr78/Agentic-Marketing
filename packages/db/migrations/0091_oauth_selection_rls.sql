-- One pending OAuth consent choice per authorization request (#838), written under RLS.
--
-- 0.14.15 wrote this row through the owner pool, which bypassed row-level security. The workspace
-- is known by then, so the write belongs under `withWorkspace`. But a re-pick for the same request
-- can name another brand: the previous row belongs to that other workspace, and tenant isolation
-- would hide it from the new transaction, so neither an upsert nor a delete could replace it.
--
-- The row is a short-lived hand-off bound to the session, not a second membership model, so the
-- policy lets the transaction that names its session key see and replace that same session's row
-- (`app.oauth_selection_session`, set by `withSession`/`withWorkspace`). It never widens access to
-- a tenant table. The app still checks that the person is a member of the chosen workspace.
--
-- Expand only: the `session_id` primary key from 0077 stays. Old API pods (and an app rollback to
-- 0.14.15) still run `INSERT … ON CONFLICT (session_id)`, which needs that unique key; the new
-- code replaces the same row through the policy below. Do not drop it during an upgrade.
--
-- TODO(contract, 0.14.17+): once 0.14.15 pods can no longer be running, remove the session-scoped
-- policy branch and the session key; if a per-workspace key is still wanted then, make it
-- (session_id, workspace_id) in a release that no older pod can still reach.
DROP POLICY tenant_isolation ON oauth_workspace_selections;
CREATE POLICY oauth_selection_isolation ON oauth_workspace_selections
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    OR session_id = nullif(current_setting('app.oauth_selection_session', true), '')
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    OR session_id = nullif(current_setting('app.oauth_selection_session', true), '')
  );

COMMENT ON TABLE oauth_workspace_selections IS
  'Pending OAuth consent workspace choice for one Better Auth session request (#187, #838); the grant itself stores it as its reference id.';
