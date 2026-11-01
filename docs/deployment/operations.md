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
| `public-port` | `PUBLIC_PORT` is set. | Set `PUBLIC_PORT=3001` for the public-only listener. Compose publishes it on the host at `PUBLIC_BIND` in `.env`, a `host:port` address defaulting to `127.0.0.1:3201`; point the tunnel or proxy there. A tunnel container on a Docker network reaches the app directly and needs no host port: remove the mapping with `ports: !override` in `compose.override.yaml`. |
| `ports` | The host port in `PUBLIC_BIND` (or its default) differs from `AM_PORT` (default 3000). | Set `PUBLIC_BIND` to another port, or drop the public mapping with `ports: !override` in `compose.override.yaml`. Compose would otherwise fail with "address already in use". Pass the `.env` with `--env-file` when the container cannot see `AM_PORT` and `PUBLIC_BIND`; on the host, `ss -ltn | grep ':<port> '` shows whether the port is taken. |
| `trusted-proxy-cidrs` | `TRUSTED_PROXY_CIDRS` is not empty. | List the proxy and loopback ranges, for example `127.0.0.1/32,::1/128,10.0.0.0/8`. Empty trusts forwarded headers from any source. A multi-value `x-forwarded-for` is walked right to left, skipping hops in these ranges; the Helm chart refuses an Ingress without them. |
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
| `queue.messages` | Counts messages in `queued` or `sending` and reports the age of the oldest. Warns when the oldest has waited more than 15 minutes; an empty queue passes. | A queue that does not drain means the worker role is not running or is stuck: check `ROLE=worker` and the worker logs. |
| `queue.journeys` | Counts journey participants whose next step is due and reports the age of the oldest. Warns above 15 minutes. | Journey steps run in the worker role; check its logs for the journey sweeper. |
| `queue.broadcasts` | Counts broadcast runs past their send time that the scheduler has not finished, and how long the oldest is overdue. Warns above 10 minutes. | Broadcasts run in the scheduler role; keep it at one replica and check its logs. |
| `queue.warehouse` | Reports enabled warehouse exports that are due or were requested (informational; a large warehouse export is expected to be "due" while it runs). | Check the export's schedule and last error in the admin UI. |
| `deliveries` | Counts webhook and action deliveries that ended `dead` in the last 24 hours and, in the message, the dead share of the last hour. Any dead delivery warns. | A dead delivery stopped after its retries: check the endpoint URL, its response and `EGRESS_ALLOWED_HOSTS`. |

The queue and delivery rows are computed from the same tables the workers claim work from, with one aggregate query and the same three-second ceiling as the other live checks. On a fresh install whose schema is not migrated yet they are one `info` row instead.

ClickHouse insert lag is deliberately not a row: the events table's `received_at` is the ingest time, so an idle install would look permanently "lagging". The `clickhouse` row proves reachability, and `am_dependency_up{name="clickhouse"}` does the same for monitoring.

DNS and egress checks only see enabled e-mail providers. With no providers configured they pass without network traffic.

## Monitoring

The server exposes `GET /metrics` on the **main** listener (`PORT`, default 3000) in the Prometheus text format. It is never served on the public-only listener (`PUBLIC_PORT`), and it is **off by default**: without `METRICS_TOKEN` the route answers `404` like any unknown path, so an upgrade that sets nothing exposes nothing new.

```bash
openssl rand -hex 24          # the token; put it in .env (or a Kubernetes Secret)
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3000/metrics
```

The endpoint accepts only the `Authorization: Bearer …` header: a missing or wrong token gets `401` (no `?token=` query form, so the secret stays out of proxy access logs). Each scrape runs the dependency checks and one aggregate query against Postgres, every one of them limited to 3 seconds.

### Scrape configuration

```yaml
# prometheus.yml
scrape_configs:
  - job_name: agentic-marketing
    scrape_interval: 30s
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/am-metrics-token   # the METRICS_TOKEN value, mode 0600
    static_configs:
      - targets: ["app:3000"]   # the compose service; on Kubernetes, the api Service on port 80
```

In Docker Compose, a Prometheus container on the same project network reaches the app as `app:3000`. In Kubernetes, scrape the `api` Service (`http`, port 80) and keep the token in a Secret (`secrets.existingSecret` or `secrets.values.METRICS_TOKEN`); the worker and scheduler roles are not scraped individually because the queue gauges are global. Never point a scrape at `PUBLIC_PORT`.

### Metrics

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `am_process_uptime_seconds` | gauge | | Seconds since the process started. |
| `am_process_start_time_seconds` | gauge | | Unix time the process started; use it for `time() - am_process_start_time_seconds`. |
| `am_process_resident_memory_bytes` | gauge | | Resident set size. |
| `am_process_heap_used_bytes` | gauge | | JavaScript heap in use. |
| `am_process_event_loop_lag_seconds` | gauge | | Mean event-loop delay since the previous scrape (10 ms resolution). |
| `am_http_requests_total` | counter | `route`, `status` | HTTP requests by route group (`auth`, `v1`, `mcp`, `pages`, `public`, `ui`, `well-known`, `healthz`, `readyz`) and status class (`2xx`…`5xx`). |
| `am_http_request_duration_seconds` | histogram | `route`, `status` | Request duration, same groups; buckets from 5 ms to 10 s. |
| `am_commands_total` | counter | `command`, `effect`, `outcome` | Command executions; `outcome` is `ok` or `error` and covers REST, MCP and SCIM because they all run through one executor. |
| `am_queue_messages_pending` | gauge | | Messages in `queued` or `sending`. |
| `am_queue_messages_oldest_seconds` | gauge | | Age of the oldest unsent message: how far the delivery queue is behind. |
| `am_journey_participants_due` | gauge | | Journey participants whose next step is due now. |
| `am_journey_participants_oldest_due_seconds` | gauge | | Age of the oldest due, unprocessed journey step. |
| `am_broadcast_runs_due` | gauge | | Broadcast runs past their send time that the scheduler has not finished. |
| `am_warehouse_exports_due` | gauge | | Enabled warehouse exports that are due or were asked to run. |
| `am_deliveries_dead_24h` | gauge | | Webhook/action deliveries that ended `dead` in the last 24 hours. |
| `am_agent_decisions_last_hour` | gauge | `decision` | Agent ledger decisions (`allow`, `hold`, `ask`, `deny`) in the last hour. |
| `am_dependency_up` | gauge | `name` | `1` when Postgres, ClickHouse, NATS or Valkey answered on this scrape, else `0`. |

