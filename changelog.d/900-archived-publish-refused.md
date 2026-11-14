---
section: Fixed
issues: [900]
---
- No publish path accepts an archived artifact any more: `artifacts.requestPublish`, `artifacts.requestPublishBundle`, approvals, held changes and undo refuse one with a conflict that names the active singleton when there is one, so an approval made before an upgrade can no longer republish a duplicate a migration archived.
- An approval whose artifact is archived now ends as rejected with the reason instead of staying pending — including when its requester was paused or revoked afterwards — and `artifacts.list` hides archived rows unless `includeArchived: true` is passed and marks each row it returns.
