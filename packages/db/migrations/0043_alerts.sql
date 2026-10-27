-- Threshold alerts (#76): a rule watches one measure from the metric layer over a window and
-- notifies a webhook or workspace members when it starts firing and when it resolves.
--
-- A rule's configuration is kind-specific JSON, validated by the alerts package before it is
-- stored. Alert events are one row per firing episode; the open row is the dedupe key, so the
-- scheduler can run every five minutes without notifying twice for the same incident.
CREATE TABLE alert_rules (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('deliverability', 'signup_drop', 'journey_errors')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  channels jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE alert_events (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  rule_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('firing', 'resolved')),
  value double precision NOT NULL,
  threshold double precision NOT NULL,
  "window" text NOT NULL,
  fired_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  notified jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, rule_id) REFERENCES alert_rules (workspace_id, id) ON DELETE CASCADE
);

-- One open episode per rule. This is what makes the scheduler idempotent: a second evaluation
-- while the condition holds finds the row instead of opening another one.
CREATE UNIQUE INDEX alert_events_open ON alert_events (workspace_id, rule_id) WHERE resolved_at IS NULL;
CREATE INDEX alert_events_history ON alert_events (workspace_id, rule_id, fired_at DESC);

ALTER TABLE alert_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON alert_rules
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE alert_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON alert_events
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- Deleting a rule is a normal edit and takes its history with it. Events are never deleted or
-- rewritten by the app beyond the firing → resolved transition.
GRANT SELECT, INSERT, UPDATE, DELETE ON alert_rules TO am_app;
GRANT SELECT, INSERT, UPDATE ON alert_events TO am_app;