No label carries a workspace, person, address or command input, and every label has a fixed or registry-bounded set of values, so cardinality cannot grow with traffic. `/metrics` is not counted in its own request metrics.

The queue gauges come from the same queries the workers use to claim work, computed on scrape. If Postgres is unreachable or its schema is not migrated yet, those series are simply absent and the rest of the exposition is still returned. ClickHouse insert lag is not exposed: `received_at` is the ingest time, so an idle install would look "lagging"; `am_dependency_up{name="clickhouse"}` reports reachability instead, and `am_commands_total` plus the `/readyz` probe cover the rest.

### Example alert rules

```yaml
# am-alerts.yml
groups:
  - name: agentic-marketing
    rules:
      - alert: AgenticMarketingDown
        expr: up{job="agentic-marketing"} == 0
        for: 5m
        labels: { severity: page }
        annotations: { summary: "Agentic Marketing is not answering scrapes" }
      - alert: AgenticMarketingDependencyDown
        expr: am_dependency_up == 0
        for: 2m
        labels: { severity: page }
        annotations: { summary: "{{ $labels.name }} is unreachable from Agentic Marketing" }
      - alert: AgenticMarketingDeliveryQueueBehind
        expr: am_queue_messages_oldest_seconds > 900
        for: 10m
        labels: { severity: page }
        annotations: { summary: "Oldest unsent message is {{ $value }}s old" }
      - alert: AgenticMarketingJourneyQueueBehind
        expr: am_journey_participants_oldest_due_seconds > 900
        for: 10m
        labels: { severity: ticket }
      - alert: AgenticMarketingDeadLetters
        expr: am_deliveries_dead_24h > 0
        for: 5m
        labels: { severity: ticket }
        annotations: { summary: "Webhook/action deliveries are dead-lettering" }
      - alert: AgenticMarketingCommandErrors
        expr: sum by (command) (rate(am_commands_total{outcome="error"}[5m])) > 0.2
        for: 10m
        labels: { severity: ticket }
      - alert: AgenticMarketingEventLoopLag
        expr: am_process_event_loop_lag_seconds > 0.5
        for: 10m
        labels: { severity: ticket }
```

`am doctor` reports the same queue backlog and dead-letter values when run by hand; see the [live checks](#live-checks) above.

## Backups, retention and erasures

`am backup` writes a Postgres dump (and ClickHouse with `--clickhouse`); `am restore` replaces the
live data. The full procedure, names and manifest are in [Backups and restore](backups.md).

- **Retention.** `BACKUP_KEEP_DAYS` (default 14 for the scheduler) is the maximum age of a restore
  point, and therefore the longest a restored snapshot can predate an erasure. Give a remote
  lifecycle the same or a shorter window, and keep taking backups: the newest snapshot is what a
  restore uses.
- **Erasures are replayed.** `am restore` reads `erasures` and `erasure_tombstones` from the live
  database before replacing it and re-applies them afterwards: the erased profiles and identifiers
  are deleted again (with their push subscriptions), suppression hashes are restored and the keyed
  tombstones are re-inserted. A person erased after the snapshot does not come back. Replay is
  idempotent; if the erasure log cannot be read, the restore stops instead of risking a resurrection.
- **ClickHouse.** `--clickhouse` reloads the event export as taken. Event rows of a replayed person
  keep their pseudonymous ids and non-personal properties, but the profile key that sealed their
  personal data is deleted by the replay, so that data stays unreadable. Take a `--clickhouse`
  backup after erasures when the DSR procedure requires removing event rows too.
- **Keep `.env` apart.** Backups do not include `MASTER_KEY`; without it the restored secrets and
  personal data cannot be decrypted.

## Verifying a release

Every release carries SLSA build provenance from the release workflow (GitHub Actions). The image's provenance and its SBOM (one per platform) are attestations in the registry, next to the image; the Compose bundle, the Helm chart and `SHA256SUMS` carry their own, keyed by their sha256.

```bash
gh attestation verify oci://ghcr.io/timchr78/agentic-marketing:<version> --repo TimChr78/Agentic-Marketing
gh attestation verify agentic-marketing-compose-<version>.tar.gz --repo TimChr78/Agentic-Marketing
```

The chart `.tgz` and `SHA256SUMS` verify the same way. To read the SBOM of the image, or its provenance:

```bash
docker buildx imagetools inspect ghcr.io/timchr78/agentic-marketing:<version> --format '{{ json .SBOM }}'
docker buildx imagetools inspect ghcr.io/timchr78/agentic-marketing:<version> --format '{{ json .Provenance }}'
```
