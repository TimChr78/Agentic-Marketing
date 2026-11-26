---
section: Fixed
issues: [1218]
---
- A new migration repeats the 0117, 0118 and 0119 stranded-row repairs for an install whose
  migration role owns the tables without `BYPASSRLS`. Those files read `workspaces` under `FORCE
  ROW LEVEL SECURITY`, found none, and were recorded as applied without repairing the list
  memberships, ad-conversion keys or profile scores they exist for.
