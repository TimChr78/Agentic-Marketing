-- One pending OAuth consent choice per request and workspace (#838).
--
-- A re-pick for the same authorization request (another brand in another tab) used to rewrite the
-- single session-keyed row through the owner pool, which bypassed row-level security. With one row
-- per (session, workspace) the consent page can write its own workspace as the app role; the
-- consumer takes the most recent row and drops the rest, and the scheduler removes abandoned rows.
ALTER TABLE oauth_workspace_selections DROP CONSTRAINT oauth_workspace_selections_pkey;
ALTER TABLE oauth_workspace_selections ADD PRIMARY KEY (session_id, workspace_id);
