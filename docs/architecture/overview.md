# System overview

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

The platform is **one codebase and one container image**. A `ROLE` env var (or several, comma-separated) selects which modules a process runs. On a small install a single process runs all roles; at scale each role is deployed and scaled independently.

| Role | Responsibility | Latency class | Scales by |
|---|---|---|---|
| `api` | Command layer: REST, MCP (streamable HTTP), UI RPC, auth, static UI | interactive (<300 ms) | users / agents |
| `ingest` | Event intake (Segment-spec HTTP API), validation, consent filter, identity hints, session-state update, publish to bus | hot path (<20 ms p95) | events/s |
| `decide` | Web personalization decision API, reads hot state from Valkey | hot path (<50 ms p95) | page views/s |
| `worker` | Bus consumers: ClickHouse sink, profile updater, segment evaluator, journey trigger matcher; journey step execution; sends | near real time (<5 s) | events/s, journey steps/s |
| `scheduler` | Timers (journey waits, scheduled segment recomputes, campaign schedules), maintenance jobs | seconds | singleton (leader-elected) |

```mermaid
flowchart LR
  subgraph edge["Public edge (Caddy / ingress)"]
    direction TB
  end
  sdk[JS SDK] --> ingest
  sdk --> decide
  browser[UI SPA] --> api
  mcp[MCP clients] --> api

  ingest --> nats[[NATS JetStream]]
  ingest --> valkey[(Valkey)]
  decide --> valkey
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
  core/            # ids, errors, tenancy context, clock, result types
  commands/        # command registry: defineCommand(), authz, audit, idempotency
  schema/          # zod schemas shared by API, MCP, UI, SDK
  artifacts/       # versioned artifacts, drafts, approvals, diffs
  identity/        # identifiers, identity graph, merges
  profiles/        # profile store, traits, attribute schema (with PII tags)
  events/          # ingestion pipeline, tracking plan, bus contracts
  segments/        # segment DSL, compiler (ClickHouse SQL), streaming evaluator
  journeys/        # journey graph model, interpreter, node registry
  content/         # templates (MJML + Liquid), rendering, assets
  channels/        # send gateway, adapter SDK, email/webhook/sms/push adapters
  personalization/ # experiences, decision engine, A/B allocation
  consent/         # consent & lawful-basis ledger, policy evaluation, suppression
  ai/              # LLM gateway, provider configs, AI nodes, context builder, redaction
  integrations/    # connector SDK, source/destination connectors
  analytics/       # reporting queries, journey/message metrics
  privacy/         # DSR (access/erasure), retention, crypto-shredding
apps/
  server/          # composes modules into roles (api, ingest, decide, worker, scheduler)
  web/             # React UI (journey canvas, email editor, experience editor)
  sdk-js/          # browser SDK (tracking + personalization, consent-aware)
  cli/             # admin CLI (migrations, key rotation, import/export)
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
  participant Q as Graphile Worker queue (Postgres)
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

  A->>API: journeys.createDraft / journeys.updateDraft
  API->>ART: new draft version (author = agent principal)
  A->>API: journeys.validate + journeys.simulate(sample profiles)
  A->>API: journeys.requestPublish
  alt workspace approval policy = none
    API->>ART: publish
  else approval required
    ART-->>H: notification + visual diff
    H->>API: artifacts.approve
    API->>ART: publish (immutable version)
  end
```

## 5. Cross-cutting conventions

- **Tenancy:** every table has `workspace_id` (plus `organization_id` reserved for SaaS); every bus subject and ClickHouse row carries it. Postgres Row Level Security is enabled from day one so a missed `WHERE` cannot leak data across workspaces.
- **IDs:** UUIDv7 (time ordered, index friendly) everywhere; external-facing IDs prefixed (`jrn_`, `tpl_`, `prf_`).
- **Idempotency:** every command and every side effect accepts an idempotency key; the send gateway deduplicates on `(participant, node, attempt-group)`.
- **Outbox:** state changes that must emit bus events write to an outbox table in the same transaction; a relay publishes to NATS. No dual writes.
- **Time:** all timestamps UTC; per-profile timezone trait used for send-time and quiet hours.
- **Observability:** OpenTelemetry traces/metrics/logs from every role; trace context propagated through bus messages and queue jobs.
