# Roadmap (team of one, no deadline)

Ordering principle: build the **foundations that are expensive to retrofit** first (command registry, tenancy, artifacts/versioning, consent, audit), then deliver one end-to-end vertical slice, then widen.

| Phase | Goal | Contents | "Done" means |
|---|---|---|---|
| **−1. Interactive demo** (done) | Feel the product, show it off | Clickable UI in the target stack with an in-browser mocked command registry: live shop with in-session personalization, journey builder + simulation, MJML editor, profiles & consent, analytics, approvals, scripted/live copilot. See `apps/web/README.md` | Every core flow can be shown end-to-end without a backend |
| **0. Foundations** (core done) | A skeleton that every later feature plugs into | Monorepo, CI, Docker Compose; `core`, `commands` (registry → REST + MCP + UI client), auth (Better Auth), workspaces + RLS, artifacts/versions/approval policies, audit log, OpenTelemetry, key provider & secret store | An MCP client and the UI can create/version/approve a dummy artifact with identical rules |
| **1. Data platform** (core done) | Collect and understand customers | Ingest gateway (Segment spec), `sdk-js` with consent, tracking plan, attribute schema with PII tags, identity resolution, profiles, ClickHouse sink, consent ledger & purposes, profile viewer UI, DSR export/erase | Site events appear on a resolved profile within seconds; erasure verifiably removes a person |
| **2. Email + journeys (first vertical slice)** | First real value | Template system (MJML + Liquid, GrapesJS editor, code view, previews), send gateway, provider adapters with delivery events ([ADR-0011](adr/0011-email-delivery-providers.md): SMTP, Amazon SES, Postmark, Brevo; SMTP can use a provider's webhooks), bounces and complaints into suppression, unsubscribe, segments v1 (batch + streaming basics), journey engine + canvas (core nodes), simulation, journey & message analytics | A welcome + abandoned-browse journey runs end-to-end, built either in the UI or entirely via MCP |
| **3. Web personalization** | In-session experiences | Experience artifact & editor, decision API, session state & RT counters, SDK rendering + anti-flicker + client rules, A/B allocation & results | Next-page-view and same-page personalization with measured p95 < 50 ms server time |
| **4. AI runtime & copilot** | Agents inside the product | LLM gateway (BYOK, OpenAI-/Anthropic-compatible), prompt artifacts with tests, `ai.decide` / `ai.generate`, context builder & redaction, budgets, in-app copilot over MCP | AI-chosen branches/content with full decision logs and fallbacks |
| **5. Webhooks & integrations** | Connect the ecosystem | Webhook adapter (in/out), connector SDK, Activepieces-pieces spike, automation nodes (HTTP, transform). First-party connectors are **not a v1 priority**; when built, **Shopify and Salesforce** come first | Webhooks in/out work end-to-end; n8n can orchestrate via MCP/webhooks; connector SDK documented |
| **6. Breadth & scale** | Production-grade for larger orgs | SMS & push adapters, warehouse export/sync, SSO (OIDC/SAML) & SCIM, Helm chart, load testing to 10M profiles, config-as-code export, participant migration between journey versions | Documented reference deployment at 10M profiles |
| **Later** | | Probabilistic identity, recommendations engine, edge decide, autonomous goal-driven agents (scope C), SaaS multi-tenancy & billing | |

Suggested spikes before Phase 0 code freeze on the design (1–3 days each):
1. ✅ Command registry prototype: one command exposed via Hono/OpenAPI, MCP (Streamable HTTP + OAuth via Better Auth) and a typed UI call. Done, see [`spikes/command-registry/FINDINGS.md`](../../spikes/command-registry/FINDINGS.md).
2. ✅ GrapesJS + grapesjs-mjml round-trip of LLM-written MJML (vs. Easy Email). Done, see [`spikes/email-editor/FINDINGS.md`](../../spikes/email-editor/FINDINGS.md); GrapesJS kept with a small normalisation adapter.
3. ✅ Journey runtime: 1M waiting participants, timer throughput, crash/retry semantics. Done, see [`spikes/journey-runtime/FINDINGS.md`](../../spikes/journey-runtime/FINDINGS.md); ADR-0004 revised (batched table-as-queue instead of job per step).
4. ✅ NATS JetStream → ClickHouse sink throughput and per-profile ordering on a single node. Done, see [`spikes/event-pipeline/FINDINGS.md`](../../spikes/event-pipeline/FINDINGS.md).

All four spikes are done; Phase 0 can start.

## Phase 0 status (2026-10-22)

Done, with 29 tests (21 end-to-end against Postgres):
- Monorepo packages `core`, `db`, `commands`, `artifacts`, `secrets`, `auth`, `telemetry`, `client`; `apps/server` with roles; CLI (`migrate`, `bootstrap`).
- Command registry → REST + OpenAPI 3.1, MCP (OAuth 2.1, consent with per-permission choice), typed UI client.
- Workspaces, roles (owner, admin, marketer, approver, viewer), Postgres RLS via a dedicated app role.
- Versioned artifacts (`note`, `journey`) with drafts, optimistic concurrency, history, structural diffs; approval policies (none / agent changes / all publishes with four-eyes).
- Hash-chained, append-only audit log (writes and failures), idempotency keys, envelope-encrypted secrets.
- OpenTelemetry spans per command (exported when `OTEL_EXPORTER_OTLP_ENDPOINT` is set), pino logs.
- Dockerfile, Docker Compose, GitHub Actions CI, Biome.
- "Live workspace (API)" screen in the web app.
- Follow-ups: member and invitation commands (one-time links, owner rules, last-owner protection), master key rotation (`MASTER_KEY_PREVIOUS` + `cli rotate-keys`), Client ID Metadata Document clients (`@better-auth/cimd`, MCP 2026-07-28 profile), CI on Node 24 actions. CI has run green on GitHub.

Deferred: KMS/OpenBao key providers (the `KeyProvider` interface is ready; local keys are enough for the homelab install), MCP scope step-up (agents see only the tools they were granted and get an actionable error; re-consent covers the rest until a client needs `insufficient_scope` challenges), a members screen in the web app, and running the Docker image (no Docker daemon was available while building).


## Phase 1 status (2026-10-22)

Done; the suite now has 56 tests, 12 of them Phase 1 end-to-end tests against Postgres, ClickHouse 26.8 and NATS 2.15:
- `events`: Segment event schema, JetStream bus (16 shards per visitor, per-workspace dedupe), ClickHouse event store and batched sink.
- `ingest`: browser/server sources with write keys; the Segment HTTP API (`/v1/batch`, `/v1/track`, … and the analytics.js short paths); origin allow-list, rate limit, size limits; consent gate per source purpose; tracking plan (allow/warn/block, typed and required properties, PII properties removed); personal traits kept out of the event store; IP truncation.
- `profiles`: deterministic identity resolution with merges (never across two user ids, e-mails or phones), per-person encryption of personal data with crypto-shredding, HMAC matching for e-mail/phone, append-only consent ledger with computed state, access export and verified erasure (events, identifiers, keys, ledger; e-mail/phone suppressed).
- Tracking plan (with the attribute schema) and purposes are versioned singleton artifacts with defaults.
- `sdk-js` (MIT): consent-first browser SDK.
- "People & data" tab in the live workspace screen: sources with snippet, people, profile, consent, events, export and erase.

Acceptance: an identified visitor's events are on their profile in about one to two seconds (sink batches of 1 s, profile consumers poll per second); erasure is verified table by table in the end-to-end suite.

Known limits, to address later:
- Events wait in the JetStream stream (with personal traits, for the profile worker) for its retention window, 7 days by default; erasure cannot remove them from there. Keep the NATS volume on encrypted disk, or shorten `retentionDays`.
- ClickHouse has no row policies yet; tenant scoping lives in the one module that queries it (`packages/events/src/clickhouse.ts`).
- Tracking-plan warnings are returned to the sender and logged, not yet stored for a report.
- Segments are in Phase 2 (segments v1), where journeys first need them. Bulk import and bot filtering are not built yet.
