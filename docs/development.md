# Development

## Layout

```
packages/
  core/        ids (UUIDv7, prefixed), AppError, canonical JSON hashing
  db/          SQL migrations, migration runner, Drizzle schema, pools (admin + RLS app role)
  commands/    command registry: defineCommand, permissions/roles, executor (validate → authorize → idempotency → audit)
  artifacts/   versioned artifacts (note, journey), approvals, diffs, workspace + audit commands
  secrets/     envelope encryption (KEK → per-workspace data keys), write-only secret commands
  auth/        Better Auth (people) + OAuth 2.1 for MCP clients, principal resolution
  telemetry/   pino logger, optional OpenTelemetry tracing (OTLP)
  client/      typed REST client inferred from the command registry
apps/
  server/      Hono app: REST (/v1/<command>, /openapi.json), MCP (/mcp), sign-in/consent, health; CLI
  web/         React UI: Phase −1 demo (mocked) + "Live workspace (API)" screen against the real server
spikes/        throw-away prototypes with their FINDINGS.md (not part of CI or the image)
```

Adding a capability = one `defineCommand(...)` in a package + adding it to `apps/server/src/registry.ts`. The REST route, OpenAPI entry, MCP tool and typed client call follow automatically.

## Run locally

Requirements: Node 22+, pnpm 10, PostgreSQL 16, ClickHouse (26.8 LTS), NATS with JetStream (`nats-server -js`) and Valkey (or Redis), local or Docker. `CLICKHOUSE_URL`, `NATS_URL` and `VALKEY_URL` default to localhost.

```bash
pnpm install
cp .env.example .env          # fill AUTH_SECRET and MASTER_KEY (openssl rand -base64 32), point DATABASE_URL at Postgres
pnpm --filter @agentic-marketing/server cli bootstrap --email you@example.com --password '…' --workspace 'My shop'
pnpm dev                       # API on http://localhost:3000 (migrates on start)
pnpm dev:web                   # UI on http://localhost:5173 → "Live workspace (API)"
```

`DATABASE_URL` must be a role that can create roles (the migration creates `am_app`, the row-level-security role the app uses, with `APP_DB_PASSWORD`).

Connect an MCP client (Claude, an IDE, …) to `http://localhost:3000/mcp`. It registers itself, you sign in and choose its permissions on the consent page.

### Docker Compose

```bash
cp .env.example .env   # fill in the secrets
docker compose up --build
docker compose exec app pnpm --filter @agentic-marketing/server cli bootstrap --email … --password … --workspace …
```

### Collecting events

Add a source in the UI ("People & data") or with `sources.create`. Browser sources get a public write key and only accept their allowed origins; by default they keep an event only when the visitor allowed the `analytics` purpose. On a site, use `@agentic-marketing/sdk-js` (`packages/sdk-js`), or any Segment-compatible library pointed at this server (`/v1/batch`, write key as the Basic auth user name). Events show up on the person's profile within a couple of seconds; `ROLE` decides which processes run the `api`, `ingest` and `worker` parts (all by default).

### Personalizing the website

Mark elements with `data-am-placement="home_hero"`, put `antiFlickerSnippet()` from `@agentic-marketing/sdk-js` in the page head, and call `analytics.personalize()` after loading the SDK. Create a web experience for the placement (UI "Web experiences" or `artifacts.create` with type `experience`); published experiences are served by `POST /v1/decide` within 30 seconds. Visitors who have not allowed `web_personalization` only get page-based targeting (page, referrer, UTM, device).

### Members

Owners and admins invite people with `members.invite` (UI, REST or the typed client; agents cannot). The response holds a one-time link, `<PUBLIC_URL>/invite#<token>`, valid for 7 days. Send it to the person; they sign in or create an account with the invited e-mail address and join with the invited role. Only owners can make or change owners, and the last owner can be neither demoted nor removed.

### Rotating the master key

Secrets are encrypted with per-workspace data keys, which are wrapped by `MASTER_KEY`. To rotate it:

1. Generate a new key (`openssl rand -base64 32`), set it as `MASTER_KEY`, and put the old one in `MASTER_KEY_PREVIOUS`. Restart; everything keeps working, and new data keys use the new master key.
2. Run `pnpm --filter @agentic-marketing/server cli rotate-keys` to re-wrap every existing data key with the new master key.
3. Remove `MASTER_KEY_PREVIOUS` and restart.

## Checks

```bash
pnpm lint        # Biome
pnpm typecheck
pnpm test        # unit + integration; needs Postgres (TEST_DATABASE_URL, default postgres://am:am@localhost:5432/am_test),
                 # ClickHouse (CLICKHOUSE_URL) and NATS (NATS_URL); test databases and streams are recreated per run
```

CI (`.github/workflows/ci.yml`) runs the same three against a Postgres service container.

## Conventions

- Dependencies are pinned to exact versions that have been published for at least two weeks (`.npmrc` `save-exact`). Better Auth packages are pinned together via `pnpm.overrides`.
- Migrations are forward-only SQL files in `packages/db/migrations`; never edit an applied one (the runner refuses).
- Every tenant table has `workspace_id` and row-level security. Command handlers use the transaction they are given and do not filter by workspace manually.
- Errors users or agents can act on are `AppError`s with a message that says what to do next.
