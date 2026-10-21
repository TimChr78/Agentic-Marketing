# ADR-0003: PostgreSQL, ClickHouse, NATS JetStream and Valkey

- Status: Proposed
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
