# Analytics & reporting

Decision: [ADR-0010](adr/0010-analytics-layers.md). Three layers; only the first is part of the core.

## Layer 1 — Built-in marketing analytics (core)

All events, message events, journey step logs and decision logs already land in ClickHouse ([data-platform.md](data-platform.md) §5), so marketing reporting is cheap to provide in-product:

| Report | Source tables | Notes |
|---|---|---|
| E-mail performance (sent, delivered, clicks, unsubscribes, complaints, bounces) | `message_events` | Open rate shown only where pixel tracking is enabled (off by default) |
| Journey funnel per step, waiting counts, drop-off | `journey_events` | Live overlay on the journey canvas |
| Goal conversion **with holdout uplift** | `journey_events` + `events` | Holdout/control groups per journey give incremental effect, not just attributed orders |
| Experiments (A/B/n) for messages and web experiences | `decision_events`, `events` | Sequential testing first, Bayesian later |
| Web personalization exposures & uplift | `decision_events` | |
| Segment growth, consent opt-in/objection rates | `segment_memberships`, consent ledger | Consent reporting doubles as GDPR evidence |
| Deliverability (per domain/provider) | `message_events` | |
| LLM usage & cost per journey/purpose | metering events | Feeds budgets |

Implementation:
- A small **metrics layer** in code: named measures and dimensions over curated ClickHouse views (`metric('email.click_rate').by('journey', 'day')`). Queries are parameterised and tenant-scoped; no raw SQL from the UI or from agents.
- Charts in the UI with **Apache ECharts** (Apache-2.0), themed from the design tokens.
- Every report is also a command (`analytics.*`) and therefore an **MCP tool**, so agents can evaluate their own changes ("did the v4 subject lines help?").
- Privacy: reports are aggregates; a minimum group size (e.g. k ≥ 5) can be enforced for breakdowns; the `analytics` purpose is respected at ingest.

## Layer 2 — Bring your own BI

- Documented, versioned **analytics views** in ClickHouse (`analytics.messages_daily`, `analytics.journey_steps`, …) with a read-only role and row policies per workspace.
- Works with Metabase, Apache Superset, Grafana, Power BI, Tableau, Looker Studio (ClickHouse connectors exist for all of them).
- Later: scheduled Parquet export to S3 and warehouse sync ([data-platform.md](data-platform.md) §7).
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
