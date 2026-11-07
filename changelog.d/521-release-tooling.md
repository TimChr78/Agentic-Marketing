---
section: Changed
issues: [521]
---
- Releases are one pass instead of a checklist: `scripts/release/prepare.mjs` bumps every version surface (including the README default and release line), folds `changelog.d/` fragments and `## [Unreleased]` into the version section, generates the `### Upgrading from …` block from migrations and `.env.example`, records new variables in `ENV_SINCE`, and runs `check-versions.mjs`. `scripts/release/verify.sh` checks a published release's checksums, attestations and both image platforms, and `scripts/release/close-issues.mjs` closes the issues the release still owes. Contributors and delegates now add a fragment under `changelog.d/` instead of editing `CHANGELOG.md`, so parallel merges no longer conflict on the changelog.
