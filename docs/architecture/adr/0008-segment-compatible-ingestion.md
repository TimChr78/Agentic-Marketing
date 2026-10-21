# ADR-0008: Segment-spec compatible ingestion with own gateway

- Status: Proposed
- Date: 2026-10-21

## Context
Ingestion should work with existing tracking libraries and be in-process for low latency (session state for in-session personalization must be written before ack).

## Decision
Implement our own `ingest` role speaking the **Segment HTTP Tracking API** spec (identify/track/page/screen/group/alias/batch). Our `sdk-js` uses the same protocol and adds consent + personalization. Third-party SDKs (Segment analytics-next, RudderStack SDKs, Jitsu) can point to it directly.

## Alternatives
- **RudderStack server** — AGPL-3.0 with enterprise-only features; another service to run.
- **Jitsu (MIT)** — capable, but brings its own stack (Kafka/Redpanda, ClickHouse, Mongo/Postgres); could still be used as an upstream source.

## Consequences
We own the gateway code (moderate size). Compatibility with the de-facto event spec means low lock-in for users.
