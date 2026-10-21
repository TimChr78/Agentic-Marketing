# Roadmap (team of one, no deadline)

Ordering principle: build the **foundations that are expensive to retrofit** first (command registry, tenancy, artifacts/versioning, consent, audit), then deliver one end-to-end vertical slice, then widen.

| Phase | Goal | Contents | "Done" means |
|---|---|---|---|
| **0. Foundations** | A skeleton that every later feature plugs into | Monorepo, CI, Docker Compose; `core`, `commands` (registry → REST + MCP + UI client), auth (Better Auth), workspaces + RLS, artifacts/versions/approval policies, audit log, OpenTelemetry, key provider & secret store | An MCP client and the UI can create/version/approve a dummy artifact with identical rules |
| **1. Data platform** | Collect and understand customers | Ingest gateway (Segment spec), `sdk-js` with consent, tracking plan, attribute schema with PII tags, identity resolution, profiles, ClickHouse sink, consent ledger & purposes, profile viewer UI, DSR export/erase | Site events appear on a resolved profile within seconds; erasure verifiably removes a person |
| **2. Email + journeys (first vertical slice)** | First real value | Template system (MJML + Liquid, GrapesJS editor, code view, previews), send gateway, **SMTP adapter first** (owner's install uses an SMTP relay; SES/Postmark adapters follow), bounce handling incl. DSN/bounce-mailbox parsing for SMTP, complaints, unsubscribe, segments v1 (batch + streaming basics), journey engine + canvas (core nodes), simulation, journey & message analytics | A welcome + abandoned-browse journey runs end-to-end, built either in the UI or entirely via MCP |
| **3. Web personalization** | In-session experiences | Experience artifact & editor, decision API, session state & RT counters, SDK rendering + anti-flicker + client rules, A/B allocation & results | Next-page-view and same-page personalization with measured p95 < 50 ms server time |
| **4. AI runtime & copilot** | Agents inside the product | LLM gateway (BYOK, OpenAI-/Anthropic-compatible), prompt artifacts with tests, `ai.decide` / `ai.generate`, context builder & redaction, budgets, in-app copilot over MCP | AI-chosen branches/content with full decision logs and fallbacks |
| **5. Webhooks & integrations** | Connect the ecosystem | Webhook adapter (in/out), connector SDK, Activepieces-pieces spike, automation nodes (HTTP, transform). First-party connectors are **not a v1 priority**; when built, **Shopify and Salesforce** come first | Webhooks in/out work end-to-end; n8n can orchestrate via MCP/webhooks; connector SDK documented |
| **6. Breadth & scale** | Production-grade for larger orgs | SMS & push adapters, warehouse export/sync, SSO (OIDC/SAML) & SCIM, Helm chart, load testing to 10M profiles, config-as-code export, participant migration between journey versions | Documented reference deployment at 10M profiles |
| **Later** | | Probabilistic identity, recommendations engine, edge decide, autonomous goal-driven agents (scope C), SaaS multi-tenancy & billing | |

Suggested spikes before Phase 0 code freeze on the design (1–3 days each):
1. Command registry prototype: one command exposed via Hono/OpenAPI, MCP (Streamable HTTP + OAuth via Better Auth) and a typed UI call.
2. GrapesJS + grapesjs-mjml round-trip of an LLM-written MJML template (vs. Easy Email).
3. Graphile Worker journey interpreter: 1M waiting participants, timer throughput, crash/retry semantics.
4. NATS JetStream → ClickHouse sink throughput and per-profile ordering on a single node.
