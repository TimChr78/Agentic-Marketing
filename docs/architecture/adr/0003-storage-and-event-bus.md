# ADR-0003: PostgreSQL, ClickHouse, NATS JetStream and Valkey

- Status: Accepted (event path validated by spike 4)
- Date: 2026-10-21

## Context
We need transactional config/profile/journey state, an analytical event store for hundreds of millions of events, a durable low-latency event bus with fan-out to several consumers, and sub-millisecond hot state for personalization. Every extra component is a burden for self-hosters.

## Decision
| Need | Component |
|---|---|
| Transactions, profiles, journey state, job queue | PostgreSQL |
| Events, message/journey/decision logs, analytics | ClickHouse |
| Event bus (durable streams, consumer groups, replay) | NATS JetStream |
| Session state, real-time counters, caches, rate limits | Valkey |

Postgres and ClickHouse are sources of truth; NATS retains a replay window; Valkey is rebuildable.

## Alternatives
- **Kafka** — the standard at very large scale, but heavy for a `docker compose` install. The `EventBus` port keeps a Kafka implementation possible.
- **Redpanda** — BSL license.
- **Redis Streams in Valkey only** — fewer components, but weaker retention/replay semantics and memory-bound; acceptable fallback for a "lite" profile if NATS proves a burden.
- **Postgres only (no ClickHouse)** — simpler, but event-window segments and analytics degrade badly beyond tens of millions of events.
- **ClickHouse NATS table engine** instead of an app-side sink — fewer moving parts, but less control over PII handling, enrichment and backpressure; reconsider later.

## Consequences
Four stateful services to run (plus object storage). Each is a single container in the default compose file, and each has a well-trodden clustering path.

## Validation (spike 4, 2026-10-22)
[`spikes/event-pipeline/FINDINGS.md`](../../../spikes/event-pipeline/FINDINGS.md): ingest gateway → JetStream → batched ClickHouse sink on one 4-vCPU machine. ~18k events/s per Node ingest process; 1M events with 0 per-visitor ordering violations across 16 shards; no loss or visible duplicates after a sink SIGKILL and a crash between INSERT and ack (at-least-once + `ReplacingMergeTree` on `event_id`); 7× compression; segment and funnel queries over 1M events in 13–47 ms. ClickHouse ran embedded (chDB, same engine) because the server download was blocked; server-mode numbers are re-checked in Phase 1. Consumers need an explicit `ack_wait` (5 s) shorter than the 30 s default.

