---
section: Fixed
issues: [1220]
---
- `am backup --clickhouse` works as the table owner without `BYPASSRLS`: the per-workspace export
  reads the workspace ids with `FORCE ROW LEVEL SECURITY` lifted for that read instead of finding no
  workspace and failing with "the export wrote none". A role that is neither the owner nor able to
  bypass is refused with a message naming the fix.
