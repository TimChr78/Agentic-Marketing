# Roadmap, wave 5: polish (plan 2026-11-05)

> **Status: Phase 23 built in 0.9.0 (epic #439, tracker #440); Phase 24 next.** Reviewed against fresh screenshots of every screen and by a second
> model (GPT-6.1 Sol); its findings are folded in below.

Waves 1–4 built the product: artifacts, channels, journeys, analytics, and agents that work under
mandates across brands. At 0.8.0 it does a great deal, but it is not yet pleasant to use. It reads
like the command catalogue it is built on, it shows numbers as text where a picture would answer
the question, and every feature added its own page, so the navigation has grown to 31 entries.

Wave 5 makes the product **more intuitive, more beautiful, more visual and more polished**. Its
biggest lever is not decoration but **making state, consequences and next steps understandable**;
visual refinement reinforces that. The wave changes no product scope: functionality is added or
reshaped only when it makes an existing capability clearer, faster or more visible.

## Where it stands at 0.8.0 (screen review)

A screenshot pass over every screen (1440 and 390 px, light and dark, seeded demo workspace) found:

- **No home.** `/` redirects to Approvals; nothing answers "what needs me, what is running, how is
  it going".
- **Navigation is a feature list.** 31 items in build order; Agents live under Settings; Topics,
  Recipes, Blocks, Imports and Journey stats are first-level items.
- **Publication state stands in for operational state.** Broadcast and journey lists say "Live v1"
  (from the shared `ArtifactListPage`) instead of scheduled, sending, sent, blocked or running.
- **Zero activity looks healthy.** Deliverability shows green "ok" and 0.00% with nothing sent.
- **Approvals bury the consequence.** For a broadcast, audience, schedule and template sit in
  separate panels and the message starts below the fold; on a phone, almost all of it does.
- **Text where a picture belongs.** Analytics is a checkbox wall over raw keys (`email.sent`) with
  "newest 1/1/1970"; journey stats are zero tiles away from the canvas; agent outcomes are strings of
  counters.
- **Internal identifiers everywhere.** `prf_…`, `agt_…`, `tok_…`, `jm_…` in headers, tables and
  messages.
- **Previews are inconsistent.** Forms preview unsaved changes; the generic Preview tab shows the
  saved version; hosted-page previews need a save. Nothing says which one you are looking at.
- **Incomplete lists.** People loads 50 profiles and calls that number "people"; e-mail is repeated
  in two columns; "1 allowed" does not say for which purpose.
- **Agents mix operations and policy.** The Agents page holds the inventory, the comparison and the
  workspace-wide autonomy ceilings; an agent's page leads with an empty mandate panel.
- **Settings waste attention.** Providers shows a large empty panel per missing channel with
  duplicate buttons; Integrations mixes tokens, MCP set-up and event sources.
- **Mobile.** Shared buttons are 28/32 px against DESIGN.md's 40 px touch targets; the top bar shows
  two menu toggles at 390 px; People's last column is cut off; journey nodes are unreadable.
- **Visible defects.** The brand logo renders as a blue bar in the switcher; the e-mail editor is a
  dark third-party UI inside the light app.
- **Thin demo data.** The seed sends almost nothing measurable, so charts and reports are empty.
  `/demo` exists but is a separate legacy app.
- **Still strong:** the tokens, accessibility rules, approvals flow, journey canvas and form preview
  are a good base. The calm, precise direction stays.

## Principles

1. **State and consequence first.** Every object says what it is doing now (scheduled, sending,
   sent, paused, blocked) and every action says what it will do (who, how many, when) before it runs.
2. **Answer the question on the page.** Lead with status, result and next step; then the controls.
   A number that changes over time is a trend; every metric names its period, denominator and
   freshness, and "no data" never looks like "healthy".
3. **People's words, not the API's.** Plain labels for measures, states, action classes and errors;
   ids only behind a copy affordance.
4. **Show, then edit.** The recipient's view has the strongest presence; every preview says whether
   it shows the unsaved draft, a saved version or the live one.
5. **One way to do each thing.** Shared templates and primitives, so new screens inherit the polish.
6. **Scope stays.** No new historical storage, permissions or execution semantics; prefer fixed
   presets over persisted configuration and existing aggregates over new pipelines.

## Visual direction (decided in this plan)

- **Keep:** the system font (no third-party fonts), blue as the only interaction accent, status
  colours with text, flat surfaces with borders reserved for structure.
- **Change:** a larger heading and KPI scale (page 24/32, KPI 28–32 px, reading 14/22, dense tables
  13/20); 24–32 px between sections; fewer nested bordered boxes; tonal surfaces in dark mode;
  shadows only for overlays and preview separation; 8–12 px radii.
- **Add:** a documented **data-visualisation palette** (categorical with teal as a chart colour,
  sequential, diverging; light and dark; colour-blind safe); charts with one question each, direct
  labels, quiet grids and consistent periods; counts and rates never on one axis.
- **Allowed:** small product-shaped diagrams for first-run onboarding. **Not:** a decorative
  illustration set, a second interaction accent, tenant colours in the admin chrome (the tenant's
  logo, name and domain identify the brand; its colours stay on what recipients see).
- **Lists:** each list picks its form: tables for operational comparison, thumbnails for templates
  and assets. No table/cards toggle unless a second task needs it.
- **References:** Linear and the Stripe Dashboard for the shell, density and type; Stripe and
  Postmark for charts and message inspection; Customer.io for the workflow builder and e-mail editor.

## Information architecture (target)

| Group | Items |
|---|---|
| Work | Home, Approvals, Agents |
| Marketing | Campaigns, Broadcasts, Journeys, Web experiences |
| Audience | People, Segments, Forms, Consent |
| Content | Templates, Assets, Brand |
| Insights | Analytics, Message activity, Deliverability, Alerts |
| Settings | one entry with its own secondary navigation |

19 work destinations plus Settings (from 31). Moves and merges:

- Imports → an action and history tab in People. Topics → beside Purposes in Consent.
- Blocks → a Templates tab and the editor's insert panel. Hosted pages → Brand → Subscriber pages
  (form-specific overrides stay on the form).
- Recipes → the create flows, with a starter gallery there. AI prompts → an Agents library tab,
  also reachable from journey AI steps.
- Journey stats → each journey's Report tab. AI usage → an Analytics view, linked from Agents.
- Settings: Workspace, Providers, Integrations and API tokens, Secrets, Users and roles, Approval
  policy and agent autonomy (moved from the Agents page). Preferences moves to the account menu.
- Every old URL redirects; approval links and bookmarked artifacts keep working.

## The phases

Each phase ships as a release. Sizes are in working sessions (S ≈ 1, M ≈ 2–3, L ≈ 4+).

| Phase | Theme | Size | Done means |
|---|---|---|---|
| **23** ✅ (0.9.0) | Baselines and foundations | L | Screenshot matrix, visual regression and axe run in CI on deterministic, rich fixtures; state semantics and labels exist as shared code; shared controls meet touch targets; the listed defects are gone |
| **24** | Shell, navigation and home | L | The target IA with redirects; a minimal actionable Home; Broadcasts list and detail rebuilt as the reference list/detail pair |
| **25** | Broadcast → review → send | L | One coherent workspace to compose, review and send a broadcast, with the consequence summary first and a report after the send |
| **26** | Truthful insights | L | Analytics answers preset questions with charts; journeys, deliverability, agents and people show state and trends without raw keys or false "ok" |
| **27** | Remaining families and recipient surfaces | L | Every remaining screen family on the templates; hosted pages and starter e-mails redesigned; demo parity |
| **28** | Polish pass and verification | M | The done criteria below pass on the integrated build |

### Phase 23: baselines and foundations

- **Tooling first:** the screenshot rig (Playwright container: every route × light/dark × 1440/768/390)
  as a script and a CI job; visual regression on a stable subset per PR, the full matrix at
  milestones; axe-core in e2e (#206).
- **Deterministic, rich fixtures:** weeks of believable activity (sends, opens, clicks, journey
  progress, conversions, agent runs, holds) with a fixed clock and time zone, long names, missing
  values, large lists and restricted roles; shared by e2e, screenshots and the demo.
- **Data inventory:** for every planned chart and summary, which existing command or aggregate feeds
  it; anything needing new storage is cut or deferred.
- **State semantics:** one shared model of operational state per artifact type (broadcast:
  draft · in review · scheduled · sending · sent · paused · blocked; journey: draft · live · paused ·
  stopped, with counts; agent: active · paused · held), and data states for metrics (no data · below
  evaluation volume · healthy · warning · paused).
- **Labels and ids:** a label registry (measures, dimensions, states, action classes, event types)
  and an `Identifier` component (short form, copy, full id on hover); messages name objects.
- **DESIGN.md v2:** the type, spacing, depth and data-viz decisions above, as tokens; adapt the
  existing ECharts wrapper (`components/Chart.tsx`) to them and add the KPI tile, line and bar
  primitives only (others come with the screens that need them).
- **Shared fixes:** 40 px touch targets on small screens; the double toggle; the switcher logo; the
  editor theme; the 1970 date; overflow at 390 px contained to tables and canvases.

### Phase 24: shell, navigation and home

- The target navigation with collapsible groups, Settings with secondary navigation, and redirects
  for every moved route.
- **Home (minimal, actionable):** what needs me (approvals, holds, alerts, failed runs), what is
  running (scheduled and sending broadcasts, live journeys, active agents), and a few KPI tiles from
  existing aggregates. Role-aware ordering.
- **Create from one place:** a "New" menu and command-palette actions with recent items.
- **Reference pair:** the Broadcasts list (operational state, schedule, audience, result) and the
  broadcast detail page rebuilt on the new list and detail templates.
- An onboarding checklist for a new brand, driven by real state (grows from the Setup screen).

### Phase 25: broadcast → review → send

- **Composer:** settings in steps (what, who, when) beside a live preview of the unsaved draft, with
  the eligible audience and the scheduled time; a pre-send checklist (template live, provider,
  domain, consent).
- **Approval review:** a compact consequence summary first (what publishes, eligible recipients,
  when, dependencies, bundle members), then the message, then the diff; exact-version review,
  stale-version notices and four-eyes rules unchanged; usable at 390 px.
- **Preview contract** across artifact types: "Unsaved draft", "Saved v2" or "Published v1" always
  shown.
- **E-mail editor:** its chrome themed to the design system in light and dark, a simpler block
  palette (Blocks folded in), preview in desktop, mobile and dark mail.
- **Broadcast report:** delivery, opens and clicks over time, top links, unsubscribes and holdout
  uplift, from existing message events.

### Phase 26: truthful insights

- **Analytics:** fixed presets ("Newsletter performance", "Journey conversion", "Deliverability"),
  a grouped measure picker with plain names, a chart first and the table below, period comparison.
  No persisted saved views in this wave.
- **Journeys:** a Report tab with step counts and conversion; counts on canvas nodes; a funnel where
  the data supports it.
- **Deliverability:** the data states above, sample size and threshold shown, trends with the pause
  thresholds drawn, DNS checks as cards with the fix.
- **Agents:** the page split into Overview/Activity and Mandate/Credentials; Pause always one click
  away; activity as a timeline, decisions as a breakdown, mandate levels as a matrix, outcomes and
  goals as tiles; comparison as small multiples.
- **People:** pagination and honest counts; identity hierarchy (one e-mail, name, id behind copy);
  consent per purpose; a profile timeline of events, messages and consent changes.
- **Campaigns:** a roll-up of their artifacts' results.

### Phase 27: remaining families and recipient surfaces

- Forms, Brand (with Subscriber pages), Templates (with Blocks and the starter gallery), Assets,
  Segments, Web experiences, Consent, Alerts and every Settings page on the templates; Providers and
  Integrations compacted with contextual set-up help.
- Journey builder polish: cleaner palette, auto-layout, validation on nodes.
- What recipients see: hosted pages (forms, confirm, preferences, archive) and the starter e-mail
  templates redesigned, still brand-themed.
- **Demo parity:** `/demo` uses the real shell and the fixtures, clearly marked as simulated; the
  legacy demo app is retired. No new demo execution engine.

### Phase 28: polish pass and verification

- Microcopy pass over every screen; motion limited to orientation and feedback (120–180 ms,
  reduced motion respected); dark-mode and mobile audits; per-route bundle budgets and skeletons
  without layout shift; DESIGN.md v2 final; screenshots and README images refreshed.

## Done criteria for the wave

- **Findability:** at least four of five people unfamiliar with the product find and start each of
  six agreed tasks unaided within 30 seconds (send a broadcast, approve a change, pause an agent,
  find a person's consent, see last week's newsletter results, create a form).
- **Roles and edge cases:** the core flows pass for builder, approver and viewer, including stale
  review, grouped approval, zero audience and a failed request.
- **Mobile (390 px):** no page-level horizontal overflow, no obscured actions, readable without
  zoom; Home, Approvals, navigation, sign-in, person lookup and agent Pause fully usable; reports
  readable; canvas and e-mail authoring may stay desktop-first with a useful summary.
- **Metrics:** every metric names period, denominator and freshness and shows unavailable or
  suppressed states; fixture totals reconcile between Home and the reports.
- **Accessibility:** zero axe violations on every route, plus manual keyboard, focus-return, 200%
  zoom and screen-reader checks of the core flows.
- **Consistency:** no raw ids or metric keys outside copy affordances and developer views.

## How we work

- **Screen contract before code** for each family: the task, the files it owns, screenshots of
  today, an approved mock-up (HTML) in both themes at desktop and mobile with populated, empty and
  failure states, the data fields, responsive behaviour and explicit exclusions.
- **Shared parts first, by one owner:** tokens, shell, navigation, templates and chart contracts land
  before any screen family is parallelised; no two worktrees edit `ArtifactDetailPage`, `nav.ts` or
  the chart contract at the same time.
- **Small, observable acceptance criteria** in every delegated task ("lists show operational state
  from `stateOf()`"), never "make it polished".
- **Review gates:** functional tests, axe, before/after screenshots in the PR, a visual review on
  the integrated branch (shared CSS breaks untouched screens), and baselines approved by a reviewer,
  never by the implementing model.

## Deferred (not in this wave)

Persisted saved analytics views; segment size history and overlap; send-time estimates per
recipient time zone; visual diffs for artifact types without a renderer; a table/cards toggle;
tenant colours in the admin chrome; a new demo execution engine.
