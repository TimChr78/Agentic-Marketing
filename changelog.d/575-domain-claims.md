---
section: Security
issues: [575]
---
- Changing a brand domain's hostname or path prefix after seven days no longer forfeits the name: a new pending claim now expires seven days after it was made, not after the original row was created, so another workspace can no longer reclaim a host that is still being verified. The upgrade backfills existing rows as the table owner, so it applies cleanly on a populated install where row-level security is forced.
