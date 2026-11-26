---
section: Security
issues: [1228]
---
- `am rotate-keys` refuses a `DATABASE_URL` role that cannot see every data key instead of printing
  "re-wrapped 0 data key(s)" and telling the operator to remove `MASTER_KEY_PREVIOUS` while every
  key is still wrapped under it. The refusal names the role and the `ALTER ROLE … BYPASSRLS` fix.
