---
section: Security
issues: [913]
---
- `am reset-password` now sets the new password and ends that person's sessions in one transaction, so a crash, an OOM kill or a Ctrl-C between the two can no longer leave a session stolen before the reset valid behind a password that was in fact changed. It also writes the audit entry the web reset writes, marked `cli`, which names the person and the outcome but never the password. Neither reset path revokes that person's `amk_` API tokens or OAuth grants; the operator docs now say so.
