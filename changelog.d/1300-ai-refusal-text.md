---
section: Fixed
issues: [1300]
---
- `ai.classify` and `ai.score` answer the same refusal for an unknown, an erased and a consent-refusing person, so a caller holding only `profiles:write` cannot learn from the error whether a profile exists. The detailed reason stays in the log.
