# Upgrading Agentic Marketing (Docker Compose)

This file ships in every release's Compose bundle (`agentic-marketing-compose-<version>.tar.gz`), next to `CHANGELOG.md`. What changes in a particular release is in that release's notes, under **Upgrading from** the previous release; this file is the procedure that stays the same. Skipping releases is fine: see [Skipping releases](#skipping-releases).

## The rule

Never edit `docker-compose.yml`. Put everything specific to your site (tunnel networks, bind mounts, resource limits, the backup service) in `compose.override.yaml` next to it, starting from `compose.override.example.yaml`. Compose reads the override automatically, so an upgrade replaces `docker-compose.yml` and changes nothing else.

## Every upgrade

1. **Read the release notes' upgrade block.** It always has the same five lines:
   - **Migrations:** whether database migrations run at start-up (they only move forward);
   - **Configuration:** new, changed or removed variables, with their defaults;
   - **Breaking changes:** commands, inputs, outputs or artifact formats that change;
   - **Manual steps:** anything to do before or after, or "none";
   - **Upgrade:** the one-line upgrade.
2. **Back up.** `docker compose exec app am backup` writes a Postgres dump with a manifest to the `backups` volume (add `--clickhouse` for the event history). The app also takes a Postgres backup by itself before it migrates, unless `SKIP_PRE_UPGRADE_BACKUP=true`. If the version you run is older than 0.2.4, it has no `am backup`: dump Postgres by hand with `docker compose exec -T postgres pg_dump -U am -Fc am > pre-upgrade.dump`. See [docs/deployment/backups.md](https://github.com/TimChr78/Agentic-Marketing/blob/main/docs/deployment/backups.md).
3. **Replace the release files and pull.** Unpack the new bundle and copy its `docker-compose.yml` over yours; keep your `.env` and `compose.override.yaml`. Set `AM_VERSION=<version>` in `.env`, then `docker compose pull`. Nothing restarts yet.
4. **Compare your configuration** with the new image: `docker compose run --rm --no-deps -v "$PWD/.env:/work/.env:ro" app am doctor --env-file /work/.env` lists variables that are new in this version and ones it no longer knows. Add new ones from the bundle's `.env.example` if you need other than their defaults.
5. **Upgrade.** `docker compose up -d` starts the new version; it backs up and migrates before it serves.
6. **Check.** `docker compose exec app am doctor` checks the configuration, the services and your sending domains. From outside, `am smoke` checks the public host the way a visitor and an agent see it (admin paths hidden, forms, assets, MCP); see [docs/deployment/smoke.md](https://github.com/TimChr78/Agentic-Marketing/blob/main/docs/deployment/smoke.md). `/healthz` reports the running version.

## If something goes wrong

Go back to the previous `AM_VERSION`, and restore the backup taken before the upgrade with that version's image (a version refuses a backup from a newer schema than it knows, and the pre-upgrade backup has the old one):

```bash
docker compose stop app
# set AM_VERSION back to the previous version in .env
docker compose run --rm app am restore /backups/<backup> --yes
docker compose up -d
```

`docker compose exec app ls /backups` lists the backups; the pre-upgrade one is named after the version it was taken from. With Helm, the chart has the same version as the image, and `helm upgrade` runs the migrations as a job before the new pods start.

## Skipping releases

Each release's upgrade block describes the step from the release just before it. When you skip releases, every block in between applies: all their migrations run (in order, at start-up), all their new variables exist, and all their manual steps are needed. Merge them with the new image:

```bash
docker run --rm ghcr.io/timchr78/agentic-marketing:<new version> am upgrade-notes <the version you run>
```

It prints the migrations, configuration, breaking changes and manual steps of every release in between, and the one-line upgrade of the newest. Releases before 0.2.4 have free-form notes, which it prints in full. `CHANGELOG.md` in the bundle has the same notes.

Compose bundles start with 0.2.4. To roll back to an older version, take its `docker-compose.yml` from the git tag, e.g. `https://raw.githubusercontent.com/TimChr78/Agentic-Marketing/v0.2.3/docker-compose.yml`.
