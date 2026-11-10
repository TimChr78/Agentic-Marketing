---
section: Fixed
issues: [645, 649, 654]
---
- The Helm chart no longer puts a container port and HTTP probes on the `worker` and `scheduler` roles, which never open a listener; those pods can pass readiness and `helm upgrade --wait` no longer times out or rolls back.
- A single `port` value now drives the ConfigMap's `PORT`, the container port, the Service target and the probes, and setting `config.PORT` no longer renders a duplicate ConfigMap key.
- Scheduled backups verify each backup they write, so the optional backup service's `am backup --health` becomes healthy after a good run and unhealthy after a failed verification instead of waiting for a manual `am backup --verify`.
