---
section: Security
issues: [940]
---
- Error text returned normally is redacted and bounded like the text beside it: a failed publish in `config.import` reports a redacted `changes[].problem` (and the idempotency row stores that form), and an approval closed for an archived artifact returns and stores a redacted `reason`/`decision_note` instead of quoting a credential from the artifact name. The same held-change path applies the same treatment.
