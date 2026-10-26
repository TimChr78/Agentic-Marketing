# Operations

The admin CLI ships in the image as `am`. Two commands cover the first install and later diagnosis: `am init` writes the configuration, and `am doctor` checks it.

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

`am doctor` prints one row per check and exits `1` if any check fails. Warnings do not fail the command.

```bash
am doctor [--json] [--env-file PATH]
```

`--json` prints the array of checks instead of the table. `--env-file PATH` additionally compares that file with `.env.example` and the keys this server version understands; the path is relative to the directory you ran the command from.

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
| `public-port` | `PUBLIC_PORT` is set. | Set `PUBLIC_PORT=3001` for the public-only listener. Publish it on a loopback-only host address (for example `PUBLIC_BIND=127.0.0.1` in a compose override) and point the tunnel or proxy at it. |
| `trusted-proxy-cidrs` | `TRUSTED_PROXY_CIDRS` is not empty. | List the proxy and loopback ranges, for example `127.0.0.1/32,::1/128,10.0.0.0/8`. Empty trusts forwarded headers from any source. |
| `env-file.unknown` | Every key in the file is in `.env.example` or known to the server. | Remove obsolete keys; unknown keys are ignored. |
| `env-file.missing` | Every uncommented key in `.env.example` is present in the file. | Add the listed keys from the current template; defaults apply until you do. |

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
| `dns.<domain>` | Each enabled provider's from-domain has an SPF TXT record (`v=spf1`) and a DMARC TXT record at `_dmarc.<domain>`. Missing records warn. | Publish the records at your DNS provider. DKIM selectors depend on the e-mail provider; enable DKIM there. |
| `egress.<adapter>` | The API host of each enabled provider adapter answers HTTP, or an SMTP relay accepts a TCP connection. Unreachable is a failure. | Allow outbound HTTPS or SMTP from the host and check the provider's configuration. The `log` adapter is skipped. |

DNS and egress checks only see enabled e-mail providers. With no providers configured they pass without network traffic.
