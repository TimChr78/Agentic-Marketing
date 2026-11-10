---
section: Changed
issues: [602, 603, 604, 606, 648]
---
- Release tooling is crash-safe and honest: changelog folding is atomic and retry-safe, `close-issues` fetches and verifies the predecessor tag before widening a range, generated migration lists include only added files, e2e helper and Playwright config changes suggest every suite instead of smoke alone, and a tag push and a manual run of the same version share one release concurrency group. `scripts/open-task-pr.sh` also accepts `patch/<x.y.z>` integration branches.
