# Phase 26 · screen contracts

Design handoff for #505, Wave 5 #439; build #506–#511, based on Phase 25 / 0.11.0.
Read with [DESIGN v2](../DESIGN.md), [decisions](../DECISIONS.md),
[inventory](../wave-5-data-inventory.md), [Phase 24](../phase-24/README.md),
[Phase 25](../phase-25/README.md) and [wave plan](../../architecture/roadmap-wave-5.md).
Proposed contracts for human review; no approval is claimed. Docs only.

- [Analytics](analytics.md) · #506 — [offline mock](mock/analytics.html).
- [Journey report](journey-report.md) · #507 — [offline mock](mock/journey-report.html).
- [Deliverability](deliverability.md) · #508 — [offline mock](mock/deliverability.html).
- [Agents](agents.md) · #509 — [offline mock](mock/agents.html).
- [People](people.md) · #510 — [offline mock](mock/people.html).
- [Campaigns](campaigns.md) · #511 — [offline mock](mock/campaigns.html).

Each self-contained mock embeds independent 1440/768/390 frames, theme and scenario controls.
Frames scroll inside labelled host containers on narrow screens; application content itself
must not overflow. Synthetic fixtures are marked as design examples, never live evidence.
No external assets, fonts, network requests or storage; controls never execute commands.

## Exclusive ownership

Paths relative to apps/web/src unless prefixed. Ownership includes imports; no task edits another
row. New namespaces confer no ownership of similarly named existing files.

| Task | Exclusive existing files | New files / tests |
|---|---|---|
| A · #506 | pages/insights/AnalyticsPage.tsx, pages/insights/analyticsParams.ts | features/analytics/phase26/*, features/analytics/phase26/analytics.test.tsx |
| J · #507 | pages/build/JourneyPage.tsx, pages/insights/JourneyStatsPage.tsx, features/journey/JourneyGraph.tsx, features/journey/NodeView.tsx, features/journey/Builder.tsx | features/journey/report/*, features/journey/report/report.test.tsx |
| D · #508 | pages/insights/DeliverabilityPage.tsx | features/deliverability/*, features/deliverability/deliverability.test.tsx |
| G · #509 | pages/settings/AgentsPage.tsx, pages/settings/AgentPage.tsx, features/agents/* | features/agents/phase26/*, features/agents/phase26/agents.test.tsx |
| P · #510 | pages/audience/PeoplePage.tsx, pages/audience/PersonPage.tsx, features/audience/profile.ts | features/audience/phase26/*, features/audience/phase26/people.test.tsx |
| C · #511 | pages/build/CampaignPage.tsx, features/artifacts/CampaignEvaluation.tsx, features/campaigns/CampaignHoldoutCard.tsx | features/campaigns/phase26/*, features/campaigns/phase26/campaigns.test.tsx |
| S · integration server owner | packages/email/src/deliverability.ts, packages/email/src/policy.ts, packages/auth/src/agents.ts, apps/server/src/registry.ts (only if registration needed) | packages/email/src/deliverability.trend.test.ts, packages/auth/src/agents.mandate.test.ts |

Integrator alone owns features/artifacts/ArtifactDetailPage.tsx,
lib/labels.ts, shared test config, e2e/visual.spec.ts and baselines, manifests/lockfiles and generated
command types/catalogues. Check actual profile helper extension before editing: profile.ts is the
owned helper (not permission to create a duplicate module). Shared audience consent helpers stay frozen.
CampaignEditor and campaign lists stay frozen. No N heavy summary calls on campaign lists.

Frozen inputs: DESIGN.md, showcase, shell/nav/routes, ui/ListPage.tsx, ui/DetailPage.tsx,
ui/charts.tsx, ui/state.tsx, ui/layout.ts, lib/state.ts, lib/labels.ts, index.css and existing
operational state/approval policy helpers. Additionally freeze Phase 25 composer, preview provenance,
broadcast report/period utilities, shared consent eligibility and chart contracts. No token changes,
new routes, saved-view store, new execution semantics, historic storage or dependency. Local scoped CSS.

## Shared interfaces and sequencing

Use existing workspace/session permissions; do not call workspace.get again in each section.
Default reports: Last 7 complete days; alternate Last 30 complete days. Workspace IANA zone,
calendar-day boundaries across DST. Reuse Phase 25 period logic without modifying its owner files.
Logical [from,nextMidnight); analytics SQL is inclusive at to, so send nextMidnight minus 1 ms.
Prior period is the immediately preceding equal number of local calendar days. Display both date
ranges and zone. Totals are separate dimensionless reads, never sums of daily unique counts.
Percent rates multiply server fractions by 100; delta of rates is percentage points; count relative
delta is unavailable when prior=0. Current and prior null/suppressed disables comparison.

Map columns by name. Carry meta.timeZone/from/to/freshness/k/suppressed/notes with each result.
“Latest event in period” is event freshness, never fetch time. Distinct e-mail people, journey
participants, messages and action rows have separate units. Daily unique counts are non-additive.
Current operational policy counts use a rolling duration window, not report calendar-day semantics.

Additive interfaces (owned by their surface):
- J exports JourneyReport({journeyId:string, active?:boolean}) (default active=true for legacy host).
  JourneyGraph receives optional counts:{reached:Record<string,number>,waitingAt:Record<string,number>}
  and countsLabel:string; it fetches nothing. J wires Builder/NodeView with the same count semantics;
  never fetch per node. Missing keys remain unavailable, not observed zero.
