# Operations

The admin CLI ships in the image as `am`. Two commands cover the first install and later diagnosis: `am init` writes the configuration, and `am doctor` checks it.

`am --help`, `am help`, `am <command> --help`, `am version` and `am` with no arguments work without any configuration: they list the commands or print the version (and the image's commit) without loading `.env`. When configuration is needed and incomplete, the command prints one `Configuration is incomplete: …` line and exits `1`, without a stack trace.

## `am init`

`am init` writes a `.env` from the image's `.env.example`. It generates fresh values for `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `AUTH_SECRET` and `MASTER_KEY`, and asks for the two public addresses. It never prints a secret.

```bash
am init [--out PATH] [--force] [--public-url URL] [--links-url URL]
```

| Option | Meaning |
|---|---|
| `--out PATH` | Where to write, relative to the directory you ran the command from. Default: `.env`. |
| `--force` | Overwrite an existing file. Without it, `am init` refuses. |
| `--public-url URL` | The address people and AI agents use for the admin UI, REST API and MCP. |
| `--links-url URL` | The address used in e-mails and hosted pages when a site proxies those paths first-party. Empty means "use `PUBLIC_URL`". |

On a terminal, a missing address is prompted for, with the template value as the default. Without a terminal, the template value is kept and the command says so. The file is written with mode `0600`.

`PUBLIC_URL` must be HTTPS, or plain HTTP on loopback for local development. A plain-HTTP address on any other host still serves the admin UI and REST API, but MCP is disabled.

### Before the stack exists

Run the released image against the directory that should receive the file:

```bash
docker run --rm -it \
  -v "$PWD:/work" -w /work \
  --user "$(id -u):$(id -g)" \
  ghcr.io/timchr78/agentic-marketing:<version> \
  am init
```

This writes `./.env` as your own user, so `docker compose` can read it. Then start the stack, create the first workspace, and check the result:

```bash
docker compose up -d
docker compose exec app am bootstrap --email you@example.com --workspace 'My workspace'
docker compose exec app am doctor
```

In a checkout, `pnpm cli init` works the same way.

## `am doctor`

`am doctor` prints one row per check and exits `1` if any check fails. Warnings and info rows do not fail the command.

```bash
am doctor [--json] [--env-file PATH|-] [--from VERSION]
```

`--json` prints the array of checks instead of the table.

`--env-file PATH` additionally compares that file with `.env.example` and the keys this server version understands; the path is relative to the directory you ran the command from. `--env-file -` reads it from stdin instead, which is the upgrade check: `docker compose run --rm --no-deps -T app am doctor --env-file - < .env`. It needs no mount, so it works whatever the file's owner and mode. If a path is missing or unreadable, the row says which; for a permission error it names the owner uid and mode (for example `owner uid 0, mode 0600; this container runs as uid 1000`) and suggests `--env-file - < .env`.

Only variables added after the version the file comes from are reported as new. That version is `--from VERSION`, or the file's `AM_VERSION`. Required new variables warn; optional ones (with a default) are an `info` row. The running version's own variables are not new, and Docker Compose's own `COMPOSE_*` and `DOCKER_*` variables are not configuration at all. Variables that `docker-compose.yml` always supplies (`DATABASE_URL`, `CLICKHOUSE_URL`, `NATS_URL`, `VALKEY_URL`, `ROLE`, `PORT`, `BACKUP_DIR`) and the internal `WEB_DIST` and `TRUSTED_ORIGINS` are never reported as missing.

### Offline checks

These need only the environment file and always run.

| Check | Passes when | What to do |
|---|---|---|
| `secrets.auth-secret` | `AUTH_SECRET` is set, at least 32 characters, and not a placeholder. | Generate one with `openssl rand -base64 32`. Changing it signs everyone out. |
| `secrets.master-key` | With `KEY_PROVIDER=local`, `MASTER_KEY` is base64 for exactly 32 bytes. With OpenBao or AWS KMS it is not needed. | Generate one with `openssl rand -base64 32`; see [Kubernetes](kubernetes.md) for the other providers. |
| `secrets.postgres-password` | `POSTGRES_PASSWORD` is set and long, or absent because the app runs inside the container where compose supplies it. | Set a long random password in the compose `.env`. |
| `secrets.app-db-password` | `APP_DB_PASSWORD` is set and at least 8 characters. | Generate one with `openssl rand -hex 24`. |
| `public-url` | `PUBLIC_URL` is valid, HTTPS, or plain HTTP on loopback. | A plain-HTTP LAN address warns that MCP is off; use HTTPS such as a Cloudflare Tunnel or Tailscale. |
| `public-links-url` | `PUBLIC_LINKS_URL` is set and has a different origin from `PUBLIC_URL`. | Empty warns because links use `PUBLIC_URL`; an identical origin warns because the admin host is then also the public host. |
| `public-port` | `PUBLIC_PORT` is set. | Set `PUBLIC_PORT=3001` for the public-only listener. Compose publishes it on the host at `PUBLIC_BIND` in `.env`, a `host:port` address defaulting to `127.0.0.1:3001`; point the tunnel or proxy there. A tunnel container on a Docker network reaches the app directly and needs no host port: remove the mapping with `ports: !override` in `compose.override.yaml`. |
| `trusted-proxy-cidrs` | `TRUSTED_PROXY_CIDRS` is not empty. | List the proxy and loopback ranges, for example `127.0.0.1/32,::1/128,10.0.0.0/8`. Empty trusts forwarded headers from any source. |
| `env-file.unknown` | Every key in the file is in `.env.example` or known to the server; `COMPOSE_*` and `DOCKER_*` belong to Compose and are ignored. | Remove obsolete keys; unknown keys are ignored. |
| `env-file.missing` | No required variable added after the file's `AM_VERSION` (or `--from`) is absent. Optional new variables are an `info` row; Compose-supplied and internal variables are ignored. | Add the listed required keys from the current template before starting the new version; optional ones keep their defaults. Without `AM_VERSION` or `--from`, the row is `info` and says so. |

`info` rows are printed and counted but do not affect the exit code: they report something optional, such as a variable with a default that you may want to set.

### Live checks

These run only when the configuration itself is valid. Each network operation gives up after about three seconds, so a broken service cannot make `am doctor` hang.

| Check | Passes when | What to do |
|---|---|---|
| `config` | `loadConfig()` accepts the environment. | Fix the listed variables in `.env`. |
| `postgres` | A query reaches the database in `DATABASE_URL`. | Start Postgres and check the URL, user and password. |
| `migrations` | Every migration file in `packages/db/migrations` is recorded in `schema_migrations`. A missing table or pending files warns. | Start the app (`docker compose up -d`) to migrate, or run `am migrate`. |
| `clickhouse` | `GET <CLICKHOUSE_URL>/ping` succeeds. | Start ClickHouse and check `CLICKHOUSE_URL`. |
| `nats` | A TCP connection to `NATS_URL` succeeds. | Start NATS and check `NATS_URL`. |
| `valkey` | `PING` against `VALKEY_URL` returns `PONG`. | Start Valkey and check the URL and password. |
| `dns.<domain>` | Each enabled provider's from-domain has an SPF TXT record (`v=spf1`) and an effective DMARC policy. A DMARC record at `_dmarc.<domain>` is used directly; otherwise the check walks up to the organizational domain (stopping before a single label, and treating `co.uk`, `com.au`, `co.nz`, `org.uk` and `ac.uk` as suffixes) and reports that the policy is inherited. Missing records anywhere, or an effective `p=none`, warn. | Publish the records at your DNS provider. DKIM selectors depend on the e-mail provider; enable DKIM there. |
| `egress.<adapter>` | The API host of each enabled provider adapter answers HTTP, or an SMTP relay accepts a TCP connection. Unreachable is a failure. | Allow outbound HTTPS or SMTP from the host and check the provider's configuration. The `log` adapter is skipped. |

DNS and egress checks only see enabled e-mail providers. With no providers configured they pass without network traffic.
