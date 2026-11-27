---
section: Fixed
issues: [1300]
---
- A failed `ai.score` call stores a fixed diagnostic (the error code and "the AI provider refused or failed") in the audit log and the agent ledger instead of the decision provider's message, which can quote the person's data.
