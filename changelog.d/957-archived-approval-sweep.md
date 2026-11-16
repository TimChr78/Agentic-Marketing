---
section: Fixed
issues: [957]
---
- Pending approval requests whose artifact is archived are now closed at start-up and on a few-hourly sweep, as rejected with the reason `approvals.approve` would give, instead of staying in the review queue forever after an upgrade archived a duplicate. `approvals.list` and `approvals.get` mark such a row with `archived: true` and the review queue and drawer say it can never publish, `system.status.pendingApprovals` no longer counts it (so the shell badge is not inflated), and a `policy:` decider such as `policy:archived` is shown as **System (policy)** in the decision history instead of the raw sentinel. A bundle is closed whole, so its other requests are not left undecidable.
