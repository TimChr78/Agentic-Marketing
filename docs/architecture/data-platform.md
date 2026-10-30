# Data platform

The data platform is the foundation: everything else (segments, journeys, personalization, AI) reads from it. It has four parts: **ingestion**, **identity & profiles**, the **event store**, and **segments**.

## 1. Storage split

| Data | Store | Why |
|---|---|---|
| Configuration, artifacts & versions, users, consent ledger, audit log | PostgreSQL | Transactions, constraints, RLS |
| Profiles (traits), identifiers, identity graph | PostgreSQL | Point reads/writes by id, merges need transactions; 10M rows is comfortably in range |
| Journey participants, timers, job queue | PostgreSQL | Transactional "update state + enqueue next step" |
| Raw & enriched events, message deliveries, engagement, AI decision logs | ClickHouse | Append-heavy, analytical queries, compression, TTL-based retention |
| Session state, real-time counters, profile snapshots for decide, rate limits | Valkey | Sub-millisecond reads on the hot path; rebuildable from PG/CH |
| Images, attachments, exports | S3-compatible object storage (or local filesystem driver) | Blobs |

Rule: **Postgres and ClickHouse are sources of truth; Valkey is always rebuildable.**

## 2. Ingestion

- **Protocol:** Segment HTTP Tracking API spec (`identify`, `track`, `page`, `screen`, `group`, `alias`, `batch`). This makes the platform work with existing trackers: Segment `analytics-next` (MIT), RudderStack SDKs (Apache-2.0), Jitsu, and server-side libraries. We ship our own thin JS SDK (`sdk-js`) that wraps tracking + personalization + consent. See [ADR-0008](adr/0008-segment-compatible-ingestion.md).
- **Auth:** public *write keys* per source (browser-safe, can only write events, origin allow-list) and secret keys for server sources.
- **Pipeline (in the `ingest` role, synchronous, cheap):**
  1. Authenticate source, rate-limit per key/IP.
  2. Validate against the **tracking plan** (optional strictness: `allow`, `warn`, `block` unknown events/properties).
  3. **Consent filter:** event carries consent state from the SDK/CMP; events for purposes the visitor has not allowed are dropped or reduced to strictly-necessary.
  4. **PII handling:** properties tagged as PII in the tracking plan are encrypted (see crypto-shredding) or dropped per policy; IPs truncated/geolocated then discarded by default.
  5. Update **session state & real-time counters** in Valkey (so the decision API sees the event immediately).
  6. Publish to NATS JetStream subject `events.<workspace>.<type>` and ack.
- **Async (workers):** bot filtering, geo/UA enrichment, ClickHouse sink (batched inserts ~1 s / 10k rows), identity & profile updates, segment & journey evaluation.
- **Other sources:** CSV/API bulk import, connector-based sources (Shopify, CRM), provider webhooks (bounces, opens, clicks) — all normalized into the same event shape and bus.

## 3. Identity resolution (deterministic, v1)

```
identifiers(workspace_id, type, value_hash, value_enc, profile_id, first_seen, last_seen)
  type ∈ anonymous_id | user_id | email | phone | custom:<name>
profiles(workspace_id, id, canonical_id, traits jsonb, computed jsonb, created_at, updated_at)
profile_merges(workspace_id, from_id, into_id, reason, at)
```

- Each event carries identifiers (`anonymousId`, `userId`, `traits.email` …). The resolver looks them up; if they point to different profiles and the **merge rules** allow it (e.g. `user_id` and `email` are unique; `anonymous_id` can attach to one known profile), profiles are merged: the older profile survives, `canonical_id` of the other is pointed at it, a `profile.merged` event is emitted.
- **Events are never rewritten** in ClickHouse. ClickHouse keeps the raw identifiers; profile lookup uses an identifier → canonical profile mapping (ClickHouse dictionary refreshed from Postgres, or a replicated mapping table). This keeps merges cheap.
- Lookups use `value_hash` (HMAC with a workspace secret) so plaintext emails are not needed for matching; `value_enc` holds the encrypted value when it must be displayed/sent.
- **Probabilistic resolution later:** the identity module exposes a `MatchStrategy` interface; a future probabilistic strategy proposes merges with a confidence score that can require human/agent approval.

## 4. Profiles & attribute schema

- Traits are stored in `jsonb` but **governed by an attribute schema** per workspace: type, PII class (`none`, `personal`, `sensitive`), allowed purposes, retention, and whether agents/LLMs may see it.
- **Computed traits** (e.g. `orders_count_90d`, `last_seen_at`, `predicted_ltv` later) are defined like segments and materialized by workers.
- The attribute schema is the single place where privacy rules attach to data — the LLM context builder, exports, the decision API and DSR all consult it.

## 5. Event store (ClickHouse)

```sql
CREATE TABLE events (
  workspace_id   UUID,
  event_id       UUID,          -- idempotent insert key
  received_at    DateTime64(3),
  sent_at        DateTime64(3),
  type           LowCardinality(String),  -- track/page/identify…
  name           LowCardinality(String),  -- event name
  anonymous_id   String,
  user_id        String,
  session_id     String,
  properties     JSON,          -- PII fields already encrypted/dropped at ingest
  context        JSON,
  consent        Map(LowCardinality(String), UInt8)
) ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(received_at)
ORDER BY (workspace_id, name, anonymous_id, received_at, event_id)
TTL received_at + INTERVAL 25 MONTH;   -- configurable retention
```

Plus tables for `message_events` (sent/delivered/bounced/opened/clicked/unsubscribed), `journey_events` (entered/step/exited/goal), `decision_events` (personalization & AI decisions with explanation) — these power analytics and give agents an explainable history.

At 10M profiles × ~50 events/profile/month ≈ 500M rows/month, which a single ClickHouse node handles well; clustering is a later step (see [deployment-and-scaling.md](deployment-and-scaling.md)).

## 6. Segments

**Segment DSL** — a JSON AST (also what agents read/write):

```json
{
  "all": [
    { "trait": "country", "op": "eq", "value": "DK" },
    { "event": "product_viewed", "where": { "category": "shoes" },
      "count": { "gte": 3 }, "within": "P7D" },
    { "not": { "segment": "seg_customers" } }
  ]
}
```

Two evaluation modes from the same definition:

| Mode | Used for | How |
|---|---|---|
| **Batch** | Historic conditions, large audiences, campaign sends, previews | Compiled to ClickHouse SQL (+ Postgres for traits); scheduled or on demand |
| **Streaming** | Real-time entry/exit that triggers journeys and personalization | Workers keep per-profile condition state (windowed counters in Valkey, persisted checkpoints in Postgres) and evaluate on each relevant event; emit `segment.entered/exited` |

The compiler marks which conditions are streamable; non-streamable ones fall back to frequent batch recomputation. Memberships are stored in Postgres (`segment_memberships`) and mirrored to Valkey for the decision API.

## 7. Warehouse & data portability

- **Export (built, Phase 10):** a scheduled export to Postgres or S3-compatible storage, as gzipped NDJSON. Datasets: profiles, identifiers, consent, segment memberships, events and message events. Commands `warehouse.create`, `warehouse.run`; details in [integrations.md](../integrations.md#warehouse-export).
- **Import (not built):** "warehouse-native" sources — sync traits/audiences from a warehouse table into profiles.
- Decided: the platform is the **system of record** for profiles; a warehouse runs alongside it, not in front of it.
