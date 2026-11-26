---
section: Fixed
issues: [1218]
---
- A new migration (0122) repeats the 0117, 0118 and 0119 stranded-row repairs for an install whose
  migration role owns the tables without `BYPASSRLS`. Those files read `workspaces` under `FORCE
  ROW LEVEL SECURITY`, found none, and were recorded as applied without repairing the list
  memberships, ad-conversion keys or profile scores they exist for. The replay takes the workspace
  identity lock in the same order live ingestion does, so it cannot deadlock with a running merge,
  and it does nothing at all for a `SUPERUSER` or `BYPASSRLS` migrator that already ran the repairs.
  Its ad-conversion repair treats a row as a duplicate only when it is the same event and
  destination (0118 compared keys only, so two legacy events such as `msg` and `purchase:msg` could
  delete one delivery) and stages the rewrites so overlapping keys move without losing a row.
