# Analytics & reporting

Decision: [ADR-0010](adr/0010-analytics-layers.md). Three layers; only the first is part of the core.

## Layer 1 — Built-in marketing analytics (core)

All events, message events, journey step logs and decision logs already land in ClickHouse ([data-platform.md](data-platform.md) §5), so marketing reporting is cheap to provide in-product:

| Report | Source tables | Notes |
|---|---|---|
| E-mail performance (sent, delivered, clicks, unsubscribes, complaints, bounces) | `message_events` | Open rate shown only where pixel tracking is enabled (off by default) |
| Journey funnel per step, waiting counts, drop-off | `journey_events` | Live overlay on the journey canvas |
| Goal conversion **with holdout uplift** | `journey_events` + `events` | Holdout/control groups per journey give incremental effect, not just attributed orders |
| Experiments (A/B/n) for messages and web experiences | `decision_events`, `events` | Frequentist, sequential and Bayesian (`experiences.results`) |
| Web personalization exposures & uplift | `decision_events` | |
| Segment growth, consent opt-in/objection rates | `segment_memberships`, consent ledger | Consent reporting doubles as GDPR evidence |
| Deliverability (per domain/provider) | `message_events` | |
| LLM usage & cost per journey/purpose | metering events | Feeds budgets |

Implementation:
- A small **metrics layer** in code: named measures and dimensions over curated ClickHouse views (`metric('email.click_rate').by('journey', 'day')`). Queries are parameterised and tenant-scoped; no raw SQL from the UI or from agents.
- Charts in the UI with **Apache ECharts** (Apache-2.0), themed from the design tokens.
- Every report is also a command (`analytics.*`) and therefore an **MCP tool**, so agents can evaluate their own changes ("did the v4 subject lines help?").
- Privacy: reports are aggregates; a minimum group size (e.g. k ≥ 5) can be enforced for breakdowns; the `analytics` purpose is respected at ingest.

### Implementation (Phase 16, #75)

The metric layer is its own workspace package, `packages/analytics`, rather than a folder inside `packages/events`. `events` owns ClickHouse transport and storage; campaign evaluation and alerts read metrics, so keeping the catalogue and query compiler separate lets those consumers depend on one package without importing the event sink. The package reads ClickHouse through the existing `EventStore` client (with `settingsFor(workspace)` so the row policy applies) and Postgres through the command transaction (workspace time zone, conversion map, segment members, published campaign members).

**Registry.** `packages/analytics/src/registry.ts` is the only place measure ids, descriptions, units, aggregations, sources, allowed dimensions and default grains live. `analytics.metrics.list` returns the same catalogue, so the UI picker and agents cannot drift from it.

| Source | Measures | Notes |
|---|---|---|
| `message_events` | `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.opened`, `email.clicked`, `email.unsubscribed`, `email.click_rate`, `email.bounce_rate`, `email.unsubscribe_rate`, `email.open_rate` | Each base measure counts distinct people (`profile_id`). Ratios are clickers/delivered, bounces/sent and unsubscribes/delivered. Opens exist only where tracking is enabled. |
| `journey_events` | `journey.entered`, `journey.completed`, `journey.exited`, `journey.goal_reached`, `journey.step_reached` | Distinct participants; `journey_step` is the node id, ordered by its first `seq`. |
| `events` | `conversions`, `revenue` | `conversions` counts distinct event ids named by the published `conversion_map` (or `filters.name`). `revenue` sums the map rule's `value` property; the currency comes from the rule or `currencyProperty`. |
| `segment_memberships` (Postgres) | `segment.members` | Current membership size; ignores `from`/`to`. |
| `campaign` | `campaign.recipients`, `campaign.converters`, `campaign.conversion_rate`, `campaign.revenue`, `campaign.revenue_per_recipient` | Joins message events for a published campaign's sending members to attributed conversion events. Conversions are first touch: people who converted within the goal's attribution window after their first campaign message, so a person reached by two campaigns can count for both. Revenue is per currency. Dimensions are the time grains and `campaign`. |

Dimensions are `day`, `week` and `month` (workspace time zone via ClickHouse `toStartOfDay`/`toStartOfWeek`/`toStartOfMonth`), `channel`, `template`, `broadcast`, `journey`, `journey_step`, `purpose`, `variant`, `message_type`, `segment` and `campaign`. Each measure declares its own list; an invalid combination is an `invalid_input` error naming the dimensions that would work. Message `variant` is stored on `message_events` (additive ClickHouse migration `0005`), so it can be reported without joining Postgres. `broadcast` and `journey` derive from the `bct_`/`jrn_` id prefixes; `message_type` is broadcast, journey, transactional or other. `campaign` is resolved from the published campaign's sending members: a message or journey event belongs to the published campaign that owns its broadcast or journey, and the filter takes campaign ids while ClickHouse receives their member ids. A `broadcast` order key sorts by first send, so "the last four issues" is one query with `dimensions:["broadcast"], order:{by:"broadcast",dir:"desc"}, limit:4`.

**Contract.** `analytics.query({measures, dimensions?, from, to, filters?, limit?, order?})` returns `{columns, rows, meta}`. Columns name a dimension or measure and unit; rows are arrays of `string|number|null`; `meta` carries the workspace time zone, the single currency (or null when several), the range, freshness (newest event in range), the suppressed row count, k and notes about opens, ratios and currency. Limits: 1–10 measures, 0–3 dimensions, at most 400 days, 1–5000 rows (default 1000). Filters accept one value or a list for template, broadcast, journey, channel, purpose, variant, conversion name, segment and campaign, subject to what the source supports.

