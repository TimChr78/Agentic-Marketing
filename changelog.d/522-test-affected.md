---
section: Changed
---

- `pnpm test:affected` runs only the Vitest tests a change can reach (`scripts/test-affected.mjs`, with `--print` to show the selection and why). Migrations, test configuration, dependencies, workflows and any unclassified path still select the full suite; CI keeps running everything.
