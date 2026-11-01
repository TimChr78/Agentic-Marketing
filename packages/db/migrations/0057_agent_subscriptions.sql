-- Wave 4, Phase 20 (#312; ADR-0016 §6): events for agents instead of polling.
--
-- An agent subscribes to the event types its loop reacts to (a hold run or vetoed, an approval
-- decided, a guardian episode or guardrail breach, an experiment reaching significance, an alert).
-- The scheduler derives the events from what the platform already records and delivers each to the
-- subscribed agents: a signed webhook delivery when the subscription names one, and a row here that
-- `agents.events` pages from. Events carry ids, a type, a time and a short summary, never personal
-- data.
CREATE TABLE agent_subscriptions (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  agent_id text NOT NULL,
  event_types text[] NOT NULL,
  filter jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- An outbound webhook endpoint to deliver to, or null to only record the event for agents.events.
  webhook_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX agent_subscriptions_agent ON agent_subscriptions (workspace_id, agent_id);

ALTER TABLE agent_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_subscriptions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_subscriptions TO am_app;

-- How far each source has been read for agent events. The first sweep starts at the earliest
-- subscription, so an upgraded workspace never replays its history and a new subscriber sees only
-- what happened after it subscribed.
CREATE TABLE agent_event_cursor (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  last_action_id bigint NOT NULL DEFAULT 0,
  last_approval_at timestamptz,
  last_guardian_at timestamptz,
  last_alert_at timestamptz,
  last_experiment_at timestamptz
);

ALTER TABLE agent_event_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_event_cursor FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_event_cursor
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON agent_event_cursor TO am_app;

-- One row per subscription and event: the record `agents.events` reads (the polling fallback) and
-- what makes a re-derived event silent. `id` is the cursor an agent pages with.
CREATE TABLE agent_events (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id bigserial NOT NULL,
  agent_id text NOT NULL,
  subscription_id text NOT NULL,
  type text NOT NULL,
  event_key text NOT NULL,
  summary text NOT NULL,
  subject jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, subscription_id, event_key)
);

CREATE INDEX agent_events_agent ON agent_events (workspace_id, agent_id, id);

ALTER TABLE agent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_events
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT ON agent_events TO am_app;
GRANT USAGE, SELECT ON SEQUENCE agent_events_id_seq TO am_app;
