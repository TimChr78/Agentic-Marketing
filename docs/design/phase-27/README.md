# Phase 27 · screen contracts

Design handoff for #524, Wave 5 #439; builds #525–#530, based on Phase 26 / 0.12.0.
Read with [DESIGN v2](../DESIGN.md), [decisions](../DECISIONS.md),
[inventory](../wave-5-data-inventory.md), [Phase 24](../phase-24/README.md),
[Phase 25](../phase-25/README.md), [Phase 26](../phase-26/README.md) and
[wave plan](../../architecture/roadmap-wave-5.md). Docs only; proposed for human review.

- [Audience and marketing](audience-marketing.md) · #525 — [offline mock](mock/audience-marketing.html).
- [Content](content.md) · #526 — [offline mock](mock/content.html).
- [Settings and providers](settings.md) · #527 — [offline mock](mock/settings.html).
- [Journey builder](journey-builder.md) · #528 — [offline mock](mock/journey-builder.html).
- [Recipient surfaces](recipients.md) · #529 — [offline mock](mock/recipients.html).
- [Demo parity](demo.md) · #530 — [offline mock](mock/demo.html).

[Shared acceptance and exact host reads](shared.md) is binding on all six contracts.
[Source inventory](inventory.md) records current page/editor fields, actions, tabs and states with
source locations and destination rules. The contracts add human decisions to that ledger; neither
may be dropped to satisfy a call budget. Each mock embeds independent 1440/768/390 frames, light/dark,
screen and scenario controls. All fixtures are design examples, never live evidence. No external
fonts/assets/requests/storage; controls do not execute commands. Recipient examples are inside an
admin review shell so every mock shows the real grouped navigation; public pages themselves have
no admin shell. Screen selector is a review control, not a proposed product control.

## Exclusive ownership

Paths relative to apps/web/src unless prefixed. Includes imports and existing tests alongside
owned modules. New namespaces grant no ownership over shared files. Every task owns its
`changelog.d/<issue>-*.md` fragment and new tests in its namespace.

| Task | Exclusive existing files | New files / tests |
|---|---|---|
| A · #525 | pages/build/{Forms,Form,Segments,Segment,Experiences,Experience,Topics}Page.tsx; pages/audience/ConsentPage.tsx; pages/insights/AlertsPage.tsx; pages/settings/PurposesPage.tsx; features/artifacts/{FormEditor,SegmentEditor,ListAudiencePanel,ExperienceEditor,ExperienceResults,PurposesEditor}.tsx; features/content/TopicsTable.tsx | features/phase27/audience/* |
| C · #526 | pages/design/*Page.tsx; pages/build/RecipesPage.tsx; features/templates/TemplateEditor.tsx; features/blocks/{BlockEditor,BlockUsage,BlockPicker}.tsx; features/brand/BrandEditor.tsx | features/phase27/content/* |
| S · #527 | pages/settings/{Settings,Workspace,Providers,Integrations,Secrets,Users,ApprovalPolicy,Preferences}Page.tsx; features/providers/*; features/integrations/*; features/tokens/* | features/phase27/settings/* |
| J · #528 | features/journey/{Builder,Palette,Inspector,NodeView,Legend}.tsx; features/journey/layout.ts | features/phase27/journey/* |
| R · #529 | packages/artifacts/src/hostedPages.ts; packages/artifacts/recipes/*.json; packages/audience/src/archive.ts (presentation helpers only) | packages/artifacts/test/phase27-*.test.ts; packages/audience/test/phase27-*.test.ts |
| D · #530 | App.tsx, main.tsx, screens/*, mock/*, api/*, copilot/*, components/*, lib/layout.ts (legacy only); apps/web/scripts/*single* | features/phase27/demo/* |
| I · integration | features/artifacts/{ArtifactListPage,ArtifactDetailPage,ArtifactSelect,VersionsPanel,ActivityPanel}.tsx; features/artifacts/artifactList.ts; features/brand/HostedPreview.tsx; features/templates/EditorPreview.tsx; features/previews/FormPreview.tsx; pages/build/JourneyPage.tsx; app/{Root,routes,router,session,api,nav,redirects}.*; ui/SettingsLayout.tsx; pages/CreatePage.tsx; apps/server/test/e2e/seed.ts | shared request-cache wiring, demo transport seam and fixture projection; shared e2e tests |

Integrator alone owns shared test config, e2e/visual.spec.ts and baselines, manifests/build scripts,
generated types/catalogues and any genuinely shared cache interface. Agents pages and Phase 26
report modules are frozen; Settings's old Agents files are Work destinations, not a second redesign.
PurposesPage is owned by A because it is mounted under Consent, despite its directory name.
C owns Brand editor; R owns public rendering. C must not edit R's recipes or renderer.
D must audit imports before deleting legacy files: localRender and real editors reuse legacy helpers.
No blanket deletion of components/api-types permitted; preserve dependencies or have I move them first.

