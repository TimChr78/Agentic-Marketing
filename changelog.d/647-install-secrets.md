---
section: Fixed
issues: [647, 605, 646]
---
- A fresh Compose install no longer dies on a base64 database password: `.env.example` and the
  deployment docs generate `POSTGRES_PASSWORD` and `APP_DB_PASSWORD` as hex (`openssl rand -hex 32`,
  as `am init` already did), and an unparseable `DATABASE_URL` (Compose interpolates the password
  raw, so a `/` from base64 breaks it) now stops with `Configuration is incomplete: DATABASE_URL is
  not a valid URL` and the fix, instead of a raw `TypeError` stack trace (#647).
- The shared test stack publishes its ports on `127.0.0.1` by default instead of `0.0.0.0`:
  `scripts/test-services.sh` uses the Docker bridge address (`172.17.0.1`) when it runs inside a
  container, prints the bind address it used and warns loudly if `AM_TEST_BIND_IP=0.0.0.0` is set.
  The dev OpenBao (root token) and the writable test Postgres are no longer reachable from the LAN
  unless someone asks for it (#605).
- `pnpm e2e:visual` waits for the seeded server's fixtures `/ready` instead of `/healthz`, so the
  visual run no longer starts against a server whose seed is still running (#646).
