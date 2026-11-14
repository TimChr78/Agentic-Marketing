# System overview

> Status: describes **0.14.21**. Waves 1–3 are built through Phase 16; wave 4 shipped Phases 17–22 (0.3.0–0.8.0) and wave 5 shipped Phases 23–28 (0.9.0–0.14.0). See [roadmap.md](roadmap.md) for the wave 1 plan, [roadmap-wave-4.md](roadmap-wave-4.md) and [roadmap-wave-5.md](roadmap-wave-5.md) for the later waves, and [agentic-autonomy.md](agentic-autonomy.md) for what agents may do today.

## 1. System context

```mermaid
flowchart TB
  marketer([Marketer / admin])
  agent([AI agent<br/>internal copilot or external MCP client])
  visitor([Website visitor / customer])
  dev([Developer / integrator])

  P[Agentic Marketing Platform]

  esp[(Email service providers)]
  llm[(LLM providers<br/>OpenAI- / Anthropic-compatible, BYOK)]
  ext[(External systems<br/>Shopify, CRM, warehouse, n8n)]

  marketer -->|builds journeys, templates, segments| P
  agent -->|MCP tools: same capabilities as UI| P
  visitor -->|web events, receives personalization & email| P
  dev -->|SDKs, REST API, webhooks, connector SDK| P
  P --> esp
  P --> llm
  P <--> ext
```

## 2. Containers (runtime roles)

The platform is **one codebase and one container image**. A `ROLE` env var (or several, comma-separated) selects which modules a process runs; the only valid values are `api`, `ingest`, `worker`, `scheduler` and `all`, and anything else is a start-up error. On a small install a single process runs all roles; at scale each role is deployed and scaled independently.

| Role | Responsibility | Latency class | Scales by |
|---|---|---|---|
| `api` | Command layer: REST, MCP (streamable HTTP), UI RPC, auth, static UI | interactive (<300 ms) | users / agents |
| `ingest` | Event intake (Segment-spec HTTP API), validation, consent filter, identity hints, session-state update, publish to bus; also the web personalization decision API (`/v1/decide`), which reads hot state from Valkey | hot path (<20 ms p95 ingest, <50 ms p95 decide) | events/s, page views/s |
| `worker` | Bus consumers: ClickHouse sink, profile updater, segment evaluator, journey trigger matcher; journey step execution; sends | near real time (<5 s) | events/s, journey steps/s |
| `scheduler` | Timers (journey waits, scheduled segment recomputes, campaign schedules), maintenance jobs | seconds | one replica (`Recreate`): its loops are not coordinated across processes |

```mermaid
flowchart LR
  subgraph edge["Public edge (Caddy / ingress)"]
    direction TB
  end
  sdk[JS SDK] -->|track| ingest
  sdk -->|decide| ingest
  browser[UI SPA] --> api
  mcp[MCP clients] --> api

  ingest --> nats[[NATS JetStream]]
  ingest --> valkey[(Valkey)]
  api --> pg[(Postgres)]
  api --> ch[(ClickHouse)]
  api --> nats

  nats --> worker
  worker --> pg
  worker --> ch
  worker --> valkey
  scheduler --> pg
  worker --> providers[Channel providers]
  worker --> llm[LLM providers]
```

## 3. Module boundaries (inside the monolith)

Modules communicate through **typed in-process interfaces and bus events**, never by reaching into each other's tables. This keeps the option of extracting a module into its own service later.

```
packages/
  core/            # ids, errors, canonical JSON hashing, time and network helpers
  db/              # SQL migrations and runner, Drizzle schema, owner and RLS pools
  commands/        # command registry: defineCommand(), authz, idempotency, audit
  artifacts/       # versioned artifacts, approvals, diffs, bundles, holdouts, hosted pages
  secrets/         # envelope encryption, key providers, write-only secret commands
  auth/            # Better Auth, OAuth 2.1 for MCP clients, members, SSO/SCIM, API tokens, agents and hosted runs
  telemetry/       # pino logger, optional OpenTelemetry tracing, Prometheus metrics
  events/          # NATS bus, ClickHouse event store and sink, event schemas
  ingest/          # Segment-compatible ingest gateway, source keys, consent policy
  hotstate/        # Valkey session and profile snapshot for the decision API
  profiles/        # profiles, identity resolution, consent ledger, per-person encryption
  segments/        # segment DSL, SQL compiler, streaming evaluator, static lists, snapshots, CSV
  journeys/        # journey graph model, interpreter, entry keys, wait-until, control groups, bulk enrollment
  audience/        # signup forms, broadcasts, hosted pages, archive, import, message events, retention
  content/         # content sources, article library, topic backlog, content briefs
  email/           # send gateway, e-mail/SMS/push adapters, templates, blocks, checks, delivery policy
  campaigns/       # campaign members, shared UTM campaign, control-group helpers
  personalize/     # experiences, decision engine, A/B allocation and results, edge decide
  analytics/       # read-only metric layer: query catalogue, named reports, campaign summary
  alerts/          # threshold alert rules, five-minute evaluator, notifications
  ai/              # LLM gateway and providers, prompt tests, AI steps, copilot, context and redaction
  ads/             # ad platform connectors and conversions, audience sync, click ids, spend import
  integrations/    # connections, connector SDK, webhooks, OAuth, egress guard, Shopify import
  assets/          # image and PDF asset library, SVG cleaning, PNG renditions, asset routes
  warehouse/       # warehouse export datasets and destinations
  client/          # typed REST client inferred from the command registry
  edge-worker/     # the decision API as a Cloudflare Worker
  sdk-js/          # browser SDK: tracking, consent banner, personalization and push
apps/
  server/          # composes modules into roles (api, ingest, worker, scheduler)
  web/             # React admin UI (app shell and router, ui, features, pages) and the demo
```

