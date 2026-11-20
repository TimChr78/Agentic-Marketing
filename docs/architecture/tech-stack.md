# Technology selection

Selection criteria, in priority order: **(1) maintainable by one person, (2) permissive license, (3) self-host friendly (few moving parts), (4) proven path to 10M profiles, (5) good for agents (typed schemas, JSON-first).**

> Licenses listed are as understood at the time of writing — re-verify each LICENSE file when the dependency is adopted.

This table describes what the repository ships today. Roadmap items are marked **planned** and link the tracking issue; they are not in the tree yet.

## Platform & language

| Area | Choice | License | Alternatives considered | Why |
|---|---|---|---|---|
| Language | **TypeScript** (strict) | — | Go (hot path), Python | One language for server, UI, SDK, MCP, schemas; best MCP & AI SDK ecosystem. Hot path can be ported to Go later behind the same contracts if ever needed |
| Runtime | **Node.js 26 LTS** | MIT | Bun, Deno | Most mature for long-running servers; the image is `node:26-slim` ([Dockerfile](../../Dockerfile)) and CI pins `node-version: 26` ([ci.yml](../../.github/workflows/ci.yml)). Bun remains an option for tooling |
| Monorepo | **pnpm workspaces** (no task runner) | MIT | Nx, Turborepo | Simple, fast, low config: one workspace file and pnpm scripts ([pnpm-workspace.yaml](../../pnpm-workspace.yaml)); there is no `turbo.json` |
| HTTP framework | **Hono** + `@hono/zod-openapi` | MIT | Fastify, NestJS | Small, fast, zod → OpenAPI built in, also runs on edge runtimes (future edge `decide`) |
| Schemas & validation | **Zod 4** | MIT | TypeBox, Valibot | One source for runtime validation, JSON Schema (MCP), OpenAPI, forms |
| DB access | **Drizzle ORM** + Drizzle Kit migrations (1.0 planned after GA, [#1003](https://github.com/TimChr78/Agentic-Marketing/issues/1003)) | Apache-2.0 | Kysely, Prisma | SQL-close, typed, good Postgres feature support (RLS, partitions via raw SQL) |
| Lint/format | **Biome**, plus **oxlint** with its type-aware rules (`oxlint --type-aware`, run by `pnpm lint`) | MIT | ESLint + Prettier | One fast formatter and linter, with the type-aware checks that Biome does not do yet (`lint:oxlint` in [package.json](../../package.json)) |
| Testing | **Vitest**, **Playwright**; one shared Docker service stack for integration tests | MIT / Apache-2.0 | Jest, Testcontainers | Fast unit and component tests. Integration tests use Postgres, ClickHouse, NATS and Valkey from one local stack (`scripts/test-services.sh`) or CI service containers, not per-test containers |

## Data & messaging

| Area | Choice | License | Alternatives considered | Why |
|---|---|---|---|---|
| OLTP | **PostgreSQL 18** (16 is the supported minimum; [#1001](https://github.com/TimChr78/Agentic-Marketing/issues/1001)) | PostgreSQL | MySQL | Transactions, JSONB, RLS, partitioning; journey and job state live here too. Compose pins `postgres:18-alpine` and CI runs `postgres:18`; new clusters get data checksums by default. Async I/O, B-tree skip scan and `uuidv7()` help reporting, and `pg_upgrade` keeps planner statistics. 16 stays supported through at least June 2027 ([upgrade path](../deployment/postgres-18.md)) |
| Events / analytics | **ClickHouse** | Apache-2.0 | TimescaleDB, Druid, DuckDB | Best-in-class for event analytics at this scale; JSON type; TTL; single node goes very far |
| Event bus | **NATS JetStream** | Apache-2.0 | Kafka, Redpanda (BSL), Redis Streams, Postgres only | Single small binary, durable streams, consumer groups, replay, clusterable; much lighter to self-host than Kafka. See [ADR-0003](adr/0003-storage-and-event-bus.md) |
| Hot state / cache | **Valkey 9** | BSD-3 | Redis (license changed), Dragonfly (BSL) | Sub-ms session state, counters, rate limits; Redis-protocol compatible |
| Journey steps | **Own batched sweeper** over the participants table (`FOR UPDATE SKIP LOCKED`) | — | Graphile Worker job per step, Temporal, DBOS | ~50× the throughput of job-per-step in spike 3, immediate crash recovery. See [ADR-0004](adr/0004-journey-runtime.md) |
| Background jobs | **Scheduler-role loops** plus outbox rows drained by the worker | — | pg-boss, Graphile Worker | Cron, maintenance and exports are recurring loops in the `scheduler` role ([workers.ts](../../apps/server/src/workers.ts)); sends and deliveries are written as outbox rows in the same transaction as the state change and drained with `FOR UPDATE SKIP LOCKED` ([gateway.ts](../../packages/email/src/gateway.ts), [deliveries.ts](../../packages/integrations/src/deliveries.ts)). Graphile Worker appears only under `spikes/` |
| Object storage | **None required** — asset bytes live in Postgres; the warehouse export writes to any S3-compatible bucket | — | MinIO (AGPL; community edition reduced) | A small install needs no object store: uploads are kept in `asset_blobs` ([assets/index.ts](../../packages/assets/src/index.ts)) and S3 is an export destination ([warehouse/destinations.ts](../../packages/warehouse/src/destinations.ts)). Users pick AWS S3, Cloudflare R2, Garage, SeaweedFS… |

## Product features

| Area | Choice | License | Alternatives considered | Why |
|---|---|---|---|---|
| UI framework | **React 19 + Vite** with an own history router (`apps/web/src/app/router.tsx`) and `useApi`/typed client | MIT | Next.js, TanStack Router/Query | SPA served by the `api` role — no separate frontend server to operate. The router is about a hundred lines of `history.pushState` and `match`, and data loading is a small hook over the typed client ([useApi.ts](../../apps/web/src/app/useApi.ts)) |
| UI components | **Own components** in `apps/web/src/ui` + Tailwind CSS 4 + lucide-react | MIT / ISC | shadcn/ui + Radix, MUI, Mantine | Owned code, no primitive library to track: buttons, fields, drawers, modals, toasts, tables, tabs, menus, code and diff views are all in [`apps/web/src/ui`](../../apps/web/src/ui) |
| Flow canvas | **React Flow (xyflow)** | MIT | Rete.js, JointJS (commercial) | De-facto standard for node editors |
| Graph layout | **Own layered auto-layout** | MIT | ELK.js, dagre | Positions nodes by distance from the trigger, siblings side by side; stored positions always win and no layout dependency ships ([journey/layout.ts](../../apps/web/src/features/journey/layout.ts)) |
| Email format | **MJML** | MIT | React Email, raw HTML | Responsive & client-safe, declarative, LLM-friendly. See [ADR-0006](adr/0006-email-format-and-editor.md) |
| Email visual editor | **GrapesJS + grapesjs-mjml** (with a small normalisation adapter) | BSD-3 | Easy Email (MIT), Unlayer (proprietary), Beefree (proprietary) | Round-trips agent-written MJML + Liquid pixel-identical once self-closing tags are expanded and Liquid is unescaped (spike 2); Easy Email drops preview text and restyles templates |
| Templating | **LiquidJS** | MIT | Handlebars | Sandboxed, marketer-familiar (Shopify, Braze use Liquid) |
| Charts | **Apache ECharts** | Apache-2.0 | Recharts, Chart.js | Rich chart types (funnels, dual axes), SVG renderer, themeable from tokens |
| Code editor | **Plain textarea** for editing + read-only **CodeView** with copy | MIT | Monaco, CodeMirror 6 | The MJML/Liquid and JSON editors are `Textarea`s ([TemplateEditor.tsx](../../apps/web/src/features/templates/TemplateEditor.tsx), [JsonEditor.tsx](../../apps/web/src/features/artifacts/JsonEditor.tsx)); diffs and previews use a `<pre>` with a copy button ([ui/code.tsx](../../apps/web/src/ui/code.tsx)), so no editor bundle ships |
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
| Authentication | **Better Auth** (email/password, `@better-auth/mcp` OAuth 2.1 authorization server for MCP, per-workspace OIDC/SAML SSO and SCIM 2.0; no organization, passkey or 2FA plugin; all packages pinned to one version) | MIT | Keycloak, Ory, Zitadel, Auth.js | Library, not another server to run; covers MCP OAuth needs. Keycloak/Zitadel remain options as external IdPs via OIDC |
| Authorization | Own RBAC in command layer → OpenFGA if needed | — / Apache-2.0 | Casbin, Cerbos | Start simple |
| Key management | Pluggable: env/file KEK, AWS/GCP KMS, **OpenBao** transit | MPL-2.0 | Vault (BSL) | OpenBao is the open fork of Vault |
| HTML sanitizing | **Own sanitisers**: a DOM walk in the browser SDK, htmlparser2 allow-lists on the server | MIT | DOMPurify (not used) | Experience HTML is sanitised before it reaches the page ([sdk-js/personalize.ts](../../packages/sdk-js/src/personalize.ts)); hosted archive bodies and uploaded SVGs use bounded allow-list scans over htmlparser2 ([audience/archive.ts](../../packages/audience/src/archive.ts), [assets/svg.ts](../../packages/assets/src/svg.ts)). Fail-closed, with no DOM dependency on the server |

## Operations

| Area | Choice | License | Why |
|---|---|---|---|
| Packaging | Single OCI image; **Docker Compose** for self-host; **Helm chart** [`deploy/helm/agentic-marketing`](../../deploy/helm/agentic-marketing), the reference Kubernetes deployment in [kubernetes.md](../deployment/kubernetes.md) | — | One artifact to version |
| Reverse proxy / TLS | **None bundled** — TLS is terminated by the operator's proxy, tunnel or Ingress | — | Compose publishes loopback ports and leaves TLS to Cloudflare Tunnel, Tailscale or your own proxy; set `PUBLIC_URL`, `CLIENT_IP_HEADER` and `TRUSTED_PROXY_CIDRS` ([compose.md](../deployment/compose.md)). Kubernetes uses the chart's Ingress ([kubernetes.md](../deployment/kubernetes.md)) |
| Observability | **OpenTelemetry** SDK + `pino` logs; works with any OTLP backend (Grafana stack, SigNoz, etc. — external, optional) | Apache-2.0 / MIT | No backend lock-in |
| CI | GitHub Actions; Dependabot; dependency review; SBOM + build-provenance attestations | — | Supply chain hygiene without another service: Dependabot proposes pinned images and dependencies ([dependabot.yml](../../.github/dependabot.yml)), CI runs the dependency review, and the release build carries `sbom: true` plus `actions/attest-build-provenance` for the image and the release files ([release.yml](../../.github/workflows/release.yml)) |
| Docs site | **Plain Markdown** in `docs/` | — | Read on GitHub and checked by the docs Vitest project; no site build or separate host to operate |

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
