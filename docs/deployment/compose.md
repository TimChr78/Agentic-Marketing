# Docker Compose deployment

The release page has three files: [`docker-compose.yml`](../../docker-compose.yml), [`.env.example`](../../.env.example) and [`compose.override.example.yaml`](../../compose.override.example.yaml). They run the one image next to Postgres, ClickHouse, NATS JetStream and Valkey on a single host.

## Install

Download them from the [release page](https://github.com/TimChr78/Agentic-Marketing/releases), then:

```bash
cp .env.example .env       # set the secrets (openssl rand -base64 32) and the public URLs
docker compose up -d
docker compose exec app am bootstrap --email you@example.com --workspace 'My site'
```

`AM_VERSION` pins the released image `ghcr.io/timchr78/agentic-marketing`; `AM_PORT` is the published admin port (the app still listens on 3000 inside the container). The admin UI and REST API are then on `http://localhost:3000`; MCP needs an HTTPS `PUBLIC_URL`.

## Never edit docker-compose.yml

Treat `docker-compose.yml` as read-only. Compose reads `compose.override.yaml` from the same directory automatically, so site-specific changes go there:

```bash
cp compose.override.example.yaml compose.override.yaml
```

The example has commented blocks for a tunnel on another Docker network, bind mounts instead of the named volumes and resource limits, plus a pointer to the backups guide. Uncomment the block you need. Upgrading then means replacing `docker-compose.yml` with the new release's copy and bumping `AM_VERSION`; your override is untouched.

## The public listener

Set `PUBLIC_PORT` (e.g. `3001`) to add a listener that serves only `/f`, `/u`, `/c`, `/a`, `/hooks`, `/healthz` and `/readyz`; everything else is 404 there. The compose file always publishes it, on `127.0.0.1` by default, so there is nothing to uncomment:

- a tunnel container on the same Compose network (or attached with the override) points at `http://app:3001`;
- a tunnel or proxy on another host or network sets `PUBLIC_BIND=0.0.0.0:3001` (or a LAN address) in `.env` and points at this host.

With `PUBLIC_PORT` unset the app does not listen on the container port, so the loopback-only mapping is harmless. Change `PUBLIC_BIND` (and `PUBLIC_PORT` to match) if port 3001 is taken on the host.

## Restarts and health

Every service has `restart: unless-stopped`, so the stack comes back after a host reboot or a Docker daemon restart. NATS is health-checked through its monitoring endpoint on 8222 (the Alpine image, which has `wget`), Valkey through `valkey-cli ping`; the app waits for Postgres, ClickHouse, NATS and Valkey to be healthy before it starts.

## Upgrading

Back up Postgres first; migrations only move forward and run when the app starts.

```bash
# replace docker-compose.yml with the new release's copy, set AM_VERSION in .env, then:
docker compose pull
docker compose up -d
```

The override file and `.env` stay as they are. Read the release note's "Upgrading from the previous version" block for new variables and manual steps.
