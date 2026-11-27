---
section: Fixed
issues: [1268]
---
- `scripts/preflight.sh` now derives the Playwright image tag from the pinned `@playwright/test` version, like `scripts/e2e-docker.sh` and CI, so a dependency bump no longer leaves the disk and port checks pointing at the previous image. `E2E_IMAGE` overrides it for a deliberate pin.
