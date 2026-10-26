-- 0.2.5 (issue #130): which version the database last ran, so a pre-upgrade backup is named and
-- labelled with the data it holds rather than the build that took it. Not a tenant table: every
-- role records the same row, and only the admin connection (backups) and start-up write or read it.
CREATE TABLE server_versions (
  version text PRIMARY KEY,
  first_started_at timestamptz NOT NULL DEFAULT now(),
  last_started_at timestamptz NOT NULL DEFAULT now()
);
