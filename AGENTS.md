# Agent notes

How this repository is built, tested and released is in [docs/development.md](docs/development.md);
read it before your first change. This page lists only the rules that are easy to get wrong.

## Tests

- Never run `pnpm test` or the whole `server` project. Run the file you touched:
  `npx vitest run --project <docs|packages|web|server> <path/to/file.test.ts>`.
  `pnpm test:affected:print` shows what a change selects against `origin/main`.
- Every Vitest project runs with `TZ=UTC`. Do not let a test depend on the host time zone.
- Test first: add the failing test, then the fix.
- The services come from the shared test stack: `eval "$(scripts/test-services.sh env)"`. Never run
  `scripts/test-services.sh up` (another agent owns the stack). Give your run its own
  `TEST_PORT_OFFSET`, and set `TEST_WORKERS=1` while other agents are running.
- The migrated template databases are kept on purpose (setup never prunes them). Drop the old ones
  with `pnpm test:clean -- --templates` when no test run is active.
- Never `git stash`.

## Before pushing

Lint, typecheck and the docs project, in one command:

```bash
pnpm lint && pnpm typecheck && npx vitest run --project docs
```

## Changes

- Add a changelog fragment under `changelog.d/` (`<issue>-<slug>.md` with `section:` front matter),
  never edit `CHANGELOG.md`, and never put a version number in a fragment.
- A new migration head goes into `MIGRATION_RELEASES` in `packages/db/src/migrate.ts`. A new table
  also goes into the owned-table lists in `packages/db/test/sent-at-migration.test.ts` and
  `packages/db/test/suppressions-delete.test.ts`: both migrate as a non-superuser owner with FORCE
  RLS, which is how a small install runs.
- Redaction (`packages/core/src/diagnostics.ts`) may only redact more, never less. A new pass runs
  after the release's rules have settled, and `packages/core/test/redaction-differential.test.ts`
  checks the result differentially against the vendored 0.14.20 and 0.14.23 redactors.

## Repo-wide guards — run them when you touch…

| Change | Guards (run with `npx vitest run --project <project> <path>`) |
|---|---|
| routes or request bodies | `apps/server/test/body-limits.test.ts` |
| migrations | `packages/db/test/migrate.test.ts`, `packages/db/test/sent-at-migration.test.ts`, and the owned-table lists in `packages/db/test/suppressions-delete.test.ts` |
| environment variables | `apps/server/test/deploy-config.test.ts` and `apps/server/test/env-reads.test.ts` |
| error text stored or returned | `packages/core/test/error-text-bounds.test.ts` |
| command descriptions or outputs | `npx vitest run --project docs` and `npx tsx scripts/gen-mcp-tools.ts` |

## CodeQL patterns

- Never put an end-anchored (`$`) or `\s*`-sticky regex on uncontrolled text. A backtracking pattern
  can pin the event loop; write a hand-written scan and keep it linear.
- Never hash a password with a plain digest, not even in test tooling. A fingerprint must leave
  secrets out rather than "protect" them.

Secrets never go into a commit, a log line or a test fixture.
