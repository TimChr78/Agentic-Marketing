# Technology selection

Selection criteria, in priority order: **(1) maintainable by one person, (2) permissive license, (3) self-host friendly (few moving parts), (4) proven path to 10M profiles, (5) good for agents (typed schemas, JSON-first).**

> Licenses listed are as understood at the time of writing — re-verify each LICENSE file when the dependency is adopted.

## Platform & language

| Area | Choice | License | Alternatives considered | Why |
|---|---|---|---|---|
| Language | **TypeScript** (strict) | — | Go (hot path), Python | One language for server, UI, SDK, MCP, schemas; best MCP & AI SDK ecosystem. Hot path can be ported to Go later behind the same contracts if ever needed |
| Runtime | **Node.js 24 LTS** | MIT | Bun, Deno | Most mature for long-running servers; Bun remains an option for tooling |
| Monorepo | **pnpm workspaces + Turborepo** | MIT | Nx | Simple, fast, low config |
| HTTP framework | **Hono** + `@hono/zod-openapi` | MIT | Fastify, NestJS | Small, fast, zod → OpenAPI built in, also runs on edge runtimes (future edge `decide`) |
| Schemas & validation | **Zod 4** | MIT | TypeBox, Valibot | One source for runtime validation, JSON Schema (MCP), OpenAPI, forms |
| DB access | **Drizzle ORM** + Drizzle Kit migrations | Apache-2.0 | Kysely, Prisma | SQL-close, typed, good Postgres feature support (RLS, partitions via raw SQL) |
| Lint/format | **Biome** | MIT | ESLint + Prettier | One fast tool |
| Testing | **Vitest**, **Playwright**, **Testcontainers** | MIT / Apache-2.0 / MIT | Jest | Fast unit tests; real Postgres/ClickHouse/NATS in integration tests |

## Data & messaging

| Area | Choice | License | Alternatives considered | Why |
|---|---|---|---|---|
| OLTP | **PostgreSQL 17+** | PostgreSQL | MySQL | Transactions, JSONB, RLS, partitioning; the job queue lives here too |
| Events / analytics | **ClickHouse** | Apache-2.0 | TimescaleDB, Druid, DuckDB | Best-in-class for event analytics at this scale; JSON type; TTL; single node goes very far |
| Event bus | **NATS JetStream** | Apache-2.0 | Kafka, Redpanda (BSL), Redis Streams, Postgres only | Single small binary, durable streams, consumer groups, replay, clusterable; much lighter to self-host than Kafka. See [ADR-0003](adr/0003-storage-and-event-bus.md) |
| Hot state / cache | **Valkey 8** | BSD-3 | Redis (license changed), Dragonfly (BSL) | Sub-ms session state, counters, rate limits; Redis-protocol compatible |
| Job queue / durable steps | **Graphile Worker** | MIT | pg-boss, Temporal, Hatchet, DBOS | Jobs in the same Postgres txn as state changes, high throughput, cron. See [ADR-0004](adr/0004-journey-runtime.md) |
| Object storage | **Any S3-compatible API** (+ local filesystem driver) | — | MinIO (AGPL; community edition reduced) | Users pick AWS S3, Cloudflare R2, Garage, SeaweedFS… |

## Product features

