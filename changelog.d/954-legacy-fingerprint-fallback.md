---
section: Fixed
issues: [954]
---
- The idempotency documentation now states the pre-0.14.22 carve-out in full: a send key stored before the request fingerprint existed is compared on the recipient, template, journey and variant only, so a different caller or different template data reusing that exact old key replays the first request's answer instead of answering `409`. Every row written since is bound to the full fingerprint (the caller, and the recipient, template and data as supplied). The comparison itself is unchanged; the documentation and the code's own comment no longer claim more than it does.
