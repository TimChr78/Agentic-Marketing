# Roadmap (team of one, no deadline)

> **Wave 2 (from 2026-10-22):** the phases after the MartechSignal pilot are replanned in [roadmap-wave-2.md](roadmap-wave-2.md): pilot hardening, delivery beyond SMTP and SMS, consent everywhere, performance marketing with Google, Meta and Microsoft, scale, and enterprise. The table below is wave 1.

Ordering principle: build the **foundations that are expensive to retrofit** first (command registry, tenancy, artifacts/versioning, consent, audit), then deliver one end-to-end vertical slice, then widen.

| Phase | Goal | Contents | "Done" means |
|---|---|---|---|
| **−1. Interactive demo** (done) | Feel the product, show it off | Clickable UI in the target stack with an in-browser mocked command registry: live shop with in-session personalization, journey builder + simulation, MJML editor, profiles & consent, analytics, approvals, scripted/live copilot. See `apps/web/README.md` | Every core flow can be shown end-to-end without a backend |
| **0. Foundations** (core done) | A skeleton that every later feature plugs into | Monorepo, CI, Docker Compose; `core`, `commands` (registry → REST + MCP + UI client), auth (Better Auth), workspaces + RLS, artifacts/versions/approval policies, audit log, OpenTelemetry, key provider & secret store | An MCP client and the UI can create/version/approve a dummy artifact with identical rules |
| **1. Data platform** (core done) | Collect and understand customers | Ingest gateway (Segment spec), `sdk-js` with consent, tracking plan, attribute schema with PII tags, identity resolution, profiles, ClickHouse sink, consent ledger & purposes, profile viewer UI, DSR export/erase | Site events appear on a resolved profile within seconds; erasure verifiably removes a person |
| **2. Email + journeys (first vertical slice)** (core done) | First real value | Template system (MJML + Liquid, GrapesJS editor, code view, previews), send gateway, provider adapters with delivery events ([ADR-0011](adr/0011-email-delivery-providers.md): SMTP, Amazon SES, Postmark, Brevo; SMTP can use a provider's webhooks), bounces and complaints into suppression, unsubscribe, segments v1 (batch + streaming basics), journey engine + canvas (core nodes), simulation, journey & message analytics | A welcome + abandoned-browse journey runs end-to-end, built either in the UI or entirely via MCP |
| **3. Web personalization** (core done) | In-session experiences | Experience artifact & editor, decision API, session state & RT counters, SDK rendering + anti-flicker + client rules, A/B allocation & results | Next-page-view and same-page personalization with measured p95 < 50 ms server time |
| **4. AI runtime & copilot** (core done) | Agents inside the product | LLM gateway (BYOK, OpenAI-/Anthropic-compatible), prompt artifacts with tests, `ai.decide` / `ai.generate`, context builder & redaction, budgets, in-app copilot over MCP | AI-chosen branches/content with full decision logs and fallbacks |
| **5. Webhooks & integrations** (core done) | Connect the ecosystem | Webhook adapter (in/out), connector SDK, Activepieces-pieces spike, automation nodes (HTTP, transform). First-party connectors are **not a v1 priority**; when built, **Shopify and Salesforce** come first | Webhooks in/out work end-to-end; n8n can orchestrate via MCP/webhooks; connector SDK documented |
| **6. Breadth & scale** (superseded by [wave 2](roadmap-wave-2.md)) | Production-grade for larger orgs | SMS & push adapters, warehouse export/sync, SSO (OIDC/SAML) & SCIM, Helm chart, load testing to 10M profiles, config-as-code export, participant migration between journey versions | Documented reference deployment at 10M profiles |
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

## Phase 2 status (2026-10-22)

Done; the suite has 81 tests, including end-to-end tests for e-mail, segments and journeys:
- E-mail templates (MJML + Liquid, validated on save, sandboxed rendering, server previews), provider adapters with delivery events ([ADR-0011](adr/0011-email-delivery-providers.md): SMTP, Amazon SES, Postmark, Brevo, plus a development outbox), and the send gateway as an outbox (lawful basis, consent and objections, suppressions, retries, one-click unsubscribe, click tracking, "why not sent" in the message log).
- Segments v1: JSON DSL over traits, events in time windows, consent and other segments; batch and streaming evaluation; entered/exited events.
- Journey engine: interpreter and participants-as-queue runtime (spike 3 design), triggers on events or segment entry with re-entry rules, waits, wait-for-event, goals, branches, splits, e-mail and profile updates; simulation with per-person gateway decisions; journey and message statistics.
- Live editors on the real API: journey canvas (React Flow) and e-mail editor (GrapesJS, code, server preview) in the live workspace screen, with e-mail providers and recent messages.

Acceptance: a welcome journey (built over REST, as the UI does) and an abandoned-browse journey, segment and template built entirely by an MCP agent run end to end, with consent enforced (`apps/server/test/phase2-journeys.test.ts`).

Known limits, to address later:
- Frequency caps and quiet hours are not enforced yet; the gateway's decision log is ready for them.
- No bounce mailbox for pure-SMTP setups; use a relay's webhooks (ADR-0011).
- Segment evaluation holds ids in memory (fine for the homelab scale; the 10M-profile path moves set operations into SQL/ClickHouse).
- A waiting participant whose profile is merged into another is not woken by events of the merged profile.
- Webhook, AI and A/B result analysis nodes arrive in Phases 4–5; experiments' statistics with Phase 3.

## Phase 3 status (2026-10-22)

Done; the suite has 95 tests, including end-to-end personalization:
- Hot state in Valkey: per-visitor sessions (page views, path, referrer, UTM, event counts) written by ingest before it answers, and profile snapshots (non-personal traits, segment memberships) kept current after identity resolution and segments.
- `experience` artifacts: placement, priority, decide-time targeting (traits, segments, session counts, new visitor, page, referrer, UTM, device), A/B/n variants (HTML or JSON), holdout, goal, triggers (immediate, exit intent, scroll, time on page).
- `POST /v1/decide`: hot state and cached definitions only; page-only targeting without the web_personalization purpose; sticky allocation by profile; Server-Timing.
- sdk-js: `decide()`, `personalize()` with sanitising, anti-flicker snippet, client-side triggers and exposure events.
- `experiences.results`: exposures, conversions after first exposure, lift, p-value and interval per variant against the control.
- "Web experiences" tab in the live workspace.

Acceptance: next-page-view personalization from session state and segments, consent-limited decisions, and p95 server time under 50 ms over 200 decisions (`apps/server/test/phase3.test.ts`).

Known limits, to address later:
- New or changed experiences reach the decision API within 30 s (definition cache).
- Results use a fixed-horizon test; sequential testing and Bayesian summaries later. Visitors are counted by anonymous id (per device).
- No visual editor for experience content yet (HTML/JSON); no edge deployment of `decide`.
- Segment memberships changed by the scheduled refresh reach snapshots with the person's next event (fixed in wave 2, Phase 10).

## Phase 4 status (2026-10-22)

Done ([ADR-0012](adr/0012-ai-runtime.md)):
- LLM gateway with the workspace's own keys:
  - OpenAI-compatible and Anthropic-compatible providers (AI SDK), with keys sealed and write-only;
  - one provider per use (journeys, copilot);
  - monthly token budgets and usage per day (`ai.usage`).
- `prompt` artifacts (decide or generate) with test cases; `prompts.test` runs them against the model.
- `aiDecide` and `aiGenerate` journey nodes:
  - asynchronous steps answered by the AI worker, with fallbacks and logged reasons for each failure (no consent, no provider, budget, model error, invalid answer, timeout);
  - generated texts go into `content.<slot>` for later e-mails, after length, phrase, link and markup checks;
  - simulation support, and publish checks against the prompt.
- Context builder: profile id instead of identifiers, agent-visible traits only, redacted recent events, gated on the `ai_processing` purpose. The person is sent as delimited data.
- Decision log (`ai.calls`) with context, answer, rationale, tokens and latency; included in the access export and erased with the person.
- In-app copilot (`/api/copilot`): an in-process MCP client on the same MCP server, acting as an agent principal that drafts but cannot send, approve, erase or change settings. It streams its tool calls.
- "AI" and "Copilot" tabs in the live workspace (providers, prompts with a test runner, decision log); AI steps in the journey builder.

Acceptance: AI-chosen branches and generated content with full decision logs and fallbacks (no consent, model error, budget, rejected text), prompt tests, the access export and the copilot working through MCP and audited as an agent, against a scripted LLM server that speaks both wire formats (`apps/server/test/phase4.test.ts`).

Known limits, to address later:
- No caching of generated text per segment, no sampling of decisions for human review, no `ai.classify`.
- Budgets can be overshot by a few concurrent calls; prompt tests run in the command's transaction.
- OAuth credentials for providers (open question 4) are not supported; API keys only.
- The copilot does not stream tokens, only steps; the conversation lives in the browser.

## Phase 5 status (2026-10-22)

Done ([ADR-0013](adr/0013-integrations.md), guide: [integrations.md](../integrations.md)):
- API tokens for scripts and automation tools: an agent principal with chosen scopes, accepted as Bearer on REST and `/mcp`, revocable, audited as `token:<id>`.
- Outbound webhooks:
  - Standard Webhooks signatures; subscriptions to customer events after identity resolution, with an optional purpose gate; payloads without personal traits;
  - retries with backoff, a dead letter and manual retry (`webhooks.*`, `deliveries.*`).
- Egress guard for every outbound call: public addresses only, checked at connect time; no redirects; bounded time and size; `EGRESS_ALLOWED_HOSTS` for LAN targets.
- Connector SDK (`defineConnector`): settings, sealed secrets, inbound verify and map, actions, rate limits.
  - Connectors: generic webhook (JSONata mapping, HMAC or Standard Webhooks), Shopify (signed orders, checkouts, customers), Slack, HTTP API.
  - Commands: `connectors.list`, `connections.*`.
  - Inbound URLs: `/hooks/in/<connection>/<token>`, through the same ingest policy.
- Journey steps:
  - `transform` (JSONata into `vars`);
  - `action` (asynchronous, ok/error edges);
  - `webhook` (consent-checked).
  - Simulation and publish checks cover all three.
- "Integrations" tab in the live workspace; the new steps in the journey builder.
- Activepieces spike ([findings](../../spikes/activepieces/FINDINGS.md)): pieces are not embedded for now.

Acceptance: n8n-style orchestration end to end (`apps/server/test/phase5.test.ts`):
- an API token over REST and MCP;
- signed outbound webhooks with retry and a dead letter;
- signed Shopify and generic inbound webhooks becoming profiles and events;
- a journey that transforms, calls Slack, then sends a webhook, and takes the error edge when Slack fails.

Known limits, to address later:
- No OAuth2 connectors yet (token store and refresh worker come with Salesforce); first-party connectors beyond the references are not built.
- E-mail delivery events (sent, bounced, clicked) are not offered to webhook subscriptions yet; only customer events and journey steps are.
- Rate limits are per worker process; the egress guard does not cover the e-mail provider adapters, which call fixed provider hosts.

## Pilot: MartechSignal.com (2026-10-22)

Before Phase 6, a light pilot on the owner's site: [assessment and plan](../pilots/martechsignal.md). Built for it:
- signup forms with double opt-in, honeypot, rate limit and optional Turnstile;
- subscriber import with consent history;
- broadcasts for the weekly newsletter;
- `PUBLIC_LINKS_URL` and `CLIENT_IP_HEADER` for a first-party proxy behind Cloudflare;
- a browser build of the SDK.

Agent skills for rolling the stack out and for operating it over MCP are in `.claude/skills/` (`agentic-marketing-implement`, `agentic-marketing-mcp`). The pilot's findings decide whether Phase 6 comes next.
