# Upgrading Agentic Marketing (Docker Compose)

This file ships in every release's Compose bundle (`agentic-marketing-compose-<version>.tar.gz`). What changes in a particular release is in that release's notes, under **Upgrading from the previous version**; this file is the procedure that stays the same.

## The rule

Never edit `docker-compose.yml`. Put everything specific to your site (tunnel networks, bind mounts, resource limits, the backup service) in `compose.override.yaml` next to it, starting from `compose.override.example.yaml`. Compose reads the override automatically, so an upgrade replaces `docker-compose.yml` and changes nothing else.

## Every upgrade

1. **Read the release notes' upgrade block.** It always has the same five lines:
   - **Migrations:** whether database migrations run at start-up (they only move forward);
   - **Configuration:** new, changed or removed variables, with their defaults;
   - **Breaking changes:** commands, inputs, outputs or artifact formats that change;
   - **Manual steps:** anything to do before or after, or "none";
   - **Upgrade:** the one-line upgrade.
2. **Back up.** `docker compose exec app am backup` writes a Postgres dump with a manifest to the `backups` volume (add `--clickhouse` for the event history). The app also takes a Postgres backup by itself before it migrates, unless `SKIP_PRE_UPGRADE_BACKUP=true`. See [docs/deployment/backups.md](docs/deployment/backups.md).
3. **Replace the release files.** Unpack the new bundle and copy its `docker-compose.yml` over yours. Keep your `.env` and `compose.override.yaml`.
4. **Compare your configuration.** `docker compose run --rm -v "$PWD/.env:/work/.env:ro" app am doctor --env-file /work/.env` lists variables that are new in this version and ones it no longer knows. Add new ones from the bundle's `.env.example` if you need to change their defaults.
5. **Upgrade.** Set `AM_VERSION=<version>` in `.env`, then:

   ```bash
   docker compose pull && docker compose up -d
   ```

6. **Check.** `docker compose exec app am doctor` checks the configuration, the services and your sending domains. From outside, `am smoke` checks the public host the way a visitor and an agent see it (admin paths hidden, forms, assets, MCP); see [docs/deployment/smoke.md](docs/deployment/smoke.md). `/healthz` reports the running version.

## If something goes wrong

Stop the app, restore the backup taken before the upgrade, and go back to the previous `AM_VERSION`:

```bash
docker compose stop app
docker compose run --rm app am restore /backups/<backup> --yes
# set AM_VERSION back to the previous version in .env
docker compose up -d
```

`am restore` refuses a backup made by a newer schema than the version you run, so restore before you start the older version, not after. Releases with Helm: the chart has the same version as the image, and `helm upgrade` runs the migrations as a job before the new pods start.
