-- A hard bounce or complaint that arrives while an SMS STOP row holds the primary key must
-- escalate that row instead of being dropped by ON CONFLICT DO NOTHING (#750): otherwise a later
-- START deletes the stop row and the number is contacted again despite the bounce. 0004 granted
-- am_app SELECT and INSERT on suppressions; 0088 added DELETE for START. The escalation is an
-- UPDATE, so grant it. Row-level security still applies through the same tenant_isolation policy:
-- USING and WITH CHECK both pin workspace_id to app.workspace_id.
GRANT UPDATE ON suppressions TO am_app;