| Area | Choice | License | Alternatives considered | Why |
|---|---|---|---|---|
| UI framework | **React 19 + Vite + TanStack Router/Query** | MIT | Next.js | SPA served by `api` role — no separate frontend server to operate |
| UI components | **shadcn/ui + Radix + Tailwind CSS** | MIT | MUI, Mantine | Owned code, accessible primitives |
| Flow canvas | **React Flow (xyflow)** | MIT | Rete.js, JointJS (commercial) | De-facto standard for node editors |
| Graph layout | **ELK.js** (or dagre) | EPL-2.0 / MIT | — | Auto-layout of journeys |
| Email format | **MJML** | MIT | React Email, raw HTML | Responsive & client-safe, declarative, LLM-friendly. See [ADR-0006](adr/0006-email-format-and-editor.md) |
| Email visual editor | **GrapesJS + grapesjs-mjml** | BSD-3 | Easy Email (MIT), Unlayer (proprietary), Beefree (proprietary) | Mature, imports/exports MJML round-trip |
| Templating | **LiquidJS** | MIT | Handlebars | Sandboxed, marketer-familiar (Shopify, Braze use Liquid) |
| Charts | **Apache ECharts** | Apache-2.0 | Recharts, Chart.js | Rich chart types (funnels, dual axes), SVG renderer, themeable from tokens |
| Code editor | **Monaco** | MIT | CodeMirror 6 | MJML/Liquid/JSON editing with schema-aware completion |
| Data mapping expressions | **JSONata** | MIT | JMESPath | For automation transform nodes |
| Email sending (SMTP) | **Nodemailer** | MIT | — | Universal SMTP adapter |
| Dev mail catcher | **Mailpit** | MIT | MailHog (unmaintained) | Local testing |

## Agents & AI

| Area | Choice | License | Alternatives considered | Why |
|---|---|---|---|---|
| MCP | **Official MCP TypeScript SDK v2** (`@modelcontextprotocol/server` + `client`, spec 2026-07-28, stateless `createMcpHandler`) | Apache-2.0 | FastMCP, SDK v1 | Reference implementation; stateless per-request serving needs no session store (validated in spike 1) |
| LLM abstraction | **Vercel AI SDK** (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`) | Apache-2.0 | LangChain.js, direct SDKs | Thin, typed structured output with zod, both endpoint styles with custom base URLs |
| PII redaction | Schema-driven masking + rule detectors; **Presidio** optional sidecar later | MIT | — | Avoid a Python service in v1 |

## Auth & security

| Area | Choice | License | Alternatives considered | Why |
|---|---|---|---|---|
| Authentication | **Better Auth** (organizations, passkeys, 2FA, `@better-auth/mcp` OAuth 2.1 authorization server for MCP, SSO plugin later; all packages pinned to one version) | MIT | Keycloak, Ory, Zitadel, Auth.js | Library, not another server to run; covers MCP OAuth needs. Keycloak/Zitadel remain options as external IdPs via OIDC |
| Authorization | Own RBAC in command layer → OpenFGA if needed | — / Apache-2.0 | Casbin, Cerbos | Start simple |
| Key management | Pluggable: env/file KEK, AWS/GCP KMS, **OpenBao** transit | MPL-2.0 | Vault (BSL) | OpenBao is the open fork of Vault |
| HTML sanitizing | **DOMPurify** | Apache-2.0 / MPL-2.0 | — | Experience content |

## Operations

| Area | Choice | License | Why |
|---|---|---|---|
| Packaging | Single OCI image; **Docker Compose** for self-host; **Helm chart** later | — | One artifact to version |
| Reverse proxy / TLS | **Caddy** | Apache-2.0 | Automatic HTTPS |
| Observability | **OpenTelemetry** SDK + `pino` logs; works with any OTLP backend (Grafana stack, SigNoz, etc. — external, optional) | Apache-2.0 / MIT | No backend lock-in |
| CI | GitHub Actions; Renovate; Syft SBOM; cosign signing | — | Supply chain hygiene |
| Docs site | Starlight (Astro) | MIT | Public docs for self-hosters |

## Explicitly not used (and why)

| Tool | Reason |
|---|---|
| n8n (embedded) | Sustainable Use License (fair-code) — integrate externally only |
| RudderStack server | AGPL-3.0 + enterprise features; we only need the Segment-spec protocol |
| Temporal | Excellent, but an extra cluster to run & upgrade; overkill for a one-person self-hostable core (kept as the upgrade path) |
| Kafka / Redpanda | Kafka is heavy to operate for small installs; Redpanda is BSL |
| Redis ≥7.4, Dragonfly, Vault, MinIO | License changes (non-permissive or source-available) |
| Unlayer / Beefree editors | Proprietary |
| Nango, Airbyte (core) | Not permissively licensed |
