---
section: Fixed
issues: [1281]
---
- `ai.score`, `ai.classify` and journey AI steps now check AI consent on the person's current profile. An id from before an identity merge gets the person's own answer instead of reading as "no record", and the consent check, the context read and the work it allows use the same profile.
