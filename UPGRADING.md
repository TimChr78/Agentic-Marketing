# Upgrading Agentic Marketing (Docker Compose)

This file ships in every release's Compose bundle (`agentic-marketing-compose-<version>.tar.gz`), next to `CHANGELOG.md`. What changes in a particular release is in that release's notes, under **Upgrading from** the previous release; this file is the procedure that stays the same. Skipping releases is fine: see [Skipping releases](#skipping-releases).

## The rule

Never edit `docker-compose.yml`. Put everything specific to your site (tunnel networks, bind mounts, resource limits, the backup service) in `compose.override.yaml` next to it, starting from `compose.override.example.yaml`. Compose reads the override automatically, so an upgrade replaces `docker-compose.yml` and changes nothing else.

## Notes from earlier releases

Every release from 0.2.4 to 0.6.1 applies its migrations at start-up, and none needs a manual database step. A few changes still need attention because they alter configuration or how a feature is granted:

- **0.4.0, new answers:** `artifacts.requestPublish` and `artifacts.requestPublishBundle` can answer `status: on_hold` with `runsAt`, and `agents.activity` can show the decision `hold`. A client that switches on `status` should accept the new value.
- **0.4.1, Helm with an Ingress:** the chart refuses to render while `config.TRUSTED_PROXY_CIDRS` is empty, because the ingress forwards client-supplied headers. Set it to the ranges the app sees as its peer (the ingress controller's pod or node network) before upgrading; see [Client IP behind the ingress](https://github.com/TimChr78/Agentic-Marketing/blob/main/docs/deployment/kubernetes.md#client-ip-behind-the-ingress).
- **0.5.0, `METRICS_TOKEN` (optional):** `GET /metrics` is off and answers `404` until it is set to at least 16 characters. Without it nothing new is exposed; with it, scrape the main listener with `Authorization: Bearer $METRICS_TOKEN`. The endpoint is never served on the public-only listener.
- **0.6.0–0.6.1, level 4:** an agent may run the loop only when the workspace allows it (`allowLoops`, a level-4 ceiling) and the agent has earned it. Earning starts again in 0.6.1: only ledger entries recorded at level 3 or above count, and entries from before 0.6.1 have no level, so an agent that was on its way needs the new four weeks.
- **0.6.1, bulk enrollment:** a job started on 0.6.0 pins its journey and segment versions on its next chunk. If either was republished meanwhile, the job stops as `failed` with the reason and the rest needs a new job.

## Every upgrade

1. **Read the release notes' upgrade block.** It always has the same five lines:
   - **Migrations:** whether database migrations run at start-up (they only move forward);
   - **Configuration:** new, changed or removed variables, with their defaults;
   - **Breaking changes:** commands, inputs, outputs or artifact formats that change;
   - **Manual steps:** anything to do before or after, or "none";
   - **Upgrade:** the one-line upgrade.
2. **Back up.** `docker compose exec app am backup` writes a Postgres dump with a manifest to the `backups` volume (add `--clickhouse` for the event history). The app also takes a Postgres backup by itself before it migrates, unless `SKIP_PRE_UPGRADE_BACKUP=true`. If the version you run is older than 0.2.4, it has no `am backup`: dump Postgres by hand with `docker compose exec -T postgres pg_dump -U am -Fc am > pre-upgrade.dump`. See [docs/deployment/backups.md](https://github.com/TimChr78/Agentic-Marketing/blob/main/docs/deployment/backups.md).
3. **Replace the release files and pull.** Unpack the new bundle and copy its `docker-compose.yml` over yours; keep your `.env` and `compose.override.yaml`. Pull the new image without editing `.env` yet: `AM_VERSION=<new> docker compose pull`. Nothing restarts yet.
4. **Compare your configuration** with the new image before changing `AM_VERSION` in `.env`, so the file's `AM_VERSION` is still the version you come from: `AM_VERSION=<new> docker compose run --rm --no-deps -T app am doctor --env-file - < .env`. It reads the file from stdin (no mount, no owner or mode problems) and lists variables added since your version and ones it no longer knows. Add new required ones from the bundle's `.env.example`; optional ones keep their defaults.
5. **Upgrade.** Set `AM_VERSION=<new>` in `.env`, then `docker compose up -d` starts the new version; it backs up and migrates before it serves.
6. **Check.** `docker compose exec app am doctor` checks the configuration, the services and your sending domains. `docker compose exec app am smoke --public-url https://links.example.com` checks the public host the way a visitor and an agent see it (admin paths hidden, forms, assets, MCP); see [docs/deployment/smoke.md](https://github.com/TimChr78/Agentic-Marketing/blob/main/docs/deployment/smoke.md). `/healthz` reports the running version.

## If something goes wrong

Go back to the previous `AM_VERSION`, and restore the backup taken before the upgrade with that version's image (a version refuses a backup from a newer schema than it knows, and the pre-upgrade backup has the old one):

```bash
docker compose stop app
# set AM_VERSION back to the previous version in .env
docker compose run --rm app am restore /backups/<backup> --yes
docker compose up -d
```

`docker compose run --rm --no-deps app am backup --list` lists the backups with their kind and the version their data comes from; the automatic one is named `am-pre-upgrade-<from>-to-<to>-<time>`. (In 0.2.4, every backup was named after the version that wrote it, so a pre-upgrade backup from 0.2.4 carries the new version's name: check its `migrationHead` in `manifest.json`.) With Helm, the chart has the same version as the image, and `helm upgrade` runs the migrations as a job before the new pods start.

## Skipping releases

Each release's upgrade block describes the step from the release just before it. When you skip releases, every block in between applies: all their migrations run (in order, at start-up), all their new variables exist, and all their manual steps are needed. Merge them with the new image:

```bash
docker run --rm ghcr.io/timchr78/agentic-marketing:<new version> am upgrade-notes <the version you run>
```

It prints the migrations, configuration, breaking changes and manual steps of every release in between, and the one-line upgrade of the newest. Releases before 0.2.4 have free-form notes, which it prints in full. `CHANGELOG.md` in the bundle has the same notes.

Compose bundles start with 0.2.4. To roll back to an older version, take its `docker-compose.yml` from the git tag, e.g. `https://raw.githubusercontent.com/TimChr78/Agentic-Marketing/v0.2.3/docker-compose.yml`.
