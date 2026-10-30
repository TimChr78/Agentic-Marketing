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

`AM_VERSION` pins the released image `ghcr.io/timchr78/agentic-marketing`; `AM_PORT` is the published admin port (the app still listens on 3000 inside the container). The admin UI and REST API are then on `http://localhost:3000`; MCP needs an HTTPS `PUBLIC_URL`.

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

## Upgrading

Follow [UPGRADING.md](../../UPGRADING.md). The Compose-specific part: unpack the new bundle and copy its `docker-compose.yml` over yours, keep `.env` and `compose.override.yaml`, and check the configuration before you change `AM_VERSION` in `.env`:

```bash
AM_VERSION=<new> docker compose pull
AM_VERSION=<new> docker compose run --rm --no-deps -T app am doctor --env-file - < .env
# then set AM_VERSION=<new> in .env:
docker compose up -d
```

The app takes a Postgres backup and runs migrations before it serves. `am backup`, `am restore` and `am smoke` are described in [UPGRADING.md](../../UPGRADING.md) and [operations](operations.md).