The compiler (`packages/analytics/src/compile.ts`) builds every table, column, expression and alias from the registry, never from the request. Caller values travel only as ClickHouse `{name:Type}` parameters, and every time parameter is `DateTime64(3, 'UTC')`. Ratios are computed in the outer query from the aggregated numerator and denominator, so a rate is never an average of other rates; a zero denominator yields null. When revenue is requested the query groups by a `currency` column, so amounts in different currencies are separate rows and are never added together.

**k-anonymity.** When at least one requested dimension is not a time grain, any row whose base population (distinct profiles for message and journey events, distinct visitors for conversion events, membership count for segments) is below **k = 5** has all its measure values set to null and is counted in `meta.suppressed`. Totals with no dimensions, and time-series rows with only `day`/`week`/`month`, are not suppressed. The command description says so, so an agent can report suppression instead of guessing.

**Named reports.** `analytics.emailPerformance({from,to,by})` and `analytics.journeyFunnel({journeyId,from,to})` are thin wrappers over the same compiler and meta shape. The funnel adds per-step reached counts, drop-off and drop-off rate, plus entered, goal reached, completed and exited. `analytics.metrics.list` lists the catalogue with each measure's description, unit, aggregation, source, allowed dimensions and default grain, so a person or an agent can see what is available before querying. `analytics.campaignSummary({campaignId,from?,to?})` reports one campaign from the same layer: recipients, delivery, clicks, unsubscribes and complaints, converters, conversion rate, revenue per currency and per recipient, progress against the goal's target, the recipients → delivered → clicked → converted funnel, a row per sending member and the holdout result of journey members with a control group. A campaign that has not sent returns a readiness state instead of zeros.

**Holdouts.** `journeys.holdoutResult` and `campaigns.holdoutResult` report, per arm (control and treatment), the people assigned, conversions, conversion rate and e-mail unsubscribes (the guardrail); the campaign result adds revenue per currency. Both give absolute and relative lift, Newcombe's 95% interval for the difference of proportions, whether the minimum sample size is met in both arms, and a verdict. A verdict other than `not_enough_data` needs both samples and an interval that excludes zero. A journey inside a published campaign uses the campaign's control group, so the campaign is measured once across all its sending members; a journey outside one measures its own. Control groups add no measure to the registry: they reuse the `campaign` measures and the journey measures.

**Alerts.** `alerts.list`/`get`/`create`/`update`/`delete`/`test`/`history` evaluate deliverability (bounce or complaint rate above a threshold, with a minimum volume), signup drops and journey errors every five minutes through the metric layer. They notify once when a rule fires and once when it resolves, to a signed webhook or by e-mail to members. They reuse the compiler and meta shape rather than adding a second query contract. Configurable dashboards and scheduled reports are not built: agents read the metric layer, and the UI keeps fixed reports.

Campaign rows follow the same k-anonymity rule as the rest: the base population is the campaign's recipients, so a breakdown group with fewer than five recipients has its measures hidden and is counted in `meta.suppressed`. Campaign measures cannot share a query with the per-channel ones, because the compiler queries one source; `analytics.campaignSummary` runs them side by side and adds their suppressed counts.

**Limits and operations.** Each ClickHouse query sets `max_execution_time = 10` seconds and `max_result_rows = limit`. Results are cached in memory for 60 seconds per workspace and normalised query. The server logs duration, returned rows and rows read (from ClickHouse's summary header when available). Segment sizes are read from Postgres, so they follow membership changes within the same 60-second cache.

**UI.** Insights → Analytics uses the catalogue for its measure and dimension pickers and runs the same `analytics.query` as an agent. A time dimension renders as an ECharts line chart through the existing lazy `Chart` component; the table shows the same numbers, suppression and notes.

## Layer 2 — Bring your own BI

- Documented, versioned **analytics views** in ClickHouse (`analytics.messages_daily`, `analytics.journey_steps`, …) with a read-only role and row policies per workspace.
- Works with Metabase, Apache Superset, Grafana, Power BI, Tableau, Looker Studio (ClickHouse connectors exist for all of them).
- Warehouse export ships: a scheduled export to Postgres or S3-compatible storage as gzipped NDJSON (`warehouse.create`, `warehouse.run`; see [data-platform.md](data-platform.md) §7 and [integrations.md](../integrations.md#warehouse-export)).
- Not embedded in the core: Superset is a heavy Python stack, Metabase is AGPL with paid interactive embedding, Grafana is AGPL. All three remain excellent external tools.

## Layer 3 — Forward to dedicated analytics tools

General web/product analytics is not rebuilt. Events can be forwarded as **destinations**:

| Tool | Fit | Integration |
|---|---|---|
| **Umami** (MIT, self-hosted — the owner already runs it for martechsignal.com) | Privacy-friendly web analytics, cookieless | Destination that forwards page views and selected custom events to Umami's `/api/send` endpoint with the site's website id; consent-aware |
| Matomo (GPL, EU-friendly) | Full web analytics, GDPR features | HTTP Tracking API destination |
| PostHog (MIT core) | Product analytics, funnels, session replay | Capture API destination |
| GA4 | Ubiquitous, but US transfer concerns | Measurement Protocol destination, off by default |

Because ingestion is Segment-spec compatible, the reverse also works: a site can keep its existing Umami script and add our SDK, or send everything through our SDK and let us fan out.

## Upgrade path

If the metrics layer grows into a full semantic layer, **Cube** (Apache-2.0) can sit on top of ClickHouse and serve both our UI and external BI with one set of metric definitions.
