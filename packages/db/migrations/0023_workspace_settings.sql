-- Workspace settings. A display time zone for dates in the UI and e-mails; existing workspaces
-- keep UTC until an admin changes it. IANA names are validated in the workspace.update command.

ALTER TABLE workspaces ADD COLUMN time_zone text NOT NULL DEFAULT 'UTC';
