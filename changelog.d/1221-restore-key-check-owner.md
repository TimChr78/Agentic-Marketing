---
section: Fixed
issues: [1221]
---
- The post-restore key check and `am doctor`'s `secrets.master-key-live` read `data_keys` with
  `FORCE ROW LEVEL SECURITY` lifted when `DATABASE_URL` is the table owner. A populated database is
  no longer reported as "no data keys", so a restore with the wrong `MASTER_KEY` fails before the
  app starts as it should. `am doctor` also bounds that read with `statement_timeout` and
  `lock_timeout`, so a locked `data_keys` cannot keep the CLI alive.
