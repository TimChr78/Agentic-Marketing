# Current status

Durable handoff for the agent working on this repository. Update it when a long run starts, when work lands, and at every handoff. A new session should be able to resume from this file alone.

_Last updated: 2026-11-07 (evening)_

## Now

- **0.12.0 released** (Phase 26, truthful insights). Tag `v0.12.0` on `f64fdcc`. Checksums and attestations for the chart, Compose bundle and image are verified. Tracker #512 is closed.
- **Process improvements** (user request, 2026-11-07), from the research in `/mnt/user/appdata/t3code/Mixed research/`:
  1. Determinism kit: **in progress** (DeepSeek task on `process/determinism-kit`).
  2. Local Playwright runner: **#516**, updated from `main`. The People smoke spec now follows the Phase 26 labels, and smoke passed locally through the runner. A CI test-job rerun was needed after a service `curl` blip.
  3. Shared labelled test stack: **#515**, updated from `main`, green.
  - Once all three are green, Sol reviews them together, then they merge. Then stop and report, and recommend whether more Docker/Unraid tuning is worth it before the next phase.

## Next

- After the three process PRs: either the second process batch (phase branch with per-delegate draft PRs, affected-test selection, changelog fragments, migration reservation, one-pass release and verification script) or Phase 27. The user decides after the report.

## Blocked / decisions needed

- None blocking.

## Lessons from Phase 26 (feed the process work)

- **CHANGELOG conflicts.** Every parallel merge conflicted, and section headings got scrambled twice, so they had to be regrouped by hand. Changelog fragments fix this.
- **Flakes under host load.** Four web tests used Testing Library's 1 s default wait, which load exceeded. The web project now has a 5 s async timeout. One test was racing a lazy-module import, and two campaign tests asserted counts before an independent chain had settled.
- **Visual masks.** A mask takes the size of the text it covers, so volatile values need a fixed placeholder before masking. People cards on phones need masking too.
- **Visual baselines** must come from a fresh seed that has only had the visual run. A prior functional run leaves e2e agents in the list.
- **Delegates dropping features.** They removed existing features (hosted, guardian and shadow controls, Create mandate, pasted profile ids) to meet read budgets. Review for lost functionality on every rewrite.
- **Jargon in the UI.** Implementation wording ("reads", "lanes", "k-suppression field") leaked into the interface. A copy check belongs in review.
- **CI blips.** Two network failures (postgresql.org key download, service `curl`). Rerun the failed job; do not change code.

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
