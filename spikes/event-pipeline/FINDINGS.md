# Spike 4 — Ingest → NATS JetStream → ClickHouse: throughput, ordering, crash recovery

**Question:** does the event path in [ADR-0003](../../docs/architecture/adr/0003-storage-and-event-bus.md) / [ADR-0008](../../docs/architecture/adr/0008-segment-compatible-ingestion.md) hold up on one machine: Segment-style ingest gateway → JetStream → batched ClickHouse sink, with per-profile ordering for the real-time consumers and no loss or duplicates when the sink crashes?

**Answer: yes, with lots of headroom.** One Node ingest process published ~16–18k events/s to JetStream (the load generator shared the same 4 vCPUs); 1M events reached ClickHouse with no loss, no visible duplicates and **0 per-profile ordering violations**, including a SIGKILL of the sink and a crash between INSERT and ack. That is about 10× the 1–2k events/s per ingest pod assumed in the scaling plan.

## Setup

- `nats-server` 2.15.0 (built from the Go module proxy), JetStream with file storage, stream `EVENTS` on `events.<workspace>.<shard>`, 16 shards by hash of the anonymous id, 2-minute duplicate window keyed on the event's `messageId`.
- **Ingest gateway** (`src/ingest.ts`, Hono): validates a Segment-style batch, respects a consent flag, stamps workspace and `receivedAt`, publishes every event with `msgID` and answers after JetStream acks.
- **Load generator**: 100k visitors, batches of 50 events, 32 concurrent requests.
- **ClickHouse sink** (`src/sink.ts`): durable pull consumer, micro-batches of ≤ 20k rows or 1 s, `INSERT … FORMAT JSONEachRow`, ack after insert; `ReplacingMergeTree` ordered by `(workspace_id, name, anonymous_id, ts, event_id)`.
- **Ordered consumers** (`src/ordered.ts`): one durable consumer per shard, strictly sequential, checking that each visitor's events arrive with seq = previous + 1. This is how profile, segment and journey-trigger workers will consume.
- **ClickHouse** ran embedded via **chDB 3.4 (ClickHouse 26.7 engine)** because the ClickHouse server download host is blocked in this environment. Same MergeTree storage and SQL; no network hop or server-side async inserts. Server numbers should be re-checked in Phase 1, but the engine is the same.
- Machine: 4 vCPU / 15 GB; NATS, ingest, load generator, sink and ordered consumers all on it.

## Results (`pnpm bench 500000`: two phases of 500k events)

| Measure | Result |
|---|---|
| Ingest, 1 process → JetStream (acked) | **~18,000 events/s** · request p50 86 ms / p95 124 ms for 50-event batches |
| Ingest, 2 processes | ~19,700 events/s (CPU-bound: generator, NATS and sink share 4 vCPUs) |
| Sink throughput | kept pace with ingest; caught up 2.8 s after load ended |
| Ingest → ClickHouse lag per batch | p50 **1.7 s** (1-second batching window) · p95 7.2 s, max 9 s during the crash phase |
| Per-profile ordering, 16 shards × 1M events | **0 violations** |
| Sink SIGKILL mid-stream + a sink that exits after INSERT, before ack | ClickHouse ends with `count() = uniqExact(event_id) = FINAL count = 1,000,000` |
| JetStream duplicate window | a re-sent batch with the same `messageId`s was dropped server-side (seen in an earlier run) |
| Storage | JetStream 468 MB for 1M events (7-day retention); ClickHouse **26 MB on disk for 187 MB raw** (≈ 7×) |
| Queries on 1M events | `count`/`uniqExact` 93 ms · real-time-style segment ("≥ 3 shoe views") **13 ms** · 4-step `windowFunnel` 47 ms |

## Findings for the architecture

1. **The ingest estimate was far too conservative**: ~18k events/s per Node process instead of 1–2k. The 10M-profile peak of ~5k events/s fits in one or two ingest processes. → `deployment-and-scaling.md` updated.
2. **At-least-once into ClickHouse is the right contract.** Ack after insert, `ReplacingMergeTree` on `event_id`, and dedupe-aware queries (`FINAL`, `uniqExact`, `argMax`) wherever exact counts matter. Duplicates from a crash can be visible until the next merge.
3. **Set `ack_wait` deliberately.** The default 30 s meant a crashed sink delayed redelivery by 30 s; 5 s brought the worst-case lag down to ~9 s. Batches must finish well within `ack_wait`.
4. **Ordering comes from sharding plus a sequential consumer per shard.** Hashing the visitor onto 16 subjects gave strict per-visitor order with parallelism across shards. Identity merges (anonymous id → user id) need the shard key to stay stable: shard by the *first* anonymous id and carry it on later events, or route by resolved profile id after resolution.
5. **JetStream's `msgID` dedupe** makes SDK retries safe within the duplicate window (2 minutes here). The ClickHouse dedupe covers longer gaps.
6. **Compression is excellent** (≈ 7×) with plain `JSON` columns; retention costs are dominated by JetStream's replay window, not ClickHouse.

## Not covered

- ClickHouse **server** (HTTP inserts, async inserts, replication); chDB used the same engine in-process.
- Multi-node NATS cluster and replicated streams.
- The SDK side (browser batching, retries, consent handling) and bot filtering.
- Identity resolution and real-time segment evaluation on the ordered consumers. The consumers here only check order.

## Run it

```bash
# needs nats-server on PATH or NATS_BIN=/path/to/nats-server (go install github.com/nats-io/nats-server/v2@v2.15.0)
pnpm install
pnpm --filter @agentic-marketing/spike-event-pipeline bench 500000
```
