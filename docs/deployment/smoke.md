# Post-upgrade checks with `am smoke`

`am smoke` is a small HTTP client that checks an installed instance from the outside. Run it after an upgrade, before you put the new version back in front of people: it proves the public listener still hides the admin surface, traversal paths are rejected, assets and forms work, and the admin API, MCP and e-mail provider answer with the configured token.

It does not read the database or the server configuration, so it works from the app container, from the host, or from CI:

```bash
docker compose exec app am smoke --public-url https://links.example.com
```

## Flags

| Flag | Meaning |
|---|---|
| `--public-url URL` | Required. The public listener, e.g. `https://links.example.com`. If the site proxies a path, give the prefix too: `https://example.com/am`. |
| `--admin-url URL` | The admin listener, usually `http://localhost:3000` from inside the app container. Needed for the `admin.*` checks. |
| `--token amk_…` | An API token with `workspace:admin`. Read from `AM_TOKEN` when the flag is omitted, so the token does not land in shell history. |
| `--form FORM_ID` | A published form (`frm_…`) for the signup round trip. |
| `--email ADDRESS` | The address to submit to the form. Use an address you can check, or a plus address such as `you+smoke@example.com`. |
| `--asset PATH` | A public asset path to fetch, e.g. `/a/ast_…/logo.png`. |
| `--json` | Print `{ "ok": true|false, "checks": [...] }` instead of the table. |

Create the token in **Settings → API tokens** (or with `apiTokens.create`) and grant only `workspace:admin`. A token is shown once. The form and asset flags are optional; leave them out if you do not have a test form or asset.

## What each check proves

| Check | What it does | What a pass means |
|---|---|---|
| `public.health` | `GET <public>/healthz` | The public listener is reachable and the server answers `200` with `{"ok":true}`. The server's `version` is shown when present. |
| `public.admin-hidden` | `POST /v1/workspace.get`, `POST /mcp`, `GET /`, `GET /api/auth/get-session`, `GET /openapi.json` on the public URL | All five answer `404`. The public listener exposes only forms, links, pages, assets and probes; the admin API, MCP and UI are not reachable through the site. |
| `public.dot-segments` | Sends `/f/../v1/workspace.get`, `/f/%2e%2e/v1/workspace.get` and `/hooks/..%2fmcp` exactly as written (no client normalisation) | Every one answers `400`. Traversal through a public prefix cannot reach the admin API, even encoded. |
| `public.assets` | `GET <public><asset>` | The asset answers `200` with a non-HTML content type, so uploads and the public asset route still work. |
| `admin.health` | `GET <admin>/readyz` | Postgres, ClickHouse and Valkey are reachable: `200` means the admin listener is ready. |
| `admin.mcp` | MCP `initialize`, then `tools/list`, with `Authorization: Bearer <token>` | The MCP endpoint accepts the token and lists at least one tool; the detail says how many. Missing token skips the check. |
| `admin.provider` | `POST /v1/emailProviders.list` with the bearer token | At least one e-mail provider is configured. It fails with `no e-mail provider configured` when deliveries would have nowhere to go. |
| `public.signup` | Posts an HTML form (`email=…`) to `<public>/f/<form>` | The form answers `303` with a `Location` header. A confirmation e-mail should arrive at the address (double opt-in forms send it asynchronously). |

Checks that need a flag are reported as `skip`, not `fail`. A skip does not change the exit code. A failed check does not stop later checks, so one run shows every problem.

## Run it after an upgrade

```bash
export AM_TOKEN=amk_…   # workspace:admin
docker compose exec -e AM_TOKEN app am smoke \
  --public-url https://links.example.com \
  --admin-url http://localhost:3000 \
  --form frm_… \
  --email you+smoke@example.com \
  --asset /a/ast_…/logo.png
```

The table shows each check, then a summary such as `8 checks: 8 passed, 0 failed, 0 skipped`. The command exits `0` when no check failed and `1` when any check failed, so a script or agent can gate the upgrade on it. Missing `--public-url` (or an invalid URL) prints the usage and exits `2`.

With `--json` the same result is machine-readable:

```json
{
  "ok": false,
  "checks": [
    { "id": "public.admin-hidden", "status": "fail", "detail": "expected 404; GET /openapi.json → 200" }
  ]
}
```

`ok` is true only when there are no failures. Each check has a five-second timeout, so a hung listener fails instead of blocking the upgrade.

## Path prefixes and proxies

When the site proxies `/am/*` to the public listener, pass `--public-url https://example.com/am`; every public probe is then sent under `/am`. The proxy must forward the request path unchanged for the dot-segment check: a proxy that answers the traversal itself with `400` is fine, but one that rewrites it to a normal `404` makes `public.dot-segments` fail even though the admin API is still hidden.

Point `--admin-url` at an address the command can reach. From `docker compose exec` that is normally `http://localhost:3000`; from the host it is `http://localhost:3000` only when the admin port is published there.

## In a release workflow

Once the default Compose file publishes a public listener on port 3001, the release smoke test can run the same checks against the built image:

```bash
docker compose exec -e AM_TOKEN app am smoke \
  --public-url http://localhost:3001 \
  --admin-url http://localhost:3000 \
  --json
```

The form, asset and provider checks need those objects to exist in the test instance; create them (or reuse the ones `scripts/smoke.sh` creates) before running the command. The public and admin URLs depend on the published ports in the Compose file.
