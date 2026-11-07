# Current status

Durable handoff for the agent working on this repository. Update it when a long run starts, when work lands, and at every handoff. A new session should be able to resume from this file alone.

_Last updated: 2026-11-07_

## Now

- **Phase 26 (truthful insights, 0.12.0)** on `feat/phase-26`, tracker #512. Merged: people #510, campaigns #511, server reads #508/#509, analytics #506, journey report #507, agents #509. Remaining: deliverability #508 UI, then integration checks (full suite, e2e, axe, visual baselines), Sol review, PR to `main`, release 0.12.0 (pre-approved by the user once checks and review are green).
- **Process improvements** (user request, 2026-11-07), from the research in `/mnt/user/appdata/t3code/Mixed research/`. Three PRs first, then stop and report:
  1. Determinism kit: `TZ=UTC` in Vitest, seeded RNG helper, `uniqueEvent()`/`uniqueJourney()`, unordered-assertion helper, CLI built once.
  2. Local Playwright runner `scripts/e2e-docker.sh` (smoke, functional, axe, visual, shots) with an `@smoke` subset and role/test-id selectors.
  3. Shared labelled test stack `docker-compose.test.yml` (`am-test=1`) plus `scripts/test-services.sh`, `scripts/preflight.sh`, `scripts/docker-clean.sh`.

## Next

After the three process PRs are green and reported: phase branch with per-delegate draft PRs, affected-test selection, changelog fragments, migration reservation, one-pass release with a verification script. Then Phase 28 (polish pass), skipping Phase 27 for now, as the user asked.

## Blocked / decisions needed

- None blocking.

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

- `main` at `33e858d` (v0.11.0, released and verified).
