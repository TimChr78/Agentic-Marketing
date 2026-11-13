---
section: Security
issues: [892]
---

- The e-mail editor's transitive `uuid` dependency is pinned to 11.1.1 (GHSA-w5hq-g745-h8pq, CVE-2026-41907, Dependabot alert 9). The flaw is a missing bounds check in `v3`/`v5`/`v6` when a caller passes its own buffer; the editor only calls `v4()` without one, so it was not reachable, but the vulnerable versions are gone from the lockfile.
