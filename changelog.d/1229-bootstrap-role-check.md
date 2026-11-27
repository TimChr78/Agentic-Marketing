---
section: Fixed
issues: [1229]
---
- `am bootstrap` checks the `DATABASE_URL` role before creating the user, so a role that is subject
  to `FORCE ROW LEVEL SECURITY` fails with the role and the `ALTER ROLE … BYPASSRLS` fix instead of
  leaving a user behind with "new row violates row-level security policy for table workspaces".
