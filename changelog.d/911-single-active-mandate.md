---
section: Fixed
issues: [911]
---
- Migration 0094 repairs workspaces that hit the pre-0.14.17 mandate race: for each agent it keeps the published mandate that applies today (the newest valid one) and archives the extra live mandates, so an ignored duplicate no longer blocks renewing or archiving the agent's mandate.
