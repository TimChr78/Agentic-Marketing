-- START over SMS lifts the number's stop suppression with a DELETE (#664). 0004 granted am_app
-- only SELECT and INSERT on suppressions, so that DELETE failed with "permission denied" and the
-- inbound route answered 500: opting back in by text has never worked.
--
-- Row-level security stays in force. The tenant_isolation policy 0004 creates has no FOR clause,
-- so PostgreSQL applies it to every command, DELETE included, through its USING expression: the
-- app role can only remove rows whose workspace_id is the app.workspace_id of its session. No
-- second policy is needed; the statements below re-assert the protection the grant relies on.
GRANT DELETE ON suppressions TO am_app;

ALTER TABLE suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppressions FORCE ROW LEVEL SECURITY;
