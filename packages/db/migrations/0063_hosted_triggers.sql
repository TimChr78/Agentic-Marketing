-- Hosted agents run on events too (#338): the event types that start a run, the agent subscription
-- that records them (#312), how far the agent has read them, and limits on event runs on top of the
-- run budgets. Each run records what started it.
ALTER TABLE hosted_agents ADD COLUMN triggers text[] NOT NULL DEFAULT '{}';
ALTER TABLE hosted_agents ADD COLUMN trigger_filter jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE hosted_agents ADD COLUMN trigger_subscription_id text;
ALTER TABLE hosted_agents ADD COLUMN last_event_id bigint NOT NULL DEFAULT 0;
ALTER TABLE hosted_agents ADD COLUMN event_min_gap_minutes integer NOT NULL DEFAULT 30;
ALTER TABLE hosted_agents ADD COLUMN event_runs_per_day integer NOT NULL DEFAULT 6;
ALTER TABLE hosted_agent_runs ADD COLUMN trigger text NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule', 'event'));
ALTER TABLE hosted_agent_runs ADD COLUMN event_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
