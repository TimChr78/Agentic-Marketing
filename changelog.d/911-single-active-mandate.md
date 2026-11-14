---
section: Fixed
issues: [911]
---
- A startup repair fixes workspaces that hit the pre-0.14.17 mandate race: for each agent it keeps the published mandate that actually applies today — the same rule the policy engine uses, so an older valid mandate beats a newer one whose content no longer validates — and archives the extra live mandates. It decides group by group at the moment it holds that group's locks, never archives a group where no mandate is usable, follows the same lock order as a publish so it cannot deadlock with one, and records where it ran; a group a pass had to leave alone is retried on a later pass.
