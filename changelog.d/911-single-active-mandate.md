---
section: Fixed
issues: [911]
---
- A startup repair fixes workspaces that hit the pre-0.14.17 mandate race: for each agent it keeps the published mandate that actually applies today — the same rule the policy engine uses, so an older valid mandate beats a newer one whose content no longer validates — and archives the extra live mandates. It runs once per workspace under the mandate lock and records where it ran, so an ignored duplicate no longer blocks renewing or archiving the agent's mandate.
