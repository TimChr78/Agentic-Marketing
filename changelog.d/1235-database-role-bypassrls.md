---
section: Changed
issues: [1235]
---
- **Breaking for a non-bypass database role:** `DATABASE_URL` must be a `SUPERUSER` or have
  `BYPASSRLS`. The server's admin pool reads sessions, API tokens and workspaces without
  `app.workspace_id`, and every tenant table is `FORCE ROW LEVEL SECURITY`, so a role that owns the
  tables without the bypass saw no rows and refused everyone. Startup now stops with a message
  naming `ALTER ROLE … BYPASSRLS`, `am doctor` reports it as `postgres.admin-role`, and the
  deployment docs state the requirement. The Compose `am` role is a superuser already.