- C keeps CampaignEvaluation({campaignId}) and CampaignHoldoutCard({campaignId}) compatible;
  host supplies optional from/to/active so both share period and mount only when active.
- No cross-surface mutable hooks or shared-file edits. A owns local preset definitions and
  currency gate. G owns matrix/timeline adapters. P owns its independent source cursors.

1. S lands the two additive reads below, regenerates types/catalogue with the integrator, and
   supplies fixture payloads. UI work can proceed against these exact proposed schemas; do not
   call unregistered commands until S lands. No server implementation is part of this docs task.
2. J/C preserve existing host exports; integrator performs shared host wiring once. Other surfaces
   proceed independently after read schemas are frozen. No task edits shared labels: submit required
   plain-label mappings to the integrator, with local mappings until integrated.
3. Integrator runs typecheck, relevant unit/integration tests, both-theme axe, existing visual matrix,
   1440/768/390 screenshots, keyboard/focus and 200% zoom. Baselines require human review.

## Minimal additive server work · owner S

Two inventory candidates are necessary to meet the requested trend and no-N+1 contracts.
No B3 total addition: People says “50 shown”, with cursor pagination. No B4 link ranking.

**B5 deliverability.trend** (not yet registered): input {from:ISO,to:ISO,channel:'email'|'sms',
stream:'marketing'|'transactional'}, max 90 workspace-local daily boundary points; from<to.
Output {points:[{day:string,windowFrom:ISO,windowTo:ISO,sent:number,bounced:number,
complained:number,bounceRate:number|null,complaintRate:number|null}],windowDays:number,
thresholds:{complaintWarn:number,complaintStop:number,bounceStop:number,minVolume:number},
autoPause:boolean,timeZone:string,computedAt:ISO,semantics:'current_status_by_creation_window'}.
Points end at local midnight boundaries in the requested range; each windowFrom is windowTo minus
windowDays*86400000 ms, matching streamRates rolling duration even across DST. No extra now point
in this design, so never equate last point to live health. Use window bounds in table captions.
Factor existing streamRates filters and published purpose classification without changing policy.
One grouped Postgres read over range plus lookback; bounded rolling sums in memory, no query per day.
Current status sent/delivered/bounced/complained, test=false; sent=sum of these mutually exclusive
statuses. Zero denominator returns null rates. Existing RLS and artifacts:read. Today’s thresholds
only; no historical state, new tables, pause command or analytics compiler changes. Guard invalid
ranges, tenant isolation, no purposes, late status changes, empty/low volume and DST in server tests.

**B6 agents.mandate** (not yet registered): input {agentId:existing AGENT_ID}; output
{agentId:string,mandate:null|{id:string,version:number,content:AgentMandate},
outsideHours:string|null,asOf:ISO}. Existing artifacts:read; validate agent existence in tenant.
Reuse activeMandate/activeMandates in packages/artifacts/src/mandates.ts exactly: published,
unarchived, unexpired, newest applicable artifact; workspace-zone working hours/blackouts.
Resolve the selected version’s content inside the server if service exposes only a view.
Do not list drafts or return credentials. Constant bounded Postgres reads, no per-mandate API fan-out.
Test published older than latest draft, expired/archived, absent, multiple historical versions,
working hours/overnight/DST and denied cross-tenant access. This avoids current MandateCard’s P+2M
scan while making no policy changes. Selection service is frozen; no new approval requirements.

## Common geometry and states

1440: expanded shell, existing page cap, 800/24/320 detail main/context geometry where applicable;
list/report pages use available main width. 768: 720 px area, context below, two-column tiles.
390: 16 px gutters, 358 px content, one column, full-width drawers, wrapped labels and 40 px controls.
Local tabs/canvas can scroll inside labelled focusable regions; no page-level sideways scroll.
Charts have visible table fallbacks; phones stack rows and keep four date ticks maximum. Every
contract’s state/access/focus/test sections are binding, including when server reads lack suppression.
Never claim k-suppression for operational data that has no suppression contract.

## Open questions for the user

None blocking. Approval is requested for the visual proposals and explicit cuts, including the two
small additive reads above. Human approval remains outstanding; these documents do not grant it.

## Evidence and verification

Checked registry and actual handlers: packages/analytics/src/{query,registry,reports,campaignSummary}.ts,
packages/journeys/src/commands.ts, packages/email/src/{deliverability,policy,messages}.ts,
packages/auth/src/{agents,hostedAgents}.ts, packages/profiles/src/commands.ts,
packages/campaigns/src/campaigns.ts, packages/artifacts/src/mandates.ts, apps/server/src/registry.ts;
also current page/host implementations. Named report wrappers may perform multiple internal queries:
client call budgets below do not imply cheap server reads. Mock validation is recorded after generation.

Mock validation: all six outer scripts and generated inner scripts pass Node VM construction
across 87 scenarios × two themes × three widths (522 scenario frames, plus18 initial frames).
Static checks reject external asset URLs. T3 html_preview could not inspect layouts because host
browser libraries are missing. Crawl4AI authenticated requests succeeded through configuration
validation but its SSRF protection rejected data URLs; no screenshots or console/overflow clearance
is claimed. All six documents were presented through html_render. Human visual review and build-time
axe/screenshots remain outstanding; no host dependencies were installed.
