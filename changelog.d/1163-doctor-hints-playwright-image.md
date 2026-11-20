---
section: Fixed
issues: [1163]
---
- `am doctor`'s queue-lag hints suggest `docker compose logs app` (Compose runs every role in the `app` service) and keep the Kubernetes worker-pod note.
- `scripts/e2e-docker.sh` derives its Playwright image from the pinned `@playwright/test` version, as CI does, instead of a hard-coded tag.
