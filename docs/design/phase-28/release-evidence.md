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
Pending a live build.
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
