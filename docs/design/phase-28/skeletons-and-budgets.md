# Reserved loading states and route budgets

## Skeleton contract

I supplies a shared geometry-based primitive and updates LoadingBlock adapters first. Static tonal shapes,
aria-hidden children; one labelled `role=status` and `aria-busy=true` on the containing region. Remove busy
on ready/error. No shimmer. Area owners choose geometry from the existing template, not arbitrary line count.

Reserve space **immediately**; reveal skeleton at **150 ms** if the request is still pending. Under 150 ms,
keep the reserved region quiet. Do not impose a minimum loading duration or slow successful responses. For
refreshes retain existing data/dimensions with “Updating performance” and existing stale/freshness semantics;
never clear valid values to zero. After error, use the same reserved slot for error and recovery.

| Region | Reserved geometry (existing DESIGN dimensions) |
|---|---|
| Shell/header | 56px top bar; 232/64px desktop rail; page title line 32px plus existing description/action rows; shell stays mounted |
| KPI | min-height 204px, 20px padding; 32/40 value desktop, 28/36 mobile; same column breakpoints as final tiles |
| Chart | 240px plot ≥768, 200px below; reserve heading, subtitle, margins and data-table toggle separately |
| List | Match actual header and first-page row/card geometry; use five rows only when that matches the host; mobile cards reserve their real field lines, not desktop bars |
| Content preview | Keep known asset aspect ratio or existing preview frame; reserve message container before lazy renderer resolves |
| Visual e-mail editor | Existing min-height 560px at desktop / 420px mobile (`TemplateEditor.tsx`); same outer height before and after Suspense |
| Journey | Keep current canvas container height and summary/inspector slots while code/data loads; no fit animation |
| Settings/detail | Preserve label/control/hint line boxes, secondary navigation and context slots from the existing template |

No spinner for a page, table, chart or editor. Mutation buttons use a static progress icon, reserved icon slot
and object-specific label; keep button width ≥ its idle width and disable duplicate submission under existing
semantics. Indeterminate operations must not invent progress percentages. Preserve error content and typed input.
Measure loading→ready and loading→error under delayed reads at 390/768/1440: assert region bounds stable within
1 CSS px for deterministic fixtures, no unexpected layout-shift entries caused by placeholder replacement.
Longer real content may grow naturally; do not hide it to pass. Report CLS separately (target ≤0.1 on core
cold flows, no measured baseline supplied); don't confuse screenshot stability with measured CLS.

## Budget units and evidence

All ceilings below are **decimal gzip kB** (1 kB = 1,000 bytes). Count JS **and CSS**, each file compressed
individually with Node gzipSync, unique emitted URLs only. Exclude sourcemaps, manifest, HTML and image/font
payload; report those separately. Never compare Vite raw kB against gzip limits.

Supplied build: index JS 69.70 gzip, index CSS 13.69, Root 3.18, Shell 8.41, ui 18.11, ThemeMenu 11.12:
these named chunks alone total 124.21. Initial signed-in common static closure ceiling **150** gives about
26 kB for runtime/shared imports and polish; signed-out initial closure ceiling **110** (index/CSS/Root plus
small auth dependencies). These are justified ceilings, **not measured manifest closures**: build-live.txt
contains chunk sizes but no dependency edges. I must attach exact closures and cold-load checks at first landing.

“Initial” = common static entry/Root/Shell closure before route modules. “Lazy” = additional static closure of
that route and its automatically mounted children, excluding files already counted in initial. Both must pass
and the cold total is their sum. Modules loaded via dynamic import on route mount count as route lazy bytes,
not as optional just because Vite calls them dynamic. Optional means an explicit existing tab/action. Shared
files counted once per cold route; cold requests include dependencies even if previously cached in another run.

## Per-route release ceilings

Names map to current routes in `app/routes.tsx`; detail IDs are seeded examples. Prefix /demo uses identical
route ceilings plus the separately limited demo fixture closure. No unlisted route is exempt: I must fail on
missing budget entries when enumerating routes, redirects and the e2e matrix. Aliases inherit destinations.

