# Current status

Durable handoff for the agent working on this repository. Update it when a long run starts, when work lands, and at every handoff. A new session should be able to resume from this file alone.

_Last updated: 2026-11-07 (night)_

## Now

- **Process batch 1 is merged** (2026-11-07). Each item was reviewed by Sol, re-checked after its fixes, and passed CI:
  - **#515 — shared labelled test stack.**
    - `docker-compose.test.yml` (label `am-test=1`), `scripts/test-services.sh`, `scripts/preflight.sh` and `scripts/docker-clean.sh`.
    - `AM_TEST_RUN` and `scopedDbName()` / `packages/db/test/print-db.ts` give each run its own names.
    - `TEST_PORT_OFFSET` with `e2e/ports.ts`.
    - A run-scoped `test:clean`.
  - **#518 — determinism kit.**
    - `TZ=UTC`, plus the `test-support/` helpers: a seeded RNG, `uniqueEvent`/`uniqueJourney` and `expectUnordered`.
    - The CLI is bundled once per run with source-path parity. The CLI test went from 396 s, with timeouts, to 110–170 s.
    - The packages worker cap.
  - **#516 — local Playwright runner.** `scripts/e2e-docker.sh` with smoke/functional/axe/visual/update/shots and an `@smoke` subset, plus the exact-selector lint.
  - **Alongside these:** the curl retries for the PostgreSQL key (#519 and CI), the web 5 s async timeout, and `settle()` now waits for the journey canvas nodes.
- **Waiting for the user:** a decision on the recommendation below (host setup, then batch 2 or Phase 27).

## Next

- **Recommended:** a short host-setup step, then a trimmed batch 2, then Phase 27.
  - Batch 2 is: changelog fragments, per-delegate draft PRs against the phase branch, affected-test selection, and a release script with verification.
  - Migration reservation is deferred; the Wave 5 UI phases rarely add migrations.

## Blocked / decisions needed

- **Host:** this Unraid host has no persistent Docker Compose, so `scripts/test-services.sh` cannot start the shared stack. The user needs to install the Compose plugin, or approve a pinned `docker-compose` binary under `/mnt/user/appdata`.
- **Containers:** `am-patch-test-*` (four containers, not ours) is still running. Remove it only with the user's OK.
- **Disk:** 33 GB of unused Docker volumes are reclaimable. Prune only with the user's OK; `docker-clean.sh` only touches `am-test` resources.

## Baseline (2026-11-07, before the process work)

| Measure | Value |
|---|---|
| Full Vitest suite, local (`TEST_WORKERS=2`) | ~10 min; CI ~10 min for `test:ci` |
| Web project alone | ~1 min (522 tests); flaky timeouts when delegates run tests in parallel on the host |
| E2E functional + axe (Playwright image) | ~5–7 min plus ~30–90 s seed; hand-assembled `docker run` each time |
| Visual check | ~1 min for 12 routes × 4 variants |
| Per-delegate test stack | 4 containers per task (`tNNN-*`), named by hand; orphaned stacks found |
| Docker | 157 volumes, 32.75 GB reclaimable |
| CHANGELOG conflicts | every merge of a parallel task in Phases 25 and 26 |

## Recurring failures the process work targets

- Order and shared-state flakes: shared journey trigger events (#503, earlier 0.2.10/0.3.0), unordered results asserted in order (0.4.0).
- Time-zone-dependent results; no `TZ` pinned in Vitest.
- CLI tests compile the CLI per call (226–291 s under load).
- E2E: no runner script; server start/stop by hand, stale seeded servers, the kill-by-pattern that killed the shell; loose `getByLabel` selectors.
- Test stacks: per-delegate stacks with hand-picked ports, no labels, orphaned containers, disk pressure. Test database names are fixed per file (`am_<name>`), so two checkouts cannot share one stack safely.
- Environment drift: `/tmp` wiped between sessions (pnpm shim, env file), commands that fail silently.

## Last green

- `main` at `f64fdcc` (v0.12.0, released and verified).
