---
section: Fixed
issues: [948]
---
- The published list of what each send request fingerprint binds is now the code's own list. Every source builds its parts through one exported builder — `fingerprintParts.direct`, `doi`, `journey`, `broadcast`, `broadcastControl`, `test` and `alert` — the documentation is `fingerprintFields`, and a test fails when the two disagree or when a `sendRequestHash` call site bypasses a builder. It no longer claims a journey hashes the recipient and template (it binds the enrollment, step and sequence), no longer gives broadcast and holdout-control rows a template or variant they never hashed, and does include the double opt-in confirmation's form and form version.
