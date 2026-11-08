# Phase 28 · release evidence (0.14.0)

Assembled by task I (#555) on the integrated phase head. The contract, ownership lists and gates are
in [README](README.md). Record the exact SHA, fixture and command for every run; a checked box needs
an artifact, not an assertion.

Status: **in progress**. The five area tasks land after this foundations branch; their findings below
are report-mode until each owner flips its own section to strict.

## Commands and exit codes

| Check | Command | Exit | Notes |
| --- | --- | ---: | --- |
| Web unit tests | `npx vitest run --project web` | 0 | 95 files, 964 tests passed |
| Docs tests | `npx vitest run --project docs` | 0 | 6 files, 38 tests passed |
| Live build | `corepack pnpm --filter @agentic-marketing/web build:live` | 0 | manifest at `apps/web/dist/.vite/manifest.json` |
| Bundle budgets | `npx vitest run --project web apps/web/test/phase28-bundle.test.ts` | 0 | decimal gzip kB; 140 tests |
| Lint | `npx biome check .` | 0 | 32 pre-existing warnings, no errors |
| Typecheck | `corepack pnpm -r --filter './packages/*' --filter './apps/*' typecheck` | 0 | |
| Changelog | `node scripts/changelog.mjs check` | 0 | 1 fragment |
| Smoke e2e | `TEST_PORT_OFFSET=100 scripts/e2e-docker.sh smoke` | 0 | 7 passed |
| Phase 28 functional | `TEST_PORT_OFFSET=100 E2E_SKIP_BUILD=1 scripts/e2e-docker.sh functional e2e/phase28-*.spec.ts` | 0 | 13 passed, 32 skipped (area-owned reporting tests) |
| Axe | `TEST_PORT_OFFSET=100 E2E_SKIP_BUILD=1 scripts/e2e-docker.sh axe` | 0 | 43 passed, 2 skipped; 0 violations, 0 allowlist entries |
| Visual | `TEST_PORT_OFFSET=100 E2E_SKIP_BUILD=1 scripts/e2e-docker.sh visual` | 0 | 12 routes passed; no baseline changed |

## Bundle actuals

Manifest-derived closures, decimal gzip kB, JS and CSS, each file compressed individually.
“Initial” is the common signed-in entry/Root/Shell/route-table closure; “lazy” is the route module
and its automatically mounted children; “cold” is their sum. Ceilings are from
[skeletons and budgets](skeletons-and-budgets.md); no ceiling was raised.

<!-- phase28-bundle:start -->
Measured from `apps/web/dist/.vite/manifest.json` after
`corepack pnpm --filter @agentic-marketing/web build:live` on this branch.

- Signed-out initial (entry + Root + eagerly needed auth screens): **108.55 kB** (cap 110).
- Signed-in initial (entry + Root + Shell + route table): **129.27 kB** (cap 150).
- Auth screens add no separate lazy closure in this build; they are inside the signed-out initial.

| Route | Initial | Lazy | Cold | Cap |
| --- | ---: | ---: | ---: | ---: |
| `/` | 129.27 | 14.77 | 144.04 | 25 |
| `/approvals` | 129.27 | 6.37 | 135.63 | 25 |
| `/approvals/:id` | 129.27 | 36.26 | 165.53 | 70 |
| `/work/agents` | 129.27 | 27.05 | 156.32 | 35 |
| `/work/agents/:id` | 129.27 | 36.93 | 166.19 | 45 |
| `/work/agents/library/:id` | 129.27 | 26.78 | 156.04 | 35 |
| `/marketing/campaigns` | 129.27 | 8.50 | 137.76 | 20 |
| `/marketing/campaigns/:id` | 129.27 | 31.70 | 160.96 | 45 |
| `/marketing/broadcasts` | 129.27 | 12.21 | 141.48 | 25 |
| `/marketing/broadcasts/:id` | 129.27 | 49.99 | 179.26 | 80 |
| `/marketing/journeys` | 129.27 | 8.71 | 137.97 | 20 |
| `/marketing/journeys/:id` | 129.27 | 105.79 | 235.06 | 130 |
| `/marketing/experiences` | 129.27 | 9.06 | 138.32 | 20 |
| `/marketing/experiences/:id` | 129.27 | 26.83 | 156.10 | 40 |
| `/audience/people` | 129.27 | 14.04 | 143.30 | 30 |
| `/audience/people/:id` | 129.27 | 11.69 | 140.95 | 30 |
| `/audience/segments` | 129.27 | 9.75 | 139.01 | 20 |
| `/audience/segments/:id` | 129.27 | 33.46 | 162.73 | 40 |
| `/audience/forms` | 129.27 | 9.75 | 139.02 | 20 |
| `/audience/forms/:id` | 129.27 | 30.03 | 159.30 | 40 |
| `/audience/consent` | 129.27 | 11.00 | 140.26 | 40 |
| `/content/templates` | 129.27 | 12.72 | 141.99 | 35 |
| `/content/templates/blocks/:id` | 129.27 | 23.95 | 153.22 | 40 |
| `/content/templates/:id` | 129.27 | 40.55 | 169.82 | 65 |
| `/content/assets` | 129.27 | 6.06 | 135.33 | 25 |
| `/content/brand` | 129.27 | 30.81 | 160.08 | 40 |
| `/insights/analytics` | 129.27 | 16.93 | 146.20 | 40 |
| `/insights/messages` | 129.27 | 3.45 | 132.72 | 20 |
| `/insights/deliverability` | 129.27 | 9.94 | 139.21 | 35 |
| `/insights/alerts` | 129.27 | 7.38 | 136.65 | 30 |
| `/settings` | 129.27 | 0.28 | 129.54 | 20 |
| `/settings/workspace` | 129.27 | 3.29 | 132.56 | 20 |
| `/settings/providers` | 129.27 | 14.94 | 144.21 | 40 |
| `/settings/integrations` | 129.27 | 16.52 | 145.79 | 55 |
| `/settings/integrations/tokens/:id` | 129.27 | 16.52 | 145.79 | 55 |
| `/settings/secrets` | 129.27 | 3.71 | 132.97 | 20 |
| `/settings/users` | 129.27 | 5.33 | 134.60 | 25 |
| `/settings/approval-policy` | 129.27 | 5.04 | 134.31 | 25 |
| `/preferences` | 129.27 | 2.88 | 132.14 | 20 |
| `/create` | 129.27 | 5.05 | 134.32 | 20 |
| `/artifacts/:id` | 129.27 | 21.20 | 150.47 | 130 |

Additional closures, measured as increments over the signed-in initial:

| Renderer / action | Gzip | Cap |
| --- | ---: | ---: |
| ECharts (`ChartImpl`) | 368.50 | 400 |
| Visual e-mail authoring (`VisualMjml` + lib + CSS) | 690.41 | 1,120 |
| Broadcast report action (`ReportEntry`) | 6.55 | 30 |
| Demo fixture closure (`DemoRoot` + fixtures) | 14.71 | 25 |

Analytics with its automatically mounted chart is **514.70 kB** (cap 590).
Deliverability with a chart is **507.70 kB** (cap 585).
Journey Report is **603.56 kB** (cap 680).
Template with the automatically mounted visual editor is **860.27 kB** (cap 1,335).

No ceiling was raised. Seven routes were over their ceilings before this landing because the shared
detail page eagerly imported the preview stack and structured editors. Those imports now load through
the detail page's own Suspense boundary, so the affected routes stay inside their published caps
without changing what the page offers.
<!-- phase28-bundle:end -->

Signed-out initial closure (entry + Root + the auth screens it needs eagerly) is recorded with the
build run below; it must stay at or under 110 kB.

## Motion and reserved states

- Duration tokens: `--duration-fast` 120 ms, `--duration-enter` 180 ms; easing `--ease` and
  `--ease-feedback`. Tailwind's implicit transition duration is bound to `--duration-fast`.
- Reduced motion removes animation, transform-based entrances and all durations/delays, and sets
  scroll behaviour to `auto`.
- Removed as unreachable in the real and demo shell: `.flash-in` (1.2 s background flash) and
  `.sim-active` (`pulse-ring` 1 s infinite). No source or demo fixture referenced either selector;
  the only definitions were in `index.css`.
- The spinner is now the static `.am-progress` glyph under the existing button busy semantics; the
  shimmer keyframes are gone and skeletons are static tonal shapes.
- Reserved geometry API: `Skeleton`, `SkeletonRegion`, `ListSkeleton`, `DetailSkeleton`,
  `ChartSkeleton`, `KpiSkeleton`, `EditorSkeleton`, and the `LoadingBlock` adapter. The slot is
  reserved immediately and the shapes reveal after `SKELETON_DELAY_MS` (150 ms). Callers pass
  geometry, the object-specific label and the busy state; the primitive never fetches.

## Microcopy lint

Report mode: raw seeded ids, metric keys, purpose keys and the banned patterns from
[microcopy](microcopy.md). I-owned findings must be zero; W/M/A/C/S findings are handed to their
owners. Narrow exceptions: the friendly-name registry in `lib/labels.ts`, the Identifier copy
control, the developer JSON view and preview source parsing.

<!-- phase28-microcopy:start -->
### I · 0 findings

None.

### W · 0 findings

None.

### M · 0 findings

None.

### A · 0 findings

None.

### C · 0 findings

None.

### S · 0 findings

None.

<!-- phase28-microcopy:end -->

## Accessibility, mobile and roles

- 390 px: `e2e/phase28-mobile.spec.ts` checks page-level horizontal overflow for every nav route.
- States: `e2e/phase28-states.spec.ts` checks the shared skeleton (reserved geometry, 150 ms reveal,
  no layout shift), empty and error patterns.
- Roles: `e2e/phase28-roles.spec.ts` exercises the builder, approver and viewer core flows.
- Area-owned routes start as `test.fixme` with the owning task letter; I-owned auth, shell and shared
  surfaces must pass now.

## Baseline changes

Regenerate only the baselines this branch actually moves, with
`scripts/e2e-docker.sh update -g "<route> matches"`, and list each one here for human review.

<!-- phase28-baselines:start -->
None. All 12 committed visual routes matched their existing baselines after the shared CSS changes
(static skeletons, token durations, static progress glyph); no `update` run was needed.
<!-- phase28-baselines:end -->