Frozen inputs: DESIGN.md, DECISIONS.md, showcase/tokens.json, ui/{ListPage,DetailPage,charts,state,
layout}.*, lib/{labels,state}.*, index.css, navigation IA and redirects, Phase 24–26 state/metric/
preview contracts, journey model/checks/ops/canvas and report/count semantics, consent eligibility,
permissions, hosted path validation, CSP/nonce and public listener rules. No dependency or lockfile
changes, new persistence, permissions, routes for new capabilities, or execution semantics.

## Shared interfaces and sequencing

1. I first wires optional list/detail template slots into existing hosts, preserving defaults for
Phase 24–26. Keep ArtifactDetailPage exports and EditorProps compatible. Introduce a workspace-keyed
shared picker index adapter (one L per type, exposing total/complete/error) before A/J mount repeated
selectors; no per-row or per-node resolution. New versions invalidate only their exact cache keys.
2. I supplies real-shell demo mode and fixture-backed read transport seam before D replaces the
entry point. I wires Templates Starters tab to the existing RecipesPage embedded export. C styles it.
I owns shared preview wiring; C/R agree renderer inputs without changing schema or provenance.
3. A/C/S/J/R build independently within ownership; I handles requested host changes once. R changes
only rendering functions in archive.ts; path/security handlers remain frozen. No server command work.
4. D adopts the integrated screens and shared fixture projection after their states settle. I checks
all old URLs and demo deep links, both themes, request budgets and bundle separation, then runs the
phase-level tests and human baseline review. No delegate edits someone else's row to unblock itself.

## Process notes for delegates

Follow [delegates.md](../../process/delegates.md): task branch from feat/phase-27, commit locally;
integrator opens a **draft PR per task against feat/phase-27** with scripts/open-task-pr.sh.
Add a changelog fragment in changelog.d/ per task, never CHANGELOG.md. No lockfile/dependency changes.
Run `pnpm test:affected`, `scripts/e2e-docker.sh smoke`, lint and typecheck. Run contract-specific
functional and axe coverage as needed. All use the **shared test stack**:
`eval "$(scripts/test-services.sh env)"`; no delegate containers. Concurrent e2e uses distinct
TEST_PORT_OFFSET. Full suite is CI's job. Report evidence/exit codes, decisions and integration needs.

## Server changes

No new command, aggregate, schema, migration or storage is justified. Existing page data is sufficient.
R owns server-rendered **presentation** changes only; retain existing response/security headers,
nonce and route semantics. Lack of a hosted GET form route is not licence to add one. The design
shows existing form rendering/submission and its embed; see recipient contract and question below.

## Explicit cuts and preservation risks

No existing production feature is cut. Deliberate retirement: the separate legacy demo application,
its mocked command catalogue, ambient traffic and legacy live-site walkthrough. Equivalent real
product destinations and seeded read results replace them; demo sending/AI execution stays absent.
D7 in DECISIONS.md is superseded for demo shell separation by Wave 5 Phase 27; production sign-in
and lazy demo fixture loading stay separate. Keep build:demo entry compatibility through the real
shell fixture mode; no new browser execution engine. Do not drop underlying reused editor libraries.

High-risk items: static audience imports/snapshots and unknown conditions (A); template code/text/
sample data/block parameters and recipe prerequisite/install flow (C); provider adapter schemas,
one-time secrets and token password checks (S); every node kind/port/control group and simulation
(J); scanner-safe POSTs, topic/global unsubscribe, RSS/sitemap/web versions and brand overrides (R).
All have explicit destinations/tests in contracts and the source ledger. Read budgets change data
loading, never functionality. If a build finds a missed control, preserve it and report the mapping;
any proposed cut returns here for user review.

## Open questions for the user

None blocks the existing-capability redesign.

1. “Hosted form” currently has POST /f/:id and an admin-rendered form preview, not a GET signup page.
   Is a publicly hosted signup page intended later? This handoff preserves the current embed/POST flow.
2. Should a later demo retain a non-executing explanation of the retired live-site walkthrough?
   Phase 27 retires it as requested; no replacement execution engine is proposed.
3. Consent → Topics currently mounts an editorial backlog, not subscriber topic preferences.
   Preserve it and explain “Editorial topics”; changing that navigation belongs to a separate decision.

## Evidence and verification

Source baseline recorded in inventory.md. Read current wrappers, editors, host panels, navigation,
provider schemas, public renderers/routes, legacy demo and seeded fixture entry points. Validation
results are appended after mock generation. Human design approval and build-time checks remain outstanding.

Validation: six outer scripts and every generated iframe script pass Node VM construction for
50 screen selections across 11,832 screen/scenario/theme/width frames. Static checks assert all six
navigation groups in each frame, no external resource tags, and hidden content in loading/error/
restricted/not-found frames. All local Markdown links resolve; git diff --check passes.
These are script/static checks, not browser execution or visual/a11y clearance. T3 html_preview
failed for all six documents because the host lacks Chromium libraries (including libglib-2.0.so.0,
libnss3.so and libX11.so.6). The proposals were shown through html_render; offline files contain the
full review controls. No browser dependencies were installed. Screenshot/overflow checks, axe and
human visual approval remain outstanding for the implementation. Existing historical screenshots
are in ../screenshots/; they are not fresh Phase 27 measurements. No production tests were run for
this documentation-only change; mandatory build checks are specified above and in every contract.
