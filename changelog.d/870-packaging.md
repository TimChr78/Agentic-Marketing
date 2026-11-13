---
section: Security
issues: [870]
---

- **Breaking:** the Compose file publishes the admin port on `AM_BIND`, which defaults to `127.0.0.1`, instead of every host interface: the admin UI, sign-in, REST API and MCP answer from this machine only, like the public listener's `PUBLIC_BIND`. Set `AM_BIND=0.0.0.0` (or a LAN address) in `.env` to keep the previous behaviour; `am doctor` reports the admin bind and warns when it is widened.
- **Breaking:** `.env.example` leaves `POSTGRES_PASSWORD` and `APP_DB_PASSWORD` empty, so Compose refuses to start from a copied template instead of running with the known `change-me` values. `am init` fills both; set them by hand only when you write `.env` yourself.
- The image healthcheck passes for `ROLE=worker` and `ROLE=scheduler`, which start no HTTP listener: a worker-only or scheduler-only container is no longer permanently unhealthy, and `docker compose up --wait` works for it. A role that serves HTTP still probes `/readyz`, like the Helm chart's probes.
- `scripts/smoke.sh` gives every run its own Compose project, temporary files and free ports, so two runs side by side (or a real install on the same host) no longer collide, and cleanup removes only that run's stack.
- The Docker image and every Compose service image are pinned by digest, the multi-arch index behind each tag, so rebuilding a commit or pulling a tag no longer changes the runtime.
