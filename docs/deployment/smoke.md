# Post-upgrade checks with `am smoke`

`am smoke` is a small HTTP client that checks an installed instance from the outside. Run it after an upgrade, before you put the new version back in front of people: it proves the public listener still hides the admin surface, traversal paths are rejected, assets and forms work, and the admin API, MCP and e-mail provider answer with the configured token.

It does not read the database or the server configuration, so it works from the app container, from the host, or from CI:

```bash
docker compose exec app am smoke --public-url https://links.example.com
```

## Token scope

Create a token in **Settings → API tokens** (or with `apiTokens.create`) and grant only `artifacts:read`. That is enough for every token-based check: `system.status` is readable by any authenticated principal, so the provider check no longer needs an admin token (API tokens cannot hold `workspace:admin` anyway). Add `profiles:read` only if you use `--cleanup`, which looks up the profile a signup created. A token is shown once. Read it from `AM_TOKEN` so it does not land in shell history.

`profiles.erase` needs both the `profiles:erase` scope and a person: it is deliberately people-only, so no API token can erase a profile, whatever scopes it carries. `am smoke --cleanup` with a token therefore finds the profile, reports its id, and says what to do next. If the signup was never confirmed, the unconfirmed-signup retention (`RETENTION_UNCONFIRMED_DAYS`, 30 days by default) removes it; a signup that recorded consent is not removed by that retention, so erase it as a person in the admin UI.

## Flags

| Flag | Meaning |
|---|---|
| `--public-url URL` | Required. The public listener, e.g. `https://links.example.com`. If the site proxies a path, give the prefix too: `https://example.com/am`. |
| `--admin-url URL` | The admin listener, usually `http://localhost:3000` from inside the app container. Needed for the `admin.*` checks. |
| `--token amk_…` | An API token with `artifacts:read`, plus `profiles:read` for `--cleanup` (which only finds the profile; no token can erase). Read from `AM_TOKEN` when the flag is omitted. |
| `--form FORM_ID` | A published form (`frm_…`) for the signup round trip. |
| `--email ADDRESS` | The address to submit to the form. Use an address you can check, preferably a plus address such as `you+smoke@example.com`. |
| `--cleanup` | After the signup check, look up the profile by e-mail and try to erase it. Needs `--admin-url` and a token with `profiles:read`; `profiles.erase` needs `profiles:erase` and a person, so the detail says when retention removes an unconfirmed signup (`RETENTION_UNCONFIRMED_DAYS`, 30 days by default). |
| `--asset PATH` | A public asset path to fetch, e.g. `/a/ast_…/logo.png`. |
| `--json` | Print `{ "ok": true|false, "checks": [...] }` instead of the table. |

The form and asset flags are optional; leave them out if you do not have a test form or asset.

## What the signup check really does

`POST /f/<form>` is not a dry run. A submission writes to the live workspace:

- It creates or updates a customer profile, keyed by the form's anonymous id, with the e-mail address as a trait.
- With a **double opt-in** form it also creates a pending (unconfirmed) signup in the live workspace and sends a real confirmation e-mail through the configured provider. Until someone clicks the link, the profile has no consent for the form's purposes, so it is not in consent-based segments and will not receive consent-based sends.
- A form **without** double opt-in records consent immediately, because that is what the form promises.
- The profile and its form identifier stay until they are erased or cleaned up. The unconfirmed-signup retention (`RETENTION_UNCONFIRMED_DAYS`, 30 days by default) removes profiles that still have no consent and only a form anonymous id; the scheduler applies it. A signup that recorded consent is not removed by that retention.

Use an address you own, such as `you+smoke@example.com`. Do not use a stranger's address or a list member.

`--cleanup` runs after the form answers `303`: it retries `profiles.find` for the submitted address (workers create the profile just after the HTTP response), then calls `profiles.erase` with the reason `am smoke signup cleanup`. When erasure is not allowed, the check still passes and its detail says:

```text
left in place: profiles.erase is people-only, so an API token cannot erase it; if the signup stays unconfirmed, retention (RETENTION_UNCONFIRMED_DAYS) removes it after 30 days, or erase it as a person in the admin UI
```

That is the normal result for an API token, because `profiles.erase` needs `profiles:erase` and can only be run by a person. Erase the profile as a person in the admin UI, or let the retention pass remove an unconfirmed signup after `RETENTION_UNCONFIRMED_DAYS` (30 days by default); a signup that recorded consent is not removed by that retention. Smoke signups are not excluded from profile counts or statistics; only consent-based segments and sends ignore an unconfirmed one.

## What each check proves

| Check | Needs | What it does and what a pass means |
|---|---|---|
| `public.health` | — | `GET <public>/healthz` answers `200` with `{"ok":true}`. The server's `version` is shown when present. |
| `public.admin-hidden` | — | `POST /v1/workspace.get`, `POST /mcp`, `GET /`, `GET /api/auth/get-session` and `GET /openapi.json` on the public URL all answer `404`. The public listener exposes only forms, links, pages, assets and probes. |
| `public.dot-segments` | — | Sends `/f/../v1/workspace.get`, `/f/%2e%2e/v1/workspace.get` and `/hooks/..%2fmcp` exactly as written (no client normalisation); every one answers `400`. |
| `public.assets` | `--asset` | `GET <public><asset>` answers `200` with a non-HTML content type, so uploads and the public asset route still work. |
| `admin.health` | `--admin-url`; token optional | `GET <admin>/readyz` answers `200`, so Postgres, ClickHouse and Valkey are reachable. With a token that can read `system.status`, the detail also shows the running server version. |
| `admin.mcp` | `--admin-url`, token | MCP `initialize` and `tools/list` accept the token and list at least one tool; the detail says how many. |
| `admin.provider` | `--admin-url`, token | `system.status` says an enabled provider covers both marketing and transactional mail, and names its adapter. It fails with which one is missing, without revealing addresses, hosts or secrets. |
| `public.signup` | `--form`, `--email`; `--cleanup` also needs `--admin-url` and `profiles:read` (finding only; erasing needs a person) | Posts an HTML form (`email=…`) to `<public>/f/<form>`. The form answers `303` with a `Location` header. The signup side effects above are real. |

Checks that need a flag are reported as `skip`, not `fail`. A skip does not change the exit code. A failed check does not stop later checks, so one run shows every problem.

## Errors and timeouts

A failed network check includes the underlying cause instead of only `fetch failed`, for example:

```text
fetch failed: connect ECONNREFUSED 127.0.0.1:3000
fetch failed: getaddrinfo ENOTFOUND links.example.com
fetch failed: CERT_HAS_EXPIRED certificate has expired
```

Every request has a five-second timeout, reported as `timed out after 5 s`. A REST command that answers with a non-`200` status includes the status and a short body excerpt, which usually names the missing permission or input.

## Run it after an upgrade

```bash
export AM_TOKEN=amk_…   # artifacts:read, plus profiles:read for --cleanup (finding only)
docker compose exec -e AM_TOKEN app am smoke \
  --public-url https://links.example.com \
  --admin-url http://localhost:3000 \
  --form frm_… \
  --email you+smoke@example.com \
  --cleanup \
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

`ok` is true only when there are no failures.

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

The form, asset and provider checks need those objects to exist in the test instance; create them (or reuse the ones `scripts/smoke.sh` creates) before running the command. The public and admin URLs depend on the published ports in the Compose file. Leave out `--form`/`--email` in a throwaway check unless you want the real signup side effects described above.
