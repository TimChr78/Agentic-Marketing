# Phase 24 · screen contracts

Implementation handoff for #444 / tracker #449, targeting 0.10.0. Read with
[DESIGN v2](../DESIGN.md), [inventory](../wave-5-data-inventory.md) and
[wave plan](../../architecture/roadmap-wave-5.md). This is a proposed design for human review,
not a record of approval. No application changes accompany it.

- [Shell and navigation](shell-navigation.md): routes, permissions, redirects and creation/search.
- [Home](home.md): role order, bounded reads and derived setup checklist.
- [Broadcasts](broadcasts.md): reference list/detail and shared template interfaces.
- Offline HTML: [shell](mock/shell.html), [Home](mock/home.html), [Broadcasts](mock/broadcasts.html).
  Each document embeds its CSS, script, icons and both 1440/390 viewport frames. Theme switch
  affects both frames; scenario controls select populated, empty, failure or loading examples.
  Shell also has expanded/rail, Settings and account examples. At 768 use the explicit contracts.

## Exclusive ownership

All paths below are relative to `apps/web/src/`. Existing files keep their current physical
paths even when their public URLs change. Do not rename directories during this phase.

| Task | Exclusive files/components |
|---|---|
| S · #446 navigation/shell | `app/Shell.tsx`, `app/nav.ts`, `app/routes.tsx`, `app/artifactRoutes.ts`, `app/SearchPalette.tsx`, `app/prefs.ts`; new `app/NewMenu.tsx`, `app/recents.ts`, `app/redirects.ts`, `app/createIntent.ts`, `ui/SettingsLayout.tsx`, `pages/settings/SettingsPage.tsx`, `pages/PreferencesPage.tsx`, `pages/CreatePage.tsx`; route/IA tab adapters in `pages/audience/{PeoplePage,ConsentPage}.tsx`, `pages/design/{TemplatesPage,BrandPage}.tsx`, `pages/settings/{AgentsPage,ApprovalPolicyPage}.tsx`, `pages/insights/{AnalyticsPage,JourneyStatsPage}.tsx`, and existing `pages/build/{RecipesPage,CampaignsPage,JourneysPage,ExperiencesPage,SegmentsPage,FormsPage,PromptsPage}.tsx`. S owns route tests and wrappers for the merged legacy pages. |
| H · #447 Home/checklist | New `pages/HomePage.tsx`, `features/home/*` (including `HomeSection`, `HomeKpis`, `OnboardingChecklist`, `useHomeData`); Home tests. H never edits routing, Shell, navigation or shared templates. |
| B · #448 Broadcasts pair | Existing `pages/build/{BroadcastsPage,BroadcastPage}.tsx`, `features/artifacts/{ArtifactDetailPage,BroadcastState,BroadcastStatus}.tsx`; new `features/broadcasts/*`, `ui/ListPage.tsx`, `ui/DetailPage.tsx`; template/broadcast tests. B alone owns ArtifactDetailPage. New optional slots must preserve other artifact families' existing behaviour. |
| R · #445 prerequisite read additions | Server/package schemas, handlers, registry and command/API catalogue/type generation: B1 broadcasts.list including delivery, B2 agents.runFailures, B7 approvals.list total/cursor. No UI files. |

Shared foundations `ui/charts.tsx`, `ui/state.tsx`, `lib/state.ts`, `lib/labels.ts`, showcase
and DESIGN.md are **frozen inputs** for S/H/B: no competing chart contracts, state heuristics
or label registries. Use existing exports. If an actual mismatch prevents implementation,
record it and resolve centrally before editing these files. S alone adjusts `ui/layout.ts`
if necessary to enforce the v2 1280 cap. Tests outside owned files need coordination first.

## Shared components and sequencing

1. R publishes exact additive types from the inventory plus the B1 `delivery` clarification in
   broadcasts.md. Do not fake these responses or restore per-row status fan-out while waiting.
2. S publishes canonical route constants, redirects and create-intent URL parser first, wires
   lazy imports for H's `pages/HomePage.tsx` and B's existing Broadcast pages, then owns all
   shell integration. H exports a default page; B preserves existing default exports.
3. B creates the pure ListPage and DetailPage view templates specified in broadcasts.md. H
   does not depend on them; it uses existing PageHeader/KpiTile and its own HomeSection.
4. S owns SettingsLayout, NewMenu and recents; all feature pages consume routes via
   artifactPath, never write their own legacy redirects. S's create intents open the existing
   create flows; B consumes `?create=broadcast` on its list. Other family create adapters are
   S-owned. B adds only backwards-compatible optional detail slots. Merged page adapters can
   compose existing legacy bodies without asking B to modify ArtifactDetailPage.
5. Integrate R → S's route seam → H and B independently. Validate all role/deep-link cases,
   1440/768/390, both themes and keyboard operation. One task cannot reassign another's files.

## Baseline and scope

Current reference screenshots are in `e2e/visual.spec.ts-snapshots/`: `people`, `workspace`,
`journeys`, `approvals`, `broadcast`, `approval-broadcast`, `template`, each with
`-{1440,390}-{light,dark}-linux.png`. These are integrated v2 baselines, not target mock-ups;
magenta regions are privacy masks. Shell contract starts from People/Workspace; Home starts
from the current `/` redirect to Approvals; Broadcast detail starts from `broadcast-*`.
No screenshot capture is required to implement the static documentation.

Acceptance: redirects retain query/hash and IDs, no widened permissions, no N+1 Home reports,
no zero substituted for unknown, no new pause/recovery/assignment/onboarding-history semantics.
Phase 25 owns the deeper compose/review/send workflow and link ranking; Phase 26 owns richer
reports. Existing mutations may be linked/reused, never expanded. Browser storage for navigation,
recents and checklist dismissal is a device preference, not new server storage or telemetry.

## Verification notes

The wave plan’s written destination total is off by one: its explicit groups enumerate
18 work pages plus Settings (19 total). This contract keeps that enumeration; see the
count correction in shell-navigation.md. No extra destination is introduced.

Static validation checks embedded script syntax, v2 token parity, two exact frame widths,
o external resources, and local Markdown links. Host HTML preview could not take screenshots:
T3 reported missing browser system libraries. Inline rendering remains available, but this is
not a claim of browser or accessibility approval. Run the integrated Phase 23 visual/axe matrix
when the implementation lands; docs-only work does not need the application test suite.
