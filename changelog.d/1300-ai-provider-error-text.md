---
section: Fixed
issues: [1300]
---
- A failed profile-bound AI command stores a fixed diagnostic in the audit log and the agent ledger instead of a message the provider may have built from the person's data. Only a provider-originated failure gets "the AI provider refused or failed"; a policy denial, a permission or existence refusal and a validation error keep their own reason, and an unexpected exception keeps one fixed marker.