## 4. Key data flows

### 4.1 Web event → journey trigger (near real time)

```mermaid
sequenceDiagram
  participant SDK as JS SDK
  participant ING as Ingest
  participant VK as Valkey
  participant BUS as NATS JetStream
  participant W as Workers
  participant PG as Postgres
  participant CH as ClickHouse

  SDK->>ING: POST /v1/batch (track/page/identify)
  ING->>ING: auth write key, validate vs tracking plan,<br/>drop if no consent for purpose, tag PII
  ING->>VK: update session state & RT counters (read-your-writes for decide)
  ING->>BUS: publish events.{workspace}.{type}
  ING-->>SDK: 200 (accepted)
  par consumers (independent durable consumers)
    BUS->>W: ClickHouse sink (batched inserts)
    W->>CH: INSERT events
  and
    BUS->>W: identity & profile updater
    W->>PG: upsert identifiers / traits, merge profiles
  and
    BUS->>W: segment streaming evaluator
    W->>BUS: segment.entered / segment.exited
  and
    BUS->>W: journey trigger matcher
    W->>PG: create participant + enqueue step (same txn)
  end
```

### 4.2 Journey step → message

```mermaid
sequenceDiagram
  participant Q as Due participants (Postgres sweeper)
  participant J as Journey interpreter
  participant SG as Send gateway
  participant C as Consent ledger
  participant AD as Email adapter (e.g. SES)

  Q->>J: run step (participant, node, attempt)
  J->>J: evaluate node (branch / wait / action / AI)
  J->>SG: send(message intent, purpose, idempotency key)
  SG->>C: lawful basis for purpose+channel?
  C-->>SG: allowed (consent | legitimate interest, not objected)
  SG->>SG: suppression, frequency cap, quiet hours
  SG->>AD: render MJML+Liquid → send
  AD-->>SG: provider message id
  SG->>Q: record delivery, enqueue next node (same txn)
  Note over AD,SG: bounces / complaints / opens / clicks come back via webhooks → ingest as events
```

### 4.3 Agent edits a journey

```mermaid
sequenceDiagram
  participant A as Agent (MCP)
  participant API as Command layer
  participant ART as Artifacts
  participant H as Human approver

  A->>API: artifacts.create / artifacts.updateDraft
  API->>ART: new draft version (author = agent principal)
  A->>API: journeys.simulate (sample profiles)
  A->>API: artifacts.requestPublish
  alt workspace approval policy = none
    API->>ART: publish
  else approval required
    ART-->>H: notification + visual diff
    H->>API: approvals.approve
    API->>ART: publish (immutable version)
  end
```

## 5. Cross-cutting conventions

- **Tenancy:** every table has `workspace_id` (plus `organization_id` reserved for SaaS); every bus subject and ClickHouse row carries it. Postgres Row Level Security is enabled from day one so a missed `WHERE` cannot leak data across workspaces.
- **IDs:** UUIDv7 (time ordered, index friendly) everywhere; external-facing IDs prefixed (`jrn_`, `tpl_`, `prf_`).
- **Idempotency:** every command and every side effect accepts an idempotency key (`idempotency-key` on REST, `idempotencyKey` on an MCP write); the send gateway also deduplicates on `(participant, node, attempt-group)`. The key is scoped to the workspace and to the caller (a person's user id, or one agent record per API token/OAuth connection). Every caller presenting one key serialises on the same pre-handler lock: the second returns the first one's stored response, and the key is remembered for the life of the workspace. A replay returns that response without running the agent policy engine, the agent counters or the billed independent check; authentication, permissions, input validation and the current agent status still run first, so a paused or revoked agent gets its usual refusal instead of a replay. A key reused for a different command, input or caller answers `409` with `details.reason: "idempotency_key_reused"` before the handler and before policy. The same rule applies to the input-level keys of a direct send (`messages.sendEmail`/`sendSms`/`sendPush`) and `journeys.enrollSegment`: the stored row names the request by an immutable fingerprint (the caller plus the recipient, template and variables as supplied, or the journey, segment, versions and limit), and a different caller or input answers the same conflict instead of receiving the first caller’s message or job. The fingerprint is computed before resolution, so a retry with a since-merged profile id still replays, and internal journey, broadcast and system sends fingerprint their stable identifiers rather than a re-rendered payload. Concurrent requests for one input-level key serialise on their own advisory lock before the lookup, so the loser replays or answers `409`, never a database error. Rows written before the fingerprint was stored match on their stored recipient and template columns. If the first request is still running after ten seconds the answer is `409` with `details.reason: "idempotency_in_progress"`, and the caller must retry with the **same** key (a new key would run the operation again) instead of deadlocking the connection pool. REST keeps accepting every non-empty header value it accepted before (only an empty header is now refused); the MCP argument and a caller-supplied typed-client key must be 1–200 printable ASCII characters without spaces.
- **Outbox:** state changes that must emit bus events write to an outbox table in the same transaction; a relay publishes to NATS. No dual writes.
- **Time:** all timestamps UTC; per-profile timezone trait used for send-time and quiet hours.
- **Observability:** OpenTelemetry traces/metrics/logs from every role; trace context propagated through bus messages and queue jobs. `GET /metrics` exposes Prometheus metrics when `METRICS_TOKEN` is set (0.5.0), and `am doctor` checks the queue and delivery health — see [deployment-and-scaling.md](deployment-and-scaling.md#5-operations--health).
