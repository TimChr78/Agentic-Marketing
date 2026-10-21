# Spike 1 — Command registry → REST + MCP + typed UI client

**Question:** can one command definition drive the REST API (with OpenAPI), the MCP server (with OAuth) and a typed UI client, with authorization, tenancy, idempotency and audit enforced in one place? ([ADR-0005](../../docs/architecture/adr/0005-command-registry-mcp.md))

**Answer: yes.** The pattern works with little code, and real MCP OAuth (dynamic client registration, PKCE, audience-bound tokens) works end to end with Better Auth. Two things in the ecosystem changed since the architecture was written (MCP spec 2026-07-28 / SDK v2, and how MCP clients request scopes); both are reflected below and in the docs.

## What was built

| Piece | File | Size |
|---|---|---|
| Registry: `defineCommand`, `execute` (validate → authorize → idempotency → handler → audit) | `src/registry.ts` | ~150 lines |
| 7 journey/audit commands with zod schemas | `src/commands/journeys.ts` | real graph validation (unique ids, edges point to existing nodes, exactly one trigger) |
| REST surface + OpenAPI 3.1 from the registry | `src/surfaces/rest.ts` | ~50 lines, no per-command code |
| MCP surface (stateless, MCP 2026-07-28) behind OAuth | `src/surfaces/mcp.ts` | ~60 lines, no per-command code |
| Typed UI client, types inferred from the registry | `src/surfaces/client.ts` | ~45 lines, no codegen |
| Better Auth: email/password for people, OAuth 2.1 authorization server for MCP clients | `src/auth.ts` | |
| Postgres with row-level security and a non-bypass app role | `src/db/*` | |
| End-to-end tests (14) | `test/e2e.test.ts` | real Postgres, real HTTP, real MCP SDK client doing the OAuth flow |

## Results

| Check | Result |
|---|---|
| One definition → REST route, OpenAPI path, MCP tool (input + output schema, annotations), typed client call | ✅ Adding a command is one `defineCommand` + one line in the registry list |
| Typed client catches mistakes at compile time | ✅ Wrong command name or field is a TypeScript error; types come from `z.input`/`z.output` of the registry |
| Same validation error on every surface, and it is audited | ✅ Validation lives in `execute`, not the HTTP framework; zod-openapi is used only to *document* routes |
| MCP OAuth: discovery (RFC 9728 + RFC 8414), dynamic client registration, PKCE, consent, RFC 9207 `iss` check, JWT access tokens bound to the `/mcp` resource | ✅ Using `@better-auth/mcp` + MCP SDK v2 client |
| Agent principal = user's role permissions ∩ scopes granted to the client | ✅ Read-only grant → `journeys.createDraft` fails with `forbidden: Missing permission journeys:write` |
| Humans-only commands (approve) hidden from agents and refused if called anyway | ✅ |
| Approval policy: agent-authored draft goes to review, a person approves via REST | ✅ |
| Tenant isolation with Postgres RLS (`set_config('app.workspace_id')` per transaction, `am_app` role without BYPASSRLS) | ✅ `journeys.list` deliberately has **no** workspace filter; another workspace still sees nothing |
| Idempotency keys (same key + same input → same result; different input → 409) | ✅ REST via `Idempotency-Key` header |
| Hash-chained audit log, append-only for the app role | ✅ Chain recomputed in the test; `UPDATE audit_log` is denied |
| Latency, local, sequential, incl. token/session check, RLS transaction and audit insert | REST p50 **11 ms** / p95 15 ms · MCP p50 **9 ms** / p95 15 ms |

## Findings that change the architecture

1. **MCP moved on: spec 2026-07-28 and TypeScript SDK v2.** The SDK is now split into `@modelcontextprotocol/server` and `@modelcontextprotocol/client` (Apache-2.0). `createMcpHandler` is **stateless per request** — no session store, so `api` pods scale horizontally with nothing shared. 2025-era clients are still served (statelessly) by default. → Tech stack and ADR-0005 updated.
2. **MCP clients ask for every advertised scope.** The SDK builds the scope list from the server's metadata/challenge, not from the client's own registration. Least privilege therefore has to come from **the consent screen** (the person picks which permissions the agent gets) and later from **scope step-up** (advertise only `journeys:read` up front and answer with `insufficient_scope` when a write is attempted). The spike proves consent-time narrowing; step-up is a Phase 0 item. → `agents-and-mcp.md` updated.
3. **Validation belongs in the registry, not the web framework.** Letting `@hono/zod-openapi` validate would give REST a different error shape from MCP and skip the audit log. Routes are documented with `registerPath` and validated in `execute`.
4. **RLS needs two database roles.** The table owner / superuser bypasses RLS, so the command layer must connect as a separate role. Migrations and Better Auth's global identity tables use the admin role.

## Gotchas found

- **Better Auth packages must be pinned together.** `@better-auth/mcp@1.7.7` pulled `@better-auth/oauth-provider@1.7.12`, which crashed against `@better-auth/core@1.7.7`. Fixed with pnpm `overrides`. Better Auth shipped 12 releases in 6 weeks; upgrade deliberately, all packages at once.
- The RFC 9728 metadata route (`/.well-known/oauth-protected-resource/mcp`) is answered by the MCP plugin only when the **root** path reaches `auth.handler`; it is not under `/api/auth`.
- `/oauth2/authorize` answers non-HTML requests with a JSON `{ redirect, url }` instead of a 302 (matters for headless tests only).
- Vitest sets `process.env.BASE_URL` (a Vite convention); the spike reads `PUBLIC_URL` instead.
- MCP SDK v2 warns unless the client provider implements `saveDiscoveryState()` / `discoveryState()` (SEP-2352).

## Not covered (follow-ups for Phase 0)

- **Client ID Metadata Documents (CIMD)** — MCP 2026-07-28's preferred registration; Better Auth supports it via `@better-auth/cimd`. Enable alongside DCR.
- **Scope step-up** with `insufficient_scope` challenges, and per-permission checkboxes on the consent page.
- **Confirmation via MCP elicitation** (`inputRequired`) for high-impact tools, e.g. "send to 12 000 people?".
- Idempotency keys for MCP calls (no standard header; use `_meta` or an optional argument).
- Audit-chain ordering under concurrent writes (per-workspace advisory lock or sequence).
- A real desktop MCP client (Claude, IDEs) against a deployed instance; the SDK client here exercises the same protocol but not each client's quirks.
- Refresh-token rotation and token revocation paths.

## Run it

```bash
# Postgres 16 locally (or any reachable instance), then:
psql -c "CREATE USER am WITH PASSWORD 'am' SUPERUSER" -c "CREATE DATABASE am OWNER am"
pnpm install
pnpm --filter @agentic-marketing/spike-command-registry test     # migrates, then runs the 14 end-to-end tests
pnpm --filter @agentic-marketing/spike-command-registry start    # http://localhost:3100  (/openapi.json, /mcp, /login)
```

Environment: `ADMIN_DATABASE_URL`, `APP_DATABASE_URL`, `PUBLIC_URL`, `PORT`, `AUTH_SECRET` (see `src/config.ts`). The `am_app` role is created by the migration.
