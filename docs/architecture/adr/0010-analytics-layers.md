# ADR-0010: Three-layer analytics, built-in marketing analytics in the core

- Status: Accepted (owner decision 2026-10-21)
- Date: 2026-10-21

## Context
Marketers need reporting on messages, journeys, experiments and revenue; agents need the same numbers to judge their own changes. Teams also have existing BI and web analytics tools (the owner runs self-hosted Umami).

## Decision
1. **Built-in marketing analytics** on ClickHouse with a small code-defined metrics layer, ECharts in the UI, and every report exposed as an `analytics.*` command / MCP tool.
2. **Bring your own BI** through documented read-only ClickHouse views (Metabase, Superset, Grafana, Power BI…), not embedded.
3. **Forward events** to dedicated tools (Umami first, then Matomo, PostHog, GA4) as destinations.

## Alternatives
- Embed Superset or Metabase in the compose file — heavy (Python) or AGPL with paid embedding; adds a second auth and permission model.
- Cube from day one — strong semantic layer, but another service; kept as the upgrade path.
- Rely only on external tools — agents would lose a safe, typed way to read results, and journey/holdout metrics are specific to our data model.

## Consequences
We own a modest set of report queries and views. Holdout groups become a standard journey setting so uplift can be reported honestly.
