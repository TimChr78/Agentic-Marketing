-- Brand Host checking is an installation policy once it has been switched on (#463). It used to be
-- derived from the current verified rows, so removing the last verified domain silently reverted
-- every brand to any-Host. Remember the fact instead. The table is installation-level, not tenant
-- data: resolution happens before a workspace is known, so reads use the owner connection.
CREATE TABLE installation_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Verification writes the setting in its own transaction (#463), so the command role may update
-- it. Reads still use the owner connection because resolution precedes a tenant context.
GRANT SELECT, INSERT, UPDATE ON installation_settings TO am_app;

-- An existing install that has already verified a brand domain keeps strict checking after the
-- upgrade. A fresh install starts permissive until the first verification, as before.
INSERT INTO installation_settings (key, value)
SELECT 'domain_routing_active', '{"active": true}'::jsonb
 WHERE EXISTS (SELECT 1 FROM workspace_domains WHERE status = 'verified')
ON CONFLICT (key) DO NOTHING;
