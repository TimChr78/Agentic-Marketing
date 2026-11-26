---
section: Fixed
issues: [1220]
---
- `am backup` refuses a `DATABASE_URL` role that is not `SUPERUSER` and does not have `BYPASSRLS`
  before it starts the dump, naming the role and the `ALTER ROLE … BYPASSRLS` fix. `pg_dump` reads
  with `row_security = off`, which PostgreSQL refuses on every `FORCE ROW LEVEL SECURITY` table even
  for its owner. The per-workspace ClickHouse export still lifts FORCE for its own workspace-id and
  key reads; `am migrate` and `am restore` still run as the table owner.
