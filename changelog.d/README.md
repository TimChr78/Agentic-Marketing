# Changelog fragments

Every change adds one small file here instead of editing `CHANGELOG.md`. Parallel branches then
never conflict on the changelog, and a release folds the fragments into one section.

**Contributors and delegates: add a fragment. Do not edit `CHANGELOG.md`.** `scripts/release/prepare.mjs`
does that at release time.

## Format

`changelog.d/<issue>-<slug>.md` — the issue number, a dash, a lower-case slug, `.md`:

```markdown
---
section: Added
issues: [123]
---
- What changed, in the changelog's voice: the user-visible effect, not the implementation.
```

- `section` is required and is one of `Added`, `Changed`, `Fixed`, `Security` or `Removed`.
- `issues` is optional; use `[123, 124]` when a change closes several issues. When it is omitted,
  the number in the file name is used. `changelog.mjs build` records the issues in a hidden
  `<!-- issues: … -->` comment so `close-issues.mjs` can find them.
- The body is one or more `- ` bullets. Sub-bullets may be indented under a bullet.

## Checks and releases

```bash
node scripts/changelog.mjs check     # part of pnpm lint
node scripts/changelog.mjs build 0.13.0 --date 2026-11-08
```

`build` merges the current `## [Unreleased]` section and every fragment into
`## [<version>] - <date>`, keeps the `### Upgrading from …` block, sorts fragments by issue then
file name, writes `CHANGELOG.md` and deletes the consumed fragments. `--dry-run` prints the section
without changing anything.
