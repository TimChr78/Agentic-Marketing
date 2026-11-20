---
section: Fixed
issues: [1159]
---
- The Helm migration Job takes its configuration from a hook ConfigMap and its secrets from the Secret through `envFrom`, in the same order as the role Deployments, so a Secret-backed `CLICKHOUSE_URL` or `VALKEY_URL` is no longer shadowed by the chart default. It also receives `podAnnotations`, `nodeSelector`, `tolerations` and `affinity`, and every suffixed resource name stays within Kubernetes's 63-character limit.
- The `scheduler` Deployment always uses `Recreate`, whatever `upgradeStrategy` says, so a rollout never runs two uncoordinated schedulers.
- A `PodDisruptionBudget` is emitted only when a role's minimum replicas exceed `minAvailable`. With the documented one-replica-per-role sizing no PDB is created, so `kubectl drain` and node upgrades are no longer blocked.
- Upgrade note: the chart removes the PDBs of roles at or below `minAvailable` replicas on `helm upgrade`, and the scheduler strategy becomes `Recreate`. Long release names that could not install before now get valid, suffixed resource names.