| Routes / existing view | Initial | Route lazy | Cold total | Basis / additional action closure |
|---|---:|---:|---:|---|
| Sign in, forgot password, reset password | 110 | 10 | 120 | Auth shares Root; no shell/editors |
| `/` Home | 150 | 25 | 175 | Home chunk 9.13 plus shared summary dependencies |
| `/approvals` | 150 | 25 | 175 | List 5.82; drawer excluded until open |
| `/approvals/:id` / open review | 150 | 70 | 220 | Drawer 14.54 + preview 10.75 + detail/labels; include automatically shown preview |
| `/work/agents` / library tab | 150 | 35 | 185 | Agents 4.69 + library list dependencies |
| `/work/agents/:id` | 150 | 45 | 195 | Agent 13.04 + mandate editor 5.35 and activity |
| `/work/agents/library/:id` | 150 | 35 | 185 | Prompt 5.59 + detail closure |
| `/marketing/campaigns` | 150 | 20 | 170 | Page .43 + generic list |
| `/marketing/campaigns/:id` | 150 | 45 | 195 | Page 9.59 + detail + evaluation models |
| `/marketing/broadcasts` | 150 | 25 | 175 | Page 4.72 + list dependencies |
| `/marketing/broadcasts/:id` | 150 | 80 | 230 | Page 17.59 + detail 12.91 + previews/Composer; report action ≤30 extra excluding charts |
| `/marketing/journeys` | 150 | 20 | 170 | Page .63 + generic list |
| `/marketing/journeys/:id` | 150 | 130 | 280 | Page 20.33 + NodeView 59.07 JS/2.56 CSS + graph/detail; current canvas is automatically mounted |
| `/marketing/experiences` | 150 | 20 | 170 | Page .48 + generic list |
| `/marketing/experiences/:id` | 150 | 40 | 190 | Page 2.40 + detail and results |
| `/audience/people` / imports tab | 150 | 30 | 180 | People 3.41 + Imports 3.39 + CSV .89; explicit import dialog included |
| `/audience/people/:id` | 150 | 30 | 180 | Person 5.90 + consent/timeline |
| `/audience/segments` | 150 | 20 | 170 | Page 1.17 + generic list |
| `/audience/segments/:id` | 150 | 40 | 190 | Page 7.95 + detail/condition controls |
| `/audience/forms` | 150 | 20 | 170 | Page .70 + generic list |
| `/audience/forms/:id` | 150 | 40 | 190 | Page 5.16 + detail/form preview |
| `/audience/consent` / purposes / topics | 150 | 40 | 190 | Consent 7.73 + purposes 2.85 and embedded tabs |
| `/content/templates` / blocks / starters | 150 | 35 | 185 | Templates 4.28 + Recipes 3.28 + list dependencies |
| `/content/templates/blocks/:id` | 150 | 40 | 190 | Block 1.94 + detail/preview |
| `/content/templates/:id` | 150 | 65 | 215 | Template 7.45 + detail + liquid 22.84; visual editor has separate ceiling below |
| `/content/assets` | 150 | 25 | 175 | Assets 3.86 + grid/picker |
| `/content/brand` / subscriber pages | 150 | 40 | 190 | Brand 6.58 + detail/hosted preview |
| `/insights/analytics` / AI usage | 150 | 40 | 190 | Analytics 13.30 + definitions/queries; chart allowance below |
| `/insights/messages` | 150 | 20 | 170 | Messages 2.76 plus table dependencies |
| `/insights/deliverability` | 150 | 35 | 185 | Deliverability 8.93 + health/DNS; chart allowance below |
| `/insights/alerts` | 150 | 30 | 180 | Alerts 5.76 + existing rule/history controls |
| `/settings` → workspace; `/settings/workspace` | 150 | 20 | 170 | Workspace 1.92 and settings layout |
| `/settings/providers` | 150 | 40 | 190 | Providers 12.53 + schema forms |
| `/settings/integrations` and `/settings/integrations/tokens/:id` | 150 | 55 | 205 | Integrations 14.54 + token drawers; hosted agent dialog ≤15 extra on explicit open |
| `/settings/secrets` | 150 | 20 | 170 | Secrets 2.96 + drawer |
| `/settings/users` | 150 | 25 | 175 | Users 4.25 + invitation drawer |
| `/settings/approval-policy` | 150 | 25 | 175 | Policy 3.67 + autonomy controls |
| `/preferences`, `/create` | 150 | 20 each | 170 each | Chunks 1.14 / 1.09 plus shared controls |
| `/artifacts/:id` | 150 | destination ceiling | destination total | Resolve artifact type to existing destination; no bypass of detail budgets |
| `/demo` and deep links | destination initial | destination lazy + 25 | destination total + 25 | DemoRoot 12.91 plus fixture dependencies; never eagerly in signed-in initial |

Additional renderer closures, deduplicated against route files:

| Existing renderer / trigger | Extra gzip ceiling | Reason |
|---|---:|---|
| ECharts SVG, automatically mounted charts or existing Report tab | 400 | ChartImpl 371.56 plus small wrapper/runtime; no new chart library. Count in cold total whenever automatically mounted |
| Visual e-mail authoring | 1,120 | VisualMjml 643.45 + lib 431.83 + CSS 13.23 = 1,088.51 before small imports; ~31 kB headroom |

Thus Analytics cold with chart ≤590, Deliverability ≤585; journey Report ≤150+130+400=680;
Template cold with automatically mounted visual editor ≤1,335. Approval email preview must not import the
visual authoring stack; if local preview loads Liquid its bytes are inside the review's 70 kB closure ceiling.
Keep NodeView out of list/auth routes, charts out of lists/auth, and GrapesJS/MJML authoring out of shell/lists/
reviews. Large existing editor chunks justify isolation, not a new editor rewrite in a medium-size phase.

## Extend `apps/web/test/bundle.test.ts` (I only)

Retain existing raw limits and heavy-marker assertions. The current test calculates gzip but **asserts raw**,
uses static imports only and skips without dist. Add these requirements:

1. Build live with manifest first. Dedicated CI budget invocation fails if manifest is missing; local source-only
   unit runs may keep skip behavior. Never reuse demo dist. Assert expected entry keys exist before traversal.
2. Extend Chunk type with `css` and `dynamicImports`; static closure follows `imports`, includes associated CSS,
   deduplicates emitted paths and gzipSyncs buffers. Sum bytes, compare to ceiling ×1,000, round only for display.
3. Map every current route/tab to route root, automatically mounted dynamic roots and explicit-action roots.
   Traverse dynamic imports only through that explicit map; an eager chart/editor must not disappear from counts.
   Reconcile against cold browser network resources for representative auth, Home, review, analytics and editor flows.
4. Assert common initial, incremental lazy and cold union ceilings independently. Optional renderer/action closures
   have separate tests, and automatically invoked ones add to cold totals. Assert heavy libraries absent where forbidden.
5. Table-drive route completeness against route definitions/matrix; redirects inherit target, unsupported type cannot
   fall through to a zero budget. Test gzip accounting, shared dedup, CSS and missing-chunk rejection with small fixtures.
6. Failure prints route, raw/gzip sizes, closure URLs, cap and excess. Publish actuals against these targets in release
   evidence. No automatic baseline ratchet; exceeding target needs optimization or explicit reviewed budget decision.
