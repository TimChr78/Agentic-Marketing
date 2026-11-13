# Docker Compose deployment

The release page has a Compose bundle, `agentic-marketing-compose-<version>.tar.gz`. It contains [`docker-compose.yml`](../../docker-compose.yml), [`.env.example`](../../.env.example), [`compose.override.example.yaml`](../../compose.override.example.yaml), [`UPGRADING.md`](../../UPGRADING.md) and [`CHANGELOG.md`](../../CHANGELOG.md). They run the one image next to Postgres, ClickHouse, NATS JetStream and Valkey on a single host.

## Install

Download the bundle from the [release page](https://github.com/TimChr78/Agentic-Marketing/releases), then:

```bash
tar xzf agentic-marketing-compose-<version>.tar.gz && cd agentic-marketing-compose-<version>
# writes .env with generated secrets (never printed) and asks for the public URLs
docker run --rm -it -v "$PWD:/work" -w /work --user "$(id -u):$(id -g)" \
  ghcr.io/timchr78/agentic-marketing:<version> am init
docker compose up -d
docker compose exec app am bootstrap --email you@example.com --workspace 'My site'
docker compose exec app am doctor
```

`am init` writes `.env` with generated values for `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `AUTH_SECRET` and `MASTER_KEY`, and asks for the two public URLs. It never prints a secret. See [operations](operations.md) for its options.

The template leaves `POSTGRES_PASSWORD` and `APP_DB_PASSWORD` empty on purpose: Compose's `${VAR:?…}` checks refuse an empty value as well as an unset one, so a copied `.env.example` stops with "set POSTGRES_PASSWORD in .env" instead of starting with a password everyone knows. Run `am init` (or fill both by hand) before the first `docker compose up -d`.

By hand, generate the two passwords as **hex** (`openssl rand -hex 32`) and the two keys as base64 (`openssl rand -base64 32`). Compose substitutes `POSTGRES_PASSWORD` into `DATABASE_URL` verbatim and cannot percent-encode it, so a base64 password that contains `/` makes the URL invalid: the app then stops with `Configuration is incomplete: DATABASE_URL is not a valid URL` instead of a stack trace. If a password must stay as it is, percent-encode the reserved character in `DATABASE_URL` yourself (`/` as `%2F`) and set that `DATABASE_URL` for the `app` service in `compose.override.yaml`.

`AM_VERSION` pins the released image `ghcr.io/timchr78/agentic-marketing`; `AM_PORT` is the published admin port (the app still listens on 3000 inside the container). The admin UI and REST API are then on `http://localhost:3000`; MCP needs an HTTPS `PUBLIC_URL`.

`AM_BIND` is the host address the admin port is published on, `127.0.0.1` by default: the admin UI, sign-in, REST API and MCP answer from this machine only, exactly like the public listener's `PUBLIC_BIND`. Set `AM_BIND` to a LAN address, or to `0.0.0.0` for every interface, only when the network in front is trusted; otherwise keep it loopback and put the tunnel or reverse proxy on this host. Takes effect on `docker compose up -d` (the container is recreated when its published ports change).

## Environment variables

Every variable the server reads is passed into the `app` container, including `METRICS_TOKEN`, the step-up limits, `ERASURE_GRACE_HOURS`, `KEY_PROVIDER` with the OpenBao/AWS KMS settings, and the isolation keys `APP_DB_ROLE`, `CLICKHOUSE_DATABASE`, `NATS_NAMESPACE` and `VALKEY_PREFIX`. Uncomment or append an entry in `.env` and run `docker compose up -d`; Compose recreates the container when the environment changes. `.env.example` documents every key with its default, so an unset (or empty) value still applies that default.

Compose supplies the service URLs (`DATABASE_URL`, `CLICKHOUSE_URL`, `NATS_URL`, `VALKEY_URL`), `ROLE=all`, `PORT=3000` and `BACKUP_DIR=/backups` itself. They are documented in `.env.example` for other deployments; changing them in the Compose `.env` does not move the Compose stack to another service.

`DATABASE_URL` must reach PostgreSQL directly or through a pooler in **session** pooling mode. Idempotency uses session advisory locks, which belong to the PostgreSQL backend; PgBouncer's **transaction** pooling mode can move that backend between clients and is not supported. The Compose stack has no pooler.

## Never edit docker-compose.yml

Treat `docker-compose.yml` as read-only. Compose reads `compose.override.yaml` from the same directory automatically, so site-specific changes go there:

```bash
cp compose.override.example.yaml compose.override.yaml
```

The example has commented blocks for a tunnel on another Docker network, bind mounts instead of the named volumes and resource limits, plus a pointer to the backups guide. Uncomment the block you need. Upgrading then means replacing `docker-compose.yml` with the new release's copy and bumping `AM_VERSION`; your override is untouched.

## The public listener

Set `PUBLIC_PORT` (e.g. `3001`) to add a listener that serves only `/f`, `/u`, `/c`, `/a`, `/n`, `/hooks`, `/healthz` and `/readyz`; everything else is 404 there. The compose file publishes it on `PUBLIC_BIND`, the host side as `host:port` (default `127.0.0.1:3201`, loopback only), so there is nothing to uncomment:

- a tunnel container on the same Compose network (or attached with the override) points at `http://app:3001` and needs no host port at all: drop the mapping with `ports: !override` in `compose.override.yaml` (block (a) of the example; Compose 2.24 or newer);
- a tunnel or proxy on another host or network sets `PUBLIC_BIND=0.0.0.0:3001` (or a LAN address) in `.env` and points at this host.

`PUBLIC_BIND` only chooses the host side; the container port stays `PUBLIC_PORT`. With `PUBLIC_PORT` unset the app does not listen on the container port, so the loopback-only mapping is harmless. Before upgrading, check that the host port is free: `ss -ltn | grep ':3201 '` should print nothing (3001 was the default in 0.2.4 and collides with Uptime Kuma and dashdot; 0.2.5 briefly used 3210, which collides with an admin port set to `AM_PORT=3210`).

## Security headers and the proxy

The app sets baseline headers on every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY` (and `Content-Security-Policy: frame-ancestors 'none'` on the admin UI), a `Permissions-Policy` that turns off camera, microphone and geolocation, and, when `PUBLIC_URL` starts with `https://`, `Strict-Transport-Security: max-age=31536000`. Hosted pages, the archive and assets send their own stricter policies, which the defaults do not replace. TLS belongs to the proxy or tunnel in front. If it sets any of these headers as well, make it replace the app's value rather than add a second header.

## Restarts and health

Every service has `restart: unless-stopped`, so the stack comes back after a host reboot or a Docker daemon restart. NATS is health-checked through its monitoring endpoint on 8222 (the Alpine image, which has `wget`), Valkey through `valkey-cli ping`; the app waits for Postgres, ClickHouse, NATS and Valkey to be healthy before it starts.

The app image's healthcheck runs every 15 s and ignores the first 120 s (`--start-period=120s`): the pre-upgrade backup and migrations run before the server listens, so they must not count as failed probes. It checks `/readyz` for the roles that serve HTTP (`api`, `ingest`, or `all`) and passes without a probe for a worker-only or scheduler-only container, which starts no listener — the same rule as the Helm chart's probes. An upgrade on a large install can take longer than two minutes; start it with `docker compose up -d` rather than `docker compose up --wait` when you expect slow migrations, then follow `docker compose ps` and `docker compose logs -f app` until the container is healthy.

## Upgrading

Follow [UPGRADING.md](../../UPGRADING.md). The Compose-specific part: unpack the new bundle and copy its `docker-compose.yml` over yours, keep `.env` and `compose.override.yaml`, and check the configuration before you change `AM_VERSION` in `.env`:

```bash
AM_VERSION=<new> docker compose pull
AM_VERSION=<new> docker compose run --rm --no-deps -T app am doctor --env-file - < .env
# then set AM_VERSION=<new> in .env:
docker compose up -d
```

The app takes a Postgres backup and runs migrations before it serves. `am backup`, `am restore` and `am smoke` are described in [UPGRADING.md](../../UPGRADING.md) and [operations](operations.md).
