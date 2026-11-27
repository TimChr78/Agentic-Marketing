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
| Images, attachments | PostgreSQL (`asset_blobs`) | A small install needs no object store; the app reads the bytes by id and serves them |
| Warehouse exports | S3-compatible object storage (or a Postgres destination) | Gzipped NDJSON for BigQuery, Snowflake and others |

Rule: **Postgres and ClickHouse are sources of truth; Valkey is always rebuildable.**

## 2. Ingestion

- **Protocol:** Segment HTTP Tracking API spec (`identify`, `track`, `page`, `screen`, `group`, `alias`, `batch`). This makes the platform work with existing trackers: Segment `analytics-next` (MIT), RudderStack SDKs (Apache-2.0), Jitsu, and server-side libraries. We ship our own thin JS SDK (`sdk-js`) that wraps tracking + personalization + consent. See [ADR-0008](adr/0008-segment-compatible-ingestion.md).
- **Auth:** public *write keys* per source (browser-safe, can only write events, origin allow-list) and secret keys for server sources.
- **Pipeline (in the `ingest` role, synchronous, cheap):**
  1. Authenticate source, rate-limit per key/IP.
  2. Validate against the **tracking plan** (optional strictness: `allow`, `warn`, `block` unknown events/properties).
  3. **Consent filter:** event carries consent state from the SDK/CMP; events for purposes the visitor has not allowed are dropped or reduced to strictly-necessary.
  4. **PII handling:** top-level event properties marked PII in the tracking plan, and reserved personal property names (`email`, `phone`, `name`, `address`, …), are removed before the event is stored — with or without a published plan. Arbitrary free text and nested objects cannot be detected this way; keep personal data out of event properties. IPs are truncated/geolocated then discarded by default.
  5. **Context shapes:** `context` is kept as the sender wrote it, except for the click-id fields the event store reads: a `context.page` that is not an object, a `page.url`/`page.search` that is not a string, and a `context.clickIds` that is not an object are removed, with a warning in the ingest response. The event itself is kept, so a server-side integration that sends a numeric page URL still records the event; it simply carries no click ids, exactly as if it had sent none. A page that survives with a valid query string still supplies its click ids from `page.url`/`page.search`, so a removed array is not a reason to drop the id the page names. Rows written before this rule may hold `page.search` as the parsed parameters (or as `[name, value]` pairs) instead of a query string; the readers of *stored* context — the subject-key backfill and the ads click-id hook — still read those shapes, so an erasure matches a click id such a row stored. A `context.ip` that is not a string is likewise treated as absent, and the request's own address is used.
  6. Update **session state & real-time counters** in Valkey (so the decision API sees the event immediately).
  7. Publish to NATS JetStream subject `events.<workspace>.<type>` and ack.
- **Async (workers):** bot filtering, geo/UA enrichment, ClickHouse sink (batched inserts ~1 s / 10k rows), identity & profile updates, segment & journey evaluation. The sink and the consumer loop isolate one unreadable record: a payload that cannot be decoded, or a record whose own fields (including a non-UUID workspace id) the store and the erasure filter cannot read, is acknowledged, logged with a fixed reason and its subject or workspace/event id only, and the rest of the batch is stored. Values the writer already defaults — an absent map, a `null` profile id — are normalized and stored.
- **Other sources:** CSV/API bulk import, connector-based sources (Shopify, CRM), provider webhooks (bounces, opens, clicks) — all normalized into the same event shape and bus.

## 3. Identity resolution (deterministic, v1)

```
identifiers(workspace_id, type, value_hash, value_enc, profile_id, first_seen, last_seen)
  type ∈ anonymous_id | user_id | email | phone | custom:<name>
profiles(workspace_id, id, canonical_id, traits jsonb, computed jsonb, created_at, updated_at)
profile_merges(workspace_id, from_id, into_id, reason, at)
```

