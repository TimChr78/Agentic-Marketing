---
section: Changed
issues: [1066]
---
- The database now records the writer protocol version, and a server refuses to start when it
  implements an older protocol than the database expects, naming `UPGRADING.md`. The Helm chart uses
  the `Recreate` strategy for `api`, `ingest`, `worker` and `scheduler`, so a plain upgrade no longer
  runs an old and a new writer side by side inside one Deployment. A protocol-changing upgrade
  still needs the full scale-to-zero drain in `UPGRADING.md`, because the four Deployments roll
  independently.
