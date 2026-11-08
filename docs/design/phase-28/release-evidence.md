# Phase 28 · release evidence (0.14.0)

Assembled by task I (#555) on the integrated phase head. The contract, ownership lists and gates are
in [README](README.md). Record the exact SHA, fixture and command for every run; a checked box needs
an artifact, not an assertion.

Status: **in progress**. The five area tasks land after this foundations branch; their findings below
are report-mode until each owner flips its own section to strict.

## Commands and exit codes

| Check | Command | Exit | Notes |
| --- | --- | ---: | --- |
| Web unit tests | `npx vitest run --project web` | pending | |
| Docs tests | `npx vitest run --project docs` | pending | |
| Live build | `corepack pnpm --filter @agentic-marketing/web build:live` | pending | manifest at `apps/web/dist/.vite/manifest.json` |
| Bundle budgets | `npx vitest run --project web apps/web/test/phase28-bundle.test.ts` | pending | decimal gzip kB |
| Lint | `npx biome check .` | pending | |
| Typecheck | `corepack pnpm -r --filter './packages/*' --filter './apps/*' typecheck` | pending | |
| Changelog | `node scripts/changelog.mjs check` | pending | |
| Smoke e2e | `TEST_PORT_OFFSET=100 scripts/e2e-docker.sh smoke` | pending | |
| Phase 28 functional | `TEST_PORT_OFFSET=100 E2E_SKIP_BUILD=1 scripts/e2e-docker.sh functional e2e/phase28-*.spec.ts` | pending | reporting specs mark area routes `fixme` |
| Axe | `TEST_PORT_OFFSET=100 E2E_SKIP_BUILD=1 scripts/e2e-docker.sh axe` | pending | |
| Visual | `TEST_PORT_OFFSET=100 E2E_SKIP_BUILD=1 scripts/e2e-docker.sh visual` | pending | review changed baselines by eye |

## Bundle actuals

Manifest-derived closures, decimal gzip kB, JS and CSS, each file compressed individually.
“Initial” is the common signed-in entry/Root/Shell/route-table closure; “lazy” is the route module
and its automatically mounted children; “cold” is their sum. Ceilings are from
[skeletons and budgets](skeletons-and-budgets.md); no ceiling was raised.

<!-- phase28-bundle:start -->
Measured from `apps/web/dist/.vite/manifest.json` after
`corepack pnpm --filter @agentic-marketing/web build:live` on this branch.

- Signed-out initial (entry + Root + eagerly needed auth screens): **108.53 kB** (cap 110).
- Signed-in initial (entry + Root + Shell + route table): **129.25 kB** (cap 150).
- Auth screens add no separate lazy closure in this build; they are inside the signed-out initial.

| Route | Initial | Lazy | Cold | Cap |
| --- | ---: | ---: | ---: | ---: |
| `/` | 129.25 | 14.77 | 144.02 | 25 |
| `/approvals` | 129.25 | 6.37 | 135.62 | 25 |
| `/approvals/:id` | 129.25 | 36.26 | 165.51 | 70 |
| `/work/agents` | 129.25 | 27.05 | 156.30 | 35 |
| `/work/agents/:id` | 129.25 | 36.93 | 166.18 | 45 |
| `/work/agents/library/:id` | 129.25 | 26.76 | 156.01 | 35 |
| `/marketing/campaigns` | 129.25 | 8.50 | 137.75 | 20 |
| `/marketing/campaigns/:id` | 129.25 | 31.68 | 160.93 | 45 |
| `/marketing/broadcasts` | 129.25 | 12.21 | 141.46 | 25 |
| `/marketing/broadcasts/:id` | 129.25 | 49.98 | 179.23 | 80 |
| `/marketing/journeys` | 129.25 | 8.70 | 137.96 | 20 |
| `/marketing/journeys/:id` | 129.25 | 105.77 | 235.02 | 130 |
| `/marketing/experiences` | 129.25 | 9.05 | 138.31 | 20 |
| `/marketing/experiences/:id` | 129.25 | 26.81 | 156.06 | 40 |
| `/audience/people` | 129.25 | 14.03 | 143.28 | 30 |
| `/audience/people/:id` | 129.25 | 11.68 | 140.93 | 30 |
| `/audience/segments` | 129.25 | 9.74 | 139.00 | 20 |
| `/audience/segments/:id` | 129.25 | 33.44 | 162.69 | 40 |
| `/audience/forms` | 129.25 | 9.74 | 139.00 | 20 |
| `/audience/forms/:id` | 129.25 | 30.01 | 159.26 | 40 |
| `/audience/consent` | 129.25 | 11.00 | 140.25 | 40 |
| `/content/templates` | 129.25 | 12.72 | 141.97 | 35 |
| `/content/templates/blocks/:id` | 129.25 | 23.94 | 153.19 | 40 |
| `/content/templates/:id` | 129.25 | 40.52 | 169.78 | 65 |
| `/content/assets` | 129.25 | 6.06 | 135.31 | 25 |
| `/content/brand` | 129.25 | 30.79 | 160.04 | 40 |
| `/insights/analytics` | 129.25 | 16.93 | 146.19 | 40 |
| `/insights/messages` | 129.25 | 3.45 | 132.71 | 20 |
| `/insights/deliverability` | 129.25 | 9.94 | 139.19 | 35 |
| `/insights/alerts` | 129.25 | 7.38 | 136.63 | 30 |
| `/settings` | 129.25 | 0.28 | 129.53 | 20 |
| `/settings/workspace` | 129.25 | 3.29 | 132.55 | 20 |
| `/settings/providers` | 129.25 | 14.94 | 144.19 | 40 |
| `/settings/integrations` | 129.25 | 16.52 | 145.77 | 55 |
| `/settings/integrations/tokens/:id` | 129.25 | 16.52 | 145.77 | 55 |
| `/settings/secrets` | 129.25 | 3.71 | 132.96 | 20 |
| `/settings/users` | 129.25 | 5.33 | 134.59 | 25 |
| `/settings/approval-policy` | 129.25 | 5.04 | 134.30 | 25 |
| `/preferences` | 129.25 | 2.88 | 132.13 | 20 |
| `/create` | 129.25 | 5.06 | 134.31 | 20 |
| `/artifacts/:id` | 129.25 | 21.19 | 150.44 | 130 |

Additional closures, measured as increments over the signed-in initial:

| Renderer / action | Gzip | Cap |
| --- | ---: | ---: |
| ECharts (`ChartImpl`) | 368.50 | 400 |
| Visual e-mail authoring (`VisualMjml` + lib + CSS) | 690.41 | 1,120 |
| Broadcast report action (`ReportEntry`) | 6.55 | 30 |
| Demo fixture closure (`DemoRoot` + fixtures) | 14.71 | 25 |

Analytics with its automatically mounted chart is **514.68 kB** (cap 590).
Deliverability with a chart is **507.69 kB** (cap 585).
Journey Report is **603.52 kB** (cap 680).
Template with the automatically mounted visual editor is **860.19 kB** (cap 1,335).

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

### W · 2 findings

- `apps/web/src/features/agents/HostedAgentCard.tsx:237` **generic-error** — Error
- `apps/web/src/pages/approvals/ApprovalsPage.tsx:154` **generic-error** — Loading

### M · 1 finding

- `apps/web/src/features/artifacts/ExperienceEditor.tsx:267` **purpose-key** — Traits, segments and session conditions need web_personalization consent; page, referrer, UTM and device do not.

### A · 1 finding

- `apps/web/src/pages/audience/ImportsPage.tsx:101` **purpose-key** — The purpose must be a lowercase key such as marketing_email.

### C · 2 findings

- `apps/web/src/features/phase27/content/ContentList.tsx:294` **generic-error** — Loading
- `apps/web/src/features/phase27/content/ContentList.tsx:302` **generic-error** — Loading

### S · 2 findings

- `apps/web/src/features/deliverability/model.ts:99` **no-data** — No data
- `apps/web/src/features/tokens/TokensCard.tsx:38` **banned-copy** — No client has sent unknown input keys for 7 days: it's safe to set

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
None recorded yet.
<!-- phase28-baselines:end -->