- Resolution never crosses workspaces: the same e-mail address in two brands is two profiles with two event histories and two consent ledgers ([Multiple brands on one instance](security-and-privacy.md#7-multiple-brands-on-one-instance)).
- Each event carries identifiers (`anonymousId`, `userId`, `traits.email` …). The resolver looks them up; if they point to different profiles and the **merge rules** allow it (e.g. `user_id` and `email` are unique; `anonymous_id` can attach to one known profile), profiles are merged: the older profile survives, `canonical_id` of the other is pointed at it, a `profile.merged` event is emitted.
- **Events are never rewritten** in ClickHouse. ClickHouse keeps the raw identifiers; profile lookup uses an identifier → canonical profile mapping (ClickHouse dictionary refreshed from Postgres, or a replicated mapping table). This keeps merges cheap.
- **A merge carries the person's choices, not just their identifiers.** Topic choices move to the survivor (`merge_topic_preferences`, migration `0069`): the most recent choice wins, an opt-out wins an exact timestamp tie, and the append-only `topic_preference_history` stays on the merged-away id; exports read the whole merged family, and erasure removes it through the profile cascade. Static and snapshot list memberships move too (`merge_segment_memberships`): the earliest addition and its provenance win, duplicate rows collapse, and `segment_list_members` plus `segment_memberships` stay in sync. Dynamic memberships are derived from the rule and are left to the next refresh, which recomputes them from the merged traits. A merge is not an audience change, so it emits no `Segment Entered`/`Segment Exited` events; the person's continuity is preserved rather than treated as a new entry. The same migration repairs tombstones left by merges from older releases; migration `0117` runs the repair once more, through the same function, for rows that a merge stranded before 0.17.1 (#1102).
- Lookups use `value_hash` (HMAC with a workspace secret) so plaintext emails are not needed for matching; `value_enc` holds the encrypted value when it must be displayed/sent.
- **Probabilistic resolution later:** the identity module exposes a `MatchStrategy` interface; a future probabilistic strategy proposes merges with a confidence score that can require human/agent approval.

### Workspace lock protocol (0.15.0)

Every write that must not interleave with an identity merge serialises on one lock per workspace, so a writer never decides the canonical profile from a stale view. The normative text is the header of [`packages/profiles/src/identity.ts`](../../packages/profiles/src/identity.ts); this section says what a contributor adding a writer has to know.

- **Who takes it:** identity resolution (every SDK, form, import and webhook batch, including the fast-path `touch`), every consent writer, merges and erasures. A new writer of consent, identity or erasure state must take it too (`withIdentityLock`, or `withIdentityLocks` for several workspaces in sorted order), before its row writes, in the same transaction.
- **It is a transaction-scoped advisory lock** on `identity:<workspace id>`. Wait and hold times are exported as histograms on `/metrics`.
- **Public paths bound the wait.** The RFC 8058 unsubscribe, preference-centre and topic-link POSTs, the SMS inbound webhook and provider webhooks wait at most two seconds for each workspace lock they take (`withIdentityLock(..., { waitMs })`; a provider webhook batch naming several workspaces waits up to two seconds for each). Past that they answer `503` with a `Retry-After`, so the ESP retries instead of pinning a pool connection behind an import or merge; `am_identity_lock_timeouts_total` counts those refusals. Background workers keep waiting without that bound, because a retry there would replay a batch instead of shedding one request.
- **No network I/O while it is held.** Prepare keys before the transaction (`prepareKeys`) and use the memory-only key provider inside it. No ClickHouse, provider or HTTP call runs under the lock.
- **Order below it:** the lock first, then profile rows in ascending id order (`lockProfileRows`), then journey participant rows. The journey sweep, which cannot take the lock because a wait-until condition may reach ClickHouse, locks a participant's profile with `SKIP LOCKED` before it claims the participant row, so it never waits on a row a batch holds (#1011).
- **Membership writers of one segment** take a second, finer lock: a transaction-scoped advisory lock on `segment:<segment id>` before they write that segment's `segment_memberships` or `segment_list_members` rows (`lockSegmentMemberships`). It is taken by the full refresh, the streaming update (`applyDiff`), `audiences.add`, `audiences.remove`, `audiences.import`, `audiences.snapshot` and `audiences.refreshSnapshot`. Without it two writers of the same segment insert and delete the same people's rows in different orders and each waits for a row the other holds, which PostgreSQL kills as a deadlock (a retryable 409) (#1104).
  - **Order:** identity lock, then profile rows in ascending id order, then this lock, then the membership rows. The list commands lock the profile rows `FOR SHARE` first and only then take it; the refresh and the streaming update take no profile rows after it. No path holds both the identity lock and this one: the consent re-evaluation (`refreshPeople`) runs in its own transaction after the unsubscribe, preference or topic write has committed, without the identity lock, so a merge can commit while it re-evaluates. Nothing takes the segment lock and then waits for the identity lock, so the two orders cannot cross. A transaction that writes several segments takes their locks in ascending segment id order, so the scheduler, the streaming update and the consent re-evaluation cannot lock two segments in opposite orders.
  - **Erasure does not take it either.** `removeProfiles` deletes the family's memberships after locking its profile rows `FOR NO KEY UPDATE`, so the list commands wait on the profile row first; a rare crossing with a refresh insert is a detected deadlock that is retried.
  - **A merge does not take it.** It moves one person's list rows under the identity lock, after it has locked both profile rows, and it never waits for a segment lock. A level-3 holder that waits for a merge's membership row is therefore waiting on a merge that cannot wait for anything the holder has, so the order cannot cross.
  - **The refresh evaluates first, then locks.** `segments.refresh` reads and materialises the rule before taking the lock, so the lock is not held for that segment's own evaluation. It is transaction-scoped, though, and lasts until commit: the refresh command, the scheduler round and the segment hook publish their change events to the bus inside the same transaction (publishing before commit is how redelivery is deduplicated), and in a transaction that refreshes several segments, the locks of the earlier ones stay held while the later ones are evaluated against the event store. Unlike the identity lock, this lock therefore does see network I/O. That costs contention, not correctness: a refresh of one segment can queue behind a slow scheduler round or a stalled bus, and ascending order keeps it deadlock-free. A streaming update that commits in that window is overwritten by the refresh and recomputed at the next one; without the lock the two could deadlock instead, and one caller would lose its whole transaction.
  - **Mixed versions are retried, not corrupt.** An older writer that skips the lock can still collide with a newer one; PostgreSQL detects the deadlock, rolls the losing transaction back and the caller retries. No row is written twice or lost, which is why this finer lock does not change the writer protocol version (unlike the 0.15.0 identity lock and the 0.17.0 erasure contract, where a mixed-version writer would decide from a stale view).
- **Sends never take it.** Nothing that takes the identity lock also takes a broadcast run row or a send key (`lockSendKey`), so the two orders cannot cross.
- **The second family is agent policy.** An agent's write takes `agent-policy`, then approval request rows (`lockApproval`), then artifact rows in id order (`lockArtifacts`), then the mandate validator's `am.agent-mandate` lock. It is documented at [`apps/server/src/agents/holds.ts`](../../apps/server/src/agents/holds.ts) and [`packages/artifacts/src/mandates.ts`](../../packages/artifacts/src/mandates.ts). A person's mandate publish and the mandate repair skip `agent-policy` and start at the artifact rows.
- **Upgrades:** old and new writers must never run at the same time when the protocol changes. That is why 0.15.0 and 0.17.0 are drained upgrades ([UPGRADING.md](../../UPGRADING.md)). Since 0.17.2 the migration records the protocol version in `writer_protocol`, and a server refuses to start when the database expects a newer one than it implements. The Helm chart recreates every writer role; a protocol-changing upgrade still starts with a full scale-to-zero drain, because the four Deployments roll independently.

The protocol tests (`packages/profiles/test/lock-protocol.test.ts`, `apps/server/test/v0172-segment-lock.test.ts` and the `v015*` server tests) pin the behaviour. A writer that breaks the order shows up as a deadlock (`40P01`) or a latency incident, so check new writers against this list in review.

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

Plus tables for `message_events` (sent/delivered/bounced/opened/clicked/unsubscribed), `journey_events` (entered/step/exited/goal) and `decision_events` (personalization & AI decisions with explanation) — these power analytics and give agents an explainable history. Journey split results (`journeys.splitResult`, 0.6.0) are computed on demand from `journey_events`, not stored as another table.

**Pagination (#397).** `profiles.export` returns `eventsTruncated` when retained events exceed `maxEvents`; use `profiles.events` with its composite cursor or a larger export bound to retrieve the remainder. Event browsing (`profiles.events`), the DSR export (`profiles.export`) and `profiles.list` page with a stable `(timestamp, id)` keyset, newest first. `profiles.events` uses `(timestamp, event_id)` and `profiles.list` uses `(last_seen, id)`; both return `nextCursor` containing the exact values for the next page. Cursors carry the store's full precision (Postgres microseconds, ClickHouse milliseconds) and are validated as timestamps before they reach a database cast. The older timestamp-only `before` field is still accepted for one release: without `beforeId` it keeps its strict `timestamp < before` semantics, which can omit rows sharing the boundary timestamp, so new traversal must pass the composite cursor.

**Conversion reads (#366).** Campaign uplift and `ai.calibration` read goal events through a bounded `(timestamp, event_id)` keyset over the whole attribution window; there is no workspace-wide row cap. Campaign reads are also scoped to the campaign's profile ids and identifiers, so unrelated workspace traffic cannot crowd out a late conversion.

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

A condition can count the platform's own engagement instead of a customer event: `message` names
what happened to a message it sent, read from ClickHouse `message_events` (#441).

```json
{ "message": "opened", "within": "P30D", "count": { "gte": 2 },
  "channel": "email", "purpose": "marketing_email", "broadcast": "bct_…" }
```

- `message` is `delivered`, `opened`, `clicked`, `bounced`, `complained` or `unsubscribed`.
- `within` is an ISO 8601 window (at most 25 months, the message history that is kept), `count` the
  number of such messages (default at least once; `{"lte": 0}` is "never"), `channel` narrows to
  `email`, `sms` or `push`, and `purpose` to a published purpose key.
- **Distinct messages, not events:** `count` counts the messages that met the condition, not the
  engagement rows. Two pixel fetches for one issue (a mailbox that pre-fetches images) or two clicks
  on one link are one message. That is why `{"gte": 2}` means "opened two issues", not "opened twice".
- **How long the log is kept:** `message_events` has a ClickHouse TTL of 25 months
  (`0002_message_events.sql`). A message leaf without `within` reads the whole history that is kept,
  which the builder and this document name as "the last 25 months (how long message history is
  kept)". A new window longer than 25 months is refused when a segment is saved, because the TTL
  would silently clamp it; a window saved before that check keeps working, and republishing that
  version is refused until the window is shortened. Lifetime "ever opened" rules therefore have a
  25-month horizon: do not build a segment whose membership must never decay on a message condition
  without a window.
- `broadcast` or `journey` (not both) counts only the messages that send produced.
- `not`, `all` and `any` compose it like any other leaf, and a merge is followed: messages recorded
  under a profile that was later merged in count for the person it became.
- **How opens are measured:** an open comes from the provider's tracking pixel, so it exists only
  where the adapter or the workspace tracks opens (open-pixel tracking is off by default;
  `packages/email` adapters such as Brevo add their own). No mailbox or proxy marker is stored, so a
  privacy-conscious mailbox that pre-fetches the pixel counts as an open. Treat opens as a hint and
  clicks as a signal, and prefer `clicked` for offers that must not overstate engagement.
- **When it moves people:** opens and clicks are message events, not customer events, so a message
  leaf never triggers a streaming evaluation on its own. A rule that also holds a streamable leaf (a
  trait, an event, consent or a segment reference) is evaluated when that leaf's input changes, and
  its message leaves are evaluated then too; `refreshPeople` (a consent write or a preference-centre
  link) likewise re-evaluates every rule for the affected people, message leaves included. Otherwise
  membership moves on the next recompute — the scheduler's regular pass or `segments.refresh` — and
  a journey's wait-until checks one person at once. The builder's estimate is a live count from
  `segments.preview`, so it can differ from the stored membership (what a send uses) until the next
  refresh; the builder and the estimate panel say so.

Two evaluation modes from the same definition:

| Mode | Used for | How |
|---|---|---|
| **Batch** | Historic conditions, large audiences, campaign sends, previews | Compiled to ClickHouse SQL (+ Postgres for traits); scheduled or on demand |
| **Streaming** | Real-time entry/exit that triggers journeys and personalization | Workers keep per-profile condition state (windowed counters in Valkey, persisted checkpoints in Postgres) and evaluate on each relevant event; emit `segment.entered/exited` |

The compiler marks which conditions are streamable; non-streamable ones fall back to frequent batch recomputation. Memberships are stored in Postgres (`segment_memberships`) and mirrored to Valkey for the decision API. Memberships are also the input to bulk journey enrollment (`journeys.enrollSegment`, 0.6.0): the scheduler scans them in chunks of 500, runs a resumable job pinned to the journey and segment versions, and leaves the normal event and segment-entry triggers to handle ongoing entry.

## 7. Warehouse & data portability

- **Export (built, Phase 10):** a scheduled export to Postgres or S3-compatible storage, as gzipped NDJSON. Datasets: profiles, identifiers, consent, segment memberships, events and message events. Commands `warehouse.create`, `warehouse.run`; details in [integrations.md](../integrations.md#warehouse-export).
- **Import (not built):** "warehouse-native" sources — sync traits/audiences from a warehouse table into profiles.
- Decided: the platform is the **system of record** for profiles; a warehouse runs alongside it, not in front of it.

Signed topic and preference-centre links issued before a merge follow the surviving profile for reads, writes and segment updates. Topic writes share the identity-merge transaction lock and re-resolve the current profile before writing; prior history remains append-only.
